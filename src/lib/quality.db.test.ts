import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { recordInspection, recordRework, qualityReport, QualityError } from "./quality";
import { receiveMaterial } from "./inventory";
import { dec } from "./money";

/**
 * What the inspection found and what putting it right cost.
 *
 * Rework is the most expensive thing a factory does not measure: the minutes
 * are paid twice and earn once. Leaving it inside ordinary conversion cost
 * hides it in the minute rate, where it quietly raises the price of every
 * garment instead of pointing at the run that caused it.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const MINUTE_RATE = 1.5078;

let factoryId: string;
let styleId: string;
let orderId: string;
let lineId: string;
let ownerId: string;
let materialId: string;
let storeId: string;
let day: Date;

beforeAll(async () => {
  factoryId = (await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } })).id;
  styleId = (await db.style.findFirstOrThrow({ orderBy: { code: "asc" } })).id;
  lineId = (await db.productionLine.findFirstOrThrow({ where: { isActive: true } })).id;
  ownerId = (await db.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  materialId = (await db.material.findFirstOrThrow({ where: { type: "TRIM" } })).id;
  storeId = (await db.location.findFirstOrThrow({ where: { code: "LOC-FAC" } })).id;

  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" },
    orderBy: { startDate: "asc" },
  });
  day = new Date(period.startDate);

  // Rework is costed at the rate in force on the day, so the period needs one.
  await db.minuteRatePeriod.upsert({
    where: { entityId_fiscalPeriodId: { entityId: factoryId, fiscalPeriodId: period.id } },
    update: { actualMinuteRate: String(MINUTE_RATE) },
    create: {
      entityId: factoryId, fiscalPeriodId: period.id,
      operators: 40, workingDays: "26", hoursPerDay: "9",
      utilisationRate: "0.85", efficiencyRate: "0.75",
      totalConversionCost: "364000", netCostPool: "364000",
      grossAvailableMinutes: "561600", productiveMinutes: "358020",
      actualMinuteRate: String(MINUTE_RATE), fullCapacityMinuteRate: "0.6481",
      idlePenaltyPerMinute: "0.8597", idleMinutes: "203580",
    },
  });
});

async function wipe() {
  await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
  await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
  try {
    await db.qCRecord.deleteMany({});
    await db.reworkRecord.deleteMany({});
    await db.productionOrder.deleteMany({});
    await db.inventoryMovement.deleteMany({});
    await db.inventoryLot.deleteMany({});
    await db.journalLine.deleteMany({});
    await db.journalEntry.deleteMany({});
    await db.auditLog.deleteMany({});
    await db.documentSequence.deleteMany({});
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
  }
}

beforeEach(async () => {
  await wipe();
  const order = await db.productionOrder.create({
    data: {
      orderNumber: `PO-QC-${Math.random().toString(36).slice(2, 10)}`,
      styleId, status: "COMPLETED",
      plannedQty: 100, actualQty: 100, orderDate: day,
    },
  });
  orderId = order.id;
});

afterAll(async () => {
  await wipe();
  await db.$disconnect();
});

const inspect = (over: Partial<Parameters<typeof recordInspection>[0]> = {}) =>
  recordInspection(
    {
      productionOrderId: orderId,
      stage: "QC",
      inspectionDate: day,
      inspectedQty: 100,
      passedQty: 90,
      reworkQty: 8,
      rejectedQty: 2,
      ...over,
    },
    { userId: ownerId, reason: null },
  );

const rework = (over: Partial<Parameters<typeof recordRework>[0]> = {}) =>
  recordRework(
    {
      productionOrderId: orderId,
      entityId: factoryId,
      lineId,
      type: "RESEWING",
      quantity: 8,
      minutesPerUnit: 12,
      reworkDate: day,
      ...over,
    },
    { userId: ownerId, reason: null },
  );

const balanceOf = async (code: string) => {
  const rows = await db.$queryRaw<{ total: string }[]>`
    SELECT COALESCE(SUM(l."debit") - SUM(l."credit"), 0)::text AS total
    FROM "journal_lines" l
    JOIN "journal_entries" e ON e."id" = l."journalEntryId"
    JOIN "accounts" a ON a."id" = l."accountId"
    WHERE a."code" = ${code} AND e."status" = 'POSTED'
  `;
  return dec(rows[0]?.total ?? 0);
};

describe("what the inspection found", () => {
  it("works out the defect rate rather than taking one", async () => {
    const result = await inspect({ inspectedQty: 100, passedQty: 90, reworkQty: 8, rejectedQty: 2 });

    // Ten of a hundred were not right first time.
    expect(Number(result.defectRate)).toBeCloseTo(0.1, 6);
    expect(result.defective).toBe(10);
  });

  it("counts a rejection as a defect, not just rework", async () => {
    const result = await inspect({ inspectedQty: 50, passedQty: 45, reworkQty: 0, rejectedQty: 5 });
    expect(Number(result.defectRate)).toBeCloseTo(0.1, 6);
  });

  it("refuses an inspection whose numbers do not add up", async () => {
    // Every garment inspected ends up in exactly one bucket. If they do not
    // sum, the defect rate is measuring an arithmetic slip.
    await expect(
      inspect({ inspectedQty: 100, passedQty: 90, reworkQty: 8, rejectedQty: 0 }),
    ).rejects.toThrow(/add up/i);
  });

  it("refuses an inspection of nothing", async () => {
    await expect(
      inspect({ inspectedQty: 0, passedQty: 0, reworkQty: 0, rejectedQty: 0 }),
    ).rejects.toThrow();
  });

  it("posts no journal, because nothing has been spent yet", async () => {
    await inspect();
    expect(await db.journalEntry.count()).toBe(0);
  });
});

describe("what putting it right cost", () => {
  it("costs the minutes at the rate in force, not at anything typed", async () => {
    const result = await rework({ quantity: 8, minutesPerUnit: 12 });

    expect(Number(result.totalMinutes)).toBe(96);
    expect(Number(result.minuteRate)).toBeCloseTo(MINUTE_RATE, 8);
    // 96 × 1.5078
    expect(Number(result.labourCost)).toBeCloseTo(144.75, 2);
  });

  it("charges it to 5500 so it never hides inside the minute rate", async () => {
    await rework({ quantity: 8, minutesPerUnit: 12 });

    // Rework left inside ordinary conversion cost raises the price of every
    // garment the factory makes instead of naming the run that caused it.
    expect(Number(await balanceOf("5500"))).toBeCloseTo(144.75, 2);
  });

  it("reclassifies the minutes out of sewing labour rather than inventing an expense", async () => {
    await rework({ quantity: 8, minutesPerUnit: 12 });

    // The wages were already counted once, when they were paid. What changes
    // is which account carries them, so total cost is untouched.
    expect(Number(await balanceOf("6110"))).toBeCloseTo(-144.75, 2);
  });

  it("never credits an inventory account for labour", async () => {
    await rework({ quantity: 8, minutesPerUnit: 12 });

    // Crediting work in progress, which this first did, credits an inventory
    // account against stock that was never there and puts the ledger out of
    // step with the lots. The books audit caught it by 728.97.
    expect(Number(await balanceOf("1320"))).toBe(0);
  });

  it("consumes real material at FIFO cost rather than taking a typed figure", async () => {
    await receiveMaterial(
      {
        materialId, locationId: storeId, entityId: factoryId,
        quantity: "100", unitCost: "5", receivedDate: day,
      },
      { userId: ownerId, reason: null },
    );

    const result = await rework({
      quantity: 8,
      minutesPerUnit: 12,
      material: { materialId, locationId: storeId, quantity: 11 },
    });

    // 11 × 5 = 55, and the stock is genuinely 11 lighter.
    expect(Number(result.materialCost)).toBe(55);
    expect(Number(result.totalCost)).toBeCloseTo(199.75, 2);
    expect(Number(await balanceOf("5500"))).toBeCloseTo(199.75, 2);

    const left = await db.inventoryLot.aggregate({
      where: { materialId, locationId: storeId },
      _sum: { remainingQty: true },
    });
    expect(Number(left._sum.remainingQty)).toBe(89);
  });

  it("refuses material that is not on the shelf", async () => {
    await expect(
      rework({
        quantity: 8, minutesPerUnit: 12,
        material: { materialId, locationId: storeId, quantity: 5 },
      }),
    ).rejects.toThrow(/not enough/i);
  });

  it("freezes the rate onto the record", async () => {
    await rework();

    const record = await db.reworkRecord.findFirstOrThrow();
    // A rate revised next quarter must not restate what last quarter's
    // mistakes cost.
    expect(Number(record.minuteRate)).toBeCloseTo(MINUTE_RATE, 8);
  });

  it("refuses to cost rework in a period with no minute rate", async () => {
    // Falling back to the newest rate would price old rework at a number that
    // did not exist when it happened.
    const old = new Date(Date.UTC(2019, 0, 15));
    await expect(rework({ reworkDate: old })).rejects.toThrow(QualityError);
  });

  it("records nothing when it refuses", async () => {
    const old = new Date(Date.UTC(2019, 0, 15));
    await expect(rework({ reworkDate: old })).rejects.toThrow();

    expect(await db.reworkRecord.count()).toBe(0);
    expect(await db.journalEntry.count()).toBe(0);
  });
});

describe("the report", () => {
  it("puts the defect rate next to what the fixing cost", async () => {
    await inspect({ inspectedQty: 100, passedQty: 90, reworkQty: 8, rejectedQty: 2 });
    await rework({ quantity: 8, minutesPerUnit: 12 });

    const report = await qualityReport();
    const run = report.runs.find((r) => r.orderId === orderId)!;

    expect(Number(run.defectRate)).toBeCloseTo(0.1, 6);
    expect(Number(run.cost)).toBeCloseTo(144.75, 2);
    // A 3% defect rate on a style that takes forty minutes to fix is worse
    // than 8% on one that takes four, and a rate alone cannot say so.
    expect(Number(run.costPerReworked)).toBeCloseTo(18.09, 2);
  });

  it("shows what was found but not yet put right", async () => {
    await inspect({ inspectedQty: 100, passedQty: 90, reworkQty: 8, rejectedQty: 2 });
    await rework({ quantity: 3, minutesPerUnit: 12 });

    const report = await qualityReport();
    const run = report.runs.find((r) => r.orderId === orderId)!;

    // Five garments were sent back and have not come through. Not wrong on
    // its own; a gap that never closes means they were quietly passed.
    expect(run.outstanding).toBe(5);
  });

  it("groups the cost by what kind of fixing it was", async () => {
    await rework({ type: "RESEWING", quantity: 8, minutesPerUnit: 12 });
    await rework({ type: "REPRESSING", quantity: 20, minutesPerUnit: 2 });

    const report = await qualityReport();

    expect(report.byType).toHaveLength(2);
    // Sorted by cost: resewing 96 minutes beats repressing's 40.
    expect(report.byType[0].type).toBe("RESEWING");
  });

  it("splits the labour from the material in the totals", async () => {
    await receiveMaterial(
      {
        materialId, locationId: storeId, entityId: factoryId,
        quantity: "100", unitCost: "5", receivedDate: day,
      },
      { userId: ownerId, reason: null },
    );
    await rework({
      quantity: 8, minutesPerUnit: 12,
      material: { materialId, locationId: storeId, quantity: 11 },
    });

    const report = await qualityReport();
    expect(Number(report.totals.labourCost)).toBeCloseTo(144.75, 2);
    expect(Number(report.totals.materialCost)).toBe(55);
    expect(Number(report.totals.cost)).toBeCloseTo(199.75, 2);
  });

  it("is empty and does not fall over when nothing has happened", async () => {
    const report = await qualityReport();
    expect(report.runs).toHaveLength(0);
    expect(report.totals.defectRate).toBeNull();
  });
});

describe("the alert that could never fire", () => {
  it("now has records to fire on", async () => {
    await rework({ quantity: 8, minutesPerUnit: 12 });

    // The rework-rate alert reads productionOrder.reworkRecords and nothing
    // ever wrote one, so it could not have raised an alert in any
    // circumstances.
    const order = await db.productionOrder.findUniqueOrThrow({
      where: { id: orderId },
      include: { reworkRecords: true },
    });

    expect(order.reworkRecords).toHaveLength(1);
    const reworked = order.reworkRecords.reduce((s, r) => s + r.quantity, 0);
    expect(reworked / (order.actualQty ?? 1)).toBeCloseTo(0.08, 6);
  });
});
