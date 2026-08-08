import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { createExpense } from "./expenses";
import {
  calculatePeriodMinuteRate,
  lockMinuteRatePeriod,
  readCostPool,
  MinuteRateError,
} from "./minute-rate";

/** The minute rate, computed from real postings in a real database. */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let factoryId: string;
let periodId: string;
let periodStart: Date;
let rentCategoryId: string;
let materialsCategoryId: string;
let financeCategoryId: string;

const ctx = { userId: null as string | null, reason: null };

beforeAll(async () => {
  factoryId = (await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } })).id;

  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" }, orderBy: { startDate: "asc" },
  });
  periodId = period.id;
  periodStart = new Date(period.startDate);

  const cat = async (code: string) =>
    (await db.costCategory.findFirstOrThrow({ where: { code, entityId: factoryId } })).id;

  rentCategoryId = await cat("FAC-RENT");
  materialsCategoryId = await cat("FAC-MATERIALS");
  financeCategoryId = await cat("FAC-FINANCE");
});

async function wipe() {
  await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
  await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
  try {
    await db.minuteRateComponent.deleteMany({});
    await db.minuteRatePeriod.deleteMany({});
    await db.journalLine.deleteMany({});
    await db.journalEntry.deleteMany({});
    await db.expensePayment.deleteMany({});
    await db.expense.deleteMany({});
    await db.auditLog.deleteMany({});
    await db.documentSequence.deleteMany({});
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
  }
}

beforeEach(wipe);
afterAll(async () => { await wipe(); await db.$disconnect(); });

async function expense(categoryId: string, amount: number, description: string) {
  return createExpense(
    {
      entityId: factoryId,
      costCategoryId: categoryId,
      description,
      amount,
      incurredDate: periodStart,
      dueDate: periodStart,
    },
    ctx,
  );
}

/** Match the seeded capacity to the documented worked example. */
async function setCapacity(over: Partial<{ utilisationRate: string; efficiencyRate: string }> = {}) {
  const existing = await db.capacityConfig.findFirst({
    where: { entityId: factoryId, fiscalPeriodId: periodId, lineId: null },
  });
  const data = {
    operators: 40,
    workingDays: "26",
    hoursPerDay: "8",
    utilisationRate: over.utilisationRate ?? "0.60",
    efficiencyRate: over.efficiencyRate ?? "0.80",
  };
  if (existing) {
    await db.capacityConfig.update({ where: { id: existing.id }, data });
  } else {
    await db.capacityConfig.create({
      data: { ...data, entityId: factoryId, fiscalPeriodId: periodId },
    });
  }
}

describe("cost pool comes from the ledger", () => {
  it("includes only accounts flagged for the minute rate", async () => {
    await expense(rentCategoryId, 55000, "Factory rent");
    await expense(materialsCategoryId, 300000, "Fabric purchase");
    await expense(financeCategoryId, 12000, "Bank interest");

    const pool = await readCostPool(factoryId, periodId);

    // Only rent qualifies. Fabric is costed into styles directly, and finance
    // cost is not a conversion cost — including either would overstate every
    // garment.
    expect(pool.total).toBe("55000");
    expect(pool.components.map((c) => c.accountCode)).toEqual(["6120"]);
  });

  it("sums several conversion accounts and breaks them down", async () => {
    const labour = (await db.costCategory.findFirstOrThrow({
      where: { code: "FAC-DIRECT-LABOUR", entityId: factoryId },
    })).id;
    const utilities = (await db.costCategory.findFirstOrThrow({
      where: { code: "FAC-UTILITIES", entityId: factoryId },
    })).id;

    await expense(labour, 268000, "Payroll");
    await expense(rentCategoryId, 55000, "Rent");
    await expense(utilities, 34000, "Electricity");

    const pool = await readCostPool(factoryId, periodId);
    expect(pool.total).toBe("357000");
    expect(pool.components).toHaveLength(3);
    expect(pool.components.find((c) => c.accountCode === "6110")!.amount).toBe("268000");
  });

  it("nets off a reversal rather than leaving the pool overstated", async () => {
    await expense(rentCategoryId, 55000, "Rent");
    const poolBefore = await readCostPool(factoryId, periodId);
    expect(poolBefore.total).toBe("55000");

    // Reverse it the way a correction would.
    const entry = await db.journalEntry.findFirstOrThrow({ where: { sourceType: "EXPENSE" } });
    const lines = await db.journalLine.findMany({ where: { journalEntryId: entry.id } });
    await db.journalEntry.create({
      data: {
        entryNumber: "JE-REV-TEST", entityId: factoryId, fiscalPeriodId: periodId,
        status: "POSTED", postingDate: periodStart, sourceType: "ADJUSTMENT",
        lines: {
          create: lines.map((l, i) => ({
            lineNumber: i + 1, accountId: l.accountId,
            debit: l.credit, credit: l.debit, entityId: l.entityId,
          })),
        },
      },
    });

    const poolAfter = await readCostPool(factoryId, periodId);
    expect(poolAfter.total).toBe("0");
  });

  it("ignores drafts, which are not accounting facts yet", async () => {
    await expense(rentCategoryId, 55000, "Rent");
    const entry = await db.journalEntry.findFirstOrThrow({ where: { sourceType: "EXPENSE" } });
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
    await db.journalEntry.update({ where: { id: entry.id }, data: { status: "DRAFT" } });
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);

    expect((await readCostPool(factoryId, periodId)).total).toBe("0");
  });
});

describe("calculating the period rate", () => {
  it("reproduces the documented worked example from real postings", async () => {
    await setCapacity();
    await expense(rentCategoryId, 568000, "Full conversion pool");

    const result = await calculatePeriodMinuteRate(
      { entityId: factoryId, fiscalPeriodId: periodId },
      ctx,
    );

    const period = await db.minuteRatePeriod.findUniqueOrThrow({
      where: { id: result.minuteRatePeriodId },
    });

    expect(period.grossAvailableMinutes.toString()).toBe("499200");
    expect(period.productiveMinutes.toString()).toBe("239616");
    expect(Number(period.actualMinuteRate).toFixed(4)).toBe("2.3705");
    expect(Number(period.fullCapacityMinuteRate).toFixed(4)).toBe("1.1378");
    expect(Number(period.idlePenaltyPerMinute).toFixed(4)).toBe("1.2326");
    expect(period.status).toBe("PROVISIONAL");
  });

  it("stores a component per account for the drill-down", async () => {
    await setCapacity();
    await expense(rentCategoryId, 55000, "Rent");
    const labour = (await db.costCategory.findFirstOrThrow({
      where: { code: "FAC-DIRECT-LABOUR", entityId: factoryId },
    })).id;
    await expense(labour, 268000, "Payroll");

    const result = await calculatePeriodMinuteRate(
      { entityId: factoryId, fiscalPeriodId: periodId },
      ctx,
    );

    const components = await db.minuteRateComponent.findMany({
      where: { minuteRatePeriodId: result.minuteRatePeriodId },
      orderBy: { costCategoryCode: "asc" },
    });
    expect(components.map((c) => c.costCategoryCode)).toEqual(["6110", "6120"]);
    // The components must add up to the stored pool, or the drill-down lies.
    const sum = components.reduce((s, c) => s + Number(c.amount), 0);
    const period = await db.minuteRatePeriod.findUniqueOrThrow({
      where: { id: result.minuteRatePeriodId },
    });
    expect(sum).toBe(Number(period.totalConversionCost));
  });

  it("credits CMT revenue against the pool, lowering the brand's rate", async () => {
    await setCapacity();
    await expense(rentCategoryId, 568000, "Conversion pool");

    const without = await calculatePeriodMinuteRate(
      { entityId: factoryId, fiscalPeriodId: periodId }, ctx,
    );
    const rateWithout = Number(without.actualMinuteRate);

    const withCmt = await calculatePeriodMinuteRate(
      { entityId: factoryId, fiscalPeriodId: periodId, cmtRevenueCredit: "100000" }, ctx,
    );
    expect(Number(withCmt.actualMinuteRate)).toBeLessThan(rateWithout);

    const period = await db.minuteRatePeriod.findUniqueOrThrow({
      where: { id: withCmt.minuteRatePeriodId },
    });
    // Gross pool and credit stay visible alongside the net.
    expect(period.totalConversionCost.toString()).toBe("568000");
    expect(period.cmtRevenueCredit.toString()).toBe("100000");
    expect(period.netCostPool.toString()).toBe("468000");
  });

  it("replaces components on recalculation instead of accumulating them", async () => {
    await setCapacity();
    await expense(rentCategoryId, 55000, "Rent");

    const first = await calculatePeriodMinuteRate(
      { entityId: factoryId, fiscalPeriodId: periodId }, ctx,
    );
    await calculatePeriodMinuteRate({ entityId: factoryId, fiscalPeriodId: periodId }, ctx);

    const components = await db.minuteRateComponent.findMany({
      where: { minuteRatePeriodId: first.minuteRatePeriodId },
    });
    expect(components).toHaveLength(1);
  });

  it("refuses when no capacity configuration exists", async () => {
    await db.capacityConfig.deleteMany({
      where: { entityId: factoryId, fiscalPeriodId: periodId, lineId: null },
    });
    await expense(rentCategoryId, 55000, "Rent");

    await expect(
      calculatePeriodMinuteRate({ entityId: factoryId, fiscalPeriodId: periodId }, ctx),
    ).rejects.toThrow(/capacity configuration/i);
  });

  it("reports a zero rate rather than Infinity when nothing is productive", async () => {
    await setCapacity({ utilisationRate: "0" });
    await expense(rentCategoryId, 55000, "Rent");

    const result = await calculatePeriodMinuteRate(
      { entityId: factoryId, fiscalPeriodId: periodId }, ctx,
    );
    expect(result.actualMinuteRate).toBeNull();

    const period = await db.minuteRatePeriod.findUniqueOrThrow({
      where: { id: result.minuteRatePeriodId },
    });
    expect(Number(period.actualMinuteRate)).toBe(0);
    expect(Number.isFinite(Number(period.actualMinuteRate))).toBe(true);
  });
});

describe("locking", () => {
  it("refuses to recalculate a locked period", async () => {
    await setCapacity();
    await expense(rentCategoryId, 568000, "Conversion pool");

    const result = await calculatePeriodMinuteRate(
      { entityId: factoryId, fiscalPeriodId: periodId }, ctx,
    );
    await lockMinuteRatePeriod(result.minuteRatePeriodId, ctx);

    // Costs arriving later must not rewrite a rate production already used.
    await expense(rentCategoryId, 99000, "Late invoice");
    await expect(
      calculatePeriodMinuteRate({ entityId: factoryId, fiscalPeriodId: periodId }, ctx),
    ).rejects.toThrow(MinuteRateError);
  });

  it("keeps the locked rate exactly as it was", async () => {
    await setCapacity();
    await expense(rentCategoryId, 568000, "Conversion pool");

    const result = await calculatePeriodMinuteRate(
      { entityId: factoryId, fiscalPeriodId: periodId }, ctx,
    );
    const before = await db.minuteRatePeriod.findUniqueOrThrow({
      where: { id: result.minuteRatePeriodId },
    });

    await lockMinuteRatePeriod(result.minuteRatePeriodId, ctx);

    const after = await db.minuteRatePeriod.findUniqueOrThrow({
      where: { id: result.minuteRatePeriodId },
    });
    expect(after.actualMinuteRate.toString()).toBe(before.actualMinuteRate.toString());
    expect(after.status).toBe("LOCKED");
    expect(after.lockedAt).not.toBeNull();
  });

  it("records the lock in the audit trail", async () => {
    await setCapacity();
    await expense(rentCategoryId, 568000, "Pool");
    const result = await calculatePeriodMinuteRate(
      { entityId: factoryId, fiscalPeriodId: periodId }, ctx,
    );
    await lockMinuteRatePeriod(result.minuteRatePeriodId, ctx);

    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityName: "MinuteRatePeriod", action: "MINUTE_RATE_LOCKED" },
    });
    expect(audit.after).toMatchObject({ status: "LOCKED" });
  });

  it("refuses to lock twice", async () => {
    await setCapacity();
    await expense(rentCategoryId, 568000, "Pool");
    const result = await calculatePeriodMinuteRate(
      { entityId: factoryId, fiscalPeriodId: periodId }, ctx,
    );
    await lockMinuteRatePeriod(result.minuteRatePeriodId, ctx);
    await expect(lockMinuteRatePeriod(result.minuteRatePeriodId, ctx)).rejects.toThrow(
      /already locked/i,
    );
  });
});
