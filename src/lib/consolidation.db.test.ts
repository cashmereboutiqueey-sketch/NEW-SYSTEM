import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { createExpense } from "./expenses";
import { calculatePeriodMinuteRate } from "./minute-rate";
import { createCostSnapshot } from "./costing";
import { receiveFinishedGoods } from "./inventory";
import { transferToBrand, IntercompanyError } from "./intercompany";
import { createSale } from "./sales";
import { groupProfitAndLoss } from "./consolidation";
import { dec } from "./money";

/**
 * The full intercompany cycle against a real database: the Factory makes
 * garments, invoices the Brand, the Brand sells some, and the group view
 * removes the profit the group charged itself on the rest.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let factoryId: string;
let brandId: string;
let factoryLocId: string;
let brandLocId: string;
let styleId: string;
let variantId: string;
let channelId: string;
let periodId: string;
let day: Date;
let snapshotId: string;
let factoryCost: string;
let transferPrice: string;

const RETAIL = 1500;
const ctx = { userId: null as string | null, reason: null };

beforeAll(async () => {
  factoryId = (await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } })).id;
  brandId = (await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } })).id;
  factoryLocId = (await db.location.findFirstOrThrow({ where: { code: "LOC-FAC" } })).id;
  brandLocId = (await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } })).id;
  channelId = (await db.salesChannel.findFirstOrThrow()).id;

  const style = await db.style.findFirstOrThrow({
    where: { operations: { some: {} }, bomLines: { some: {} } },
    include: { variants: true },
  });
  styleId = style.id;
  variantId = style.variants[0].id;

  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" }, orderBy: { startDate: "asc" },
  });
  periodId = period.id;
  day = new Date(period.startDate);
});

async function wipe() {
  await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
  await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
  try {
    await db.salesPayment.deleteMany({});
    await db.salesOrderLine.deleteMany({});
    await db.salesOrder.deleteMany({});
    await db.inventoryMovement.deleteMany({});
    await db.inventoryLot.deleteMany({});
    await db.costSnapshotLine.deleteMany({});
    await db.costSnapshot.deleteMany({});
    await db.minuteRateComponent.deleteMany({});
    await db.minuteRatePeriod.deleteMany({});
    await db.journalLine.deleteMany({});
    await db.journalEntry.deleteMany({});
    await db.expense.deleteMany({});
    await db.auditLog.deleteMany({});
    await db.documentSequence.deleteMany({});
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
  }
}

/** A minute rate, a frozen costing, and finished stock in the factory. */
async function givenFactoryStock(quantity: number) {
  const cat = await db.costCategory.findFirstOrThrow({
    where: { code: "FAC-RENT", entityId: factoryId },
  });
  await createExpense(
    {
      entityId: factoryId, costCategoryId: cat.id, description: "Conversion pool",
      amount: 568000, incurredDate: day, dueDate: day,
    },
    ctx,
  );
  const rate = await calculatePeriodMinuteRate(
    { entityId: factoryId, fiscalPeriodId: periodId }, ctx,
  );

  const snap = await createCostSnapshot(
    { styleId, minuteRatePeriodId: rate.minuteRatePeriodId }, ctx,
  );
  snapshotId = snap.costSnapshotId;

  const stored = await db.costSnapshot.findUniqueOrThrow({ where: { id: snapshotId } });
  factoryCost = stored.factoryTotalCost.toString();
  transferPrice = stored.transferPrice.toString();

  await receiveFinishedGoods(
    {
      variantId, locationId: factoryLocId, entityId: factoryId,
      quantity: String(quantity),
      unitCost: factoryCost,
      materialUnitCost: stored.materialCost.toString(),
      receivedDate: day,
    },
    ctx,
  );
}

beforeEach(wipe);
afterAll(async () => { await wipe(); await db.$disconnect(); });

async function accountBalance(code: string, entityId?: string): Promise<number> {
  const [row] = await db.$queryRaw<{ balance: string }[]>`
    SELECT COALESCE(SUM(l."debit") - SUM(l."credit"), 0)::text AS balance
    FROM "journal_lines" l
    JOIN "journal_entries" e ON e."id" = l."journalEntryId"
    JOIN "accounts" a ON a."id" = l."accountId"
    WHERE a."code" = ${code} AND e."status" = 'POSTED'
      AND (${entityId ?? null}::text IS NULL OR l."entityId" = ${entityId ?? null})
  `;
  return Number(row.balance);
}

describe("the transfer itself", () => {
  it("invoices the Brand and moves the stock at transfer price", async () => {
    await givenFactoryStock(1000);
    const t = await transferToBrand(
      {
        variantId, quantity: "1000",
        fromLocationId: factoryLocId, toLocationId: brandLocId,
        transferDate: day, costSnapshotId: snapshotId,
      },
      ctx,
    );

    expect(Number(t.marginPerUnit)).toBeCloseTo(
      Number(transferPrice) - Number(factoryCost), 4,
    );

    // Factory: receivable and internal revenue.
    expect(await accountBalance("1250", factoryId)).toBeCloseTo(Number(t.transferPrice), 2);
    expect(await accountBalance("4400", factoryId)).toBeCloseTo(-Number(t.transferPrice), 2);
    // Brand: stock in, payable out.
    expect(await accountBalance("1340", brandId)).toBeCloseTo(Number(t.transferPrice), 2);
    expect(await accountBalance("2150", brandId)).toBeCloseTo(-Number(t.transferPrice), 2);

    // The factory shelf is empty; the brand shelf holds the goods.
    const factoryLots = await db.inventoryLot.findMany({ where: { entityId: factoryId } });
    expect(factoryLots.every((l) => Number(l.remainingQty) === 0)).toBe(true);
  });

  it("records the embedded margin on the Brand's lot", async () => {
    await givenFactoryStock(1000);
    await transferToBrand(
      {
        variantId, quantity: "1000", fromLocationId: factoryLocId,
        toLocationId: brandLocId, transferDate: day, costSnapshotId: snapshotId,
      },
      ctx,
    );

    const lot = await db.inventoryLot.findFirstOrThrow({
      where: { entityId: brandId, state: "FINISHED_GOODS" },
    });
    expect(lot.transferMarginPerUnit).not.toBeNull();
    expect(lot.sourceCostSnapshotId).toBe(snapshotId);
    expect(lot.unitCost.toString()).toBe(transferPrice);
  });

  it("refuses to transfer stock the factory does not hold", async () => {
    await givenFactoryStock(10);
    await expect(
      transferToBrand(
        {
          variantId, quantity: "100", fromLocationId: factoryLocId,
          toLocationId: brandLocId, transferDate: day, costSnapshotId: snapshotId,
        },
        ctx,
      ),
    ).rejects.toThrow(IntercompanyError);
  });
});

describe("the specification's 1,000 made / 400 sold example", () => {
  async function runCycle() {
    await givenFactoryStock(1000);
    await transferToBrand(
      {
        variantId, quantity: "1000", fromLocationId: factoryLocId,
        toLocationId: brandLocId, transferDate: day, costSnapshotId: snapshotId,
      },
      ctx,
    );
    await createSale(
      {
        source: "SHOPIFY", channelId, entityId: brandId, locationId: brandLocId,
        orderDate: day, externalId: "grp-1",
        lines: [{ variantId, quantity: 400, retailPrice: RETAIL, discountPct: 0 }],
        payments: [],
      },
      ctx,
    );
  }

  it("defers the margin on the 600 units still in stock", async () => {
    await runCycle();
    const g = await groupProfitAndLoss(periodId);

    const marginPerUnit = dec(transferPrice).minus(dec(factoryCost));
    expect(Number(g.closingUnrealised)).toBeCloseTo(Number(marginPerUnit.times(600)), 2);
  });

  it("reports group profit as what the group earned from outside", async () => {
    await runCycle();
    const g = await groupProfitAndLoss(periodId);

    // 400 sold at retail, costing the factory its own cost to make. The
    // conversion pool posted earlier is a real operating expense of the
    // period, so it is subtracted too.
    const expected = dec(RETAIL * 400)
      .minus(dec(factoryCost).times(400))
      .minus(dec(g.groupOperatingExpenses));

    expect(Number(g.groupProfit)).toBeCloseTo(Number(expected), 1);
  });

  it("is lower than the naive sum of the two entities", async () => {
    await runCycle();
    const g = await groupProfitAndLoss(periodId);

    // The gap is exactly the deferred margin — the illusion of profit from
    // producing into stock.
    expect(Number(g.combinedProfit)).toBeGreaterThan(Number(g.groupProfit));
    expect(Number(g.combinedProfit) - Number(g.groupProfit)).toBeCloseTo(
      Number(g.closingUnrealised), 2,
    );
  });

  it("counts no internal invoicing as group revenue", async () => {
    await runCycle();
    const g = await groupProfitAndLoss(periodId);

    expect(Number(g.groupExternalRevenue)).toBeCloseTo(RETAIL * 400, 2);
    expect(Number(g.intercompanyRevenueEliminated)).toBeGreaterThan(0);
  });

  it("reconciles the two sides of the intercompany balance", async () => {
    await runCycle();
    const g = await groupProfitAndLoss(periodId);
    expect(g.intercompany.matched).toBe(true);
    expect(Number(g.intercompany.difference)).toBe(0);
  });

  it("lists the deferred margin lot by lot for the drill-down", async () => {
    await runCycle();
    const g = await groupProfitAndLoss(periodId);

    expect(g.unrealisedByLot).toHaveLength(1);
    expect(g.unrealisedByLot[0].remainingQty).toBe("600");
    expect(Number(g.unrealisedByLot[0].deferred)).toBeCloseTo(
      Number(g.closingUnrealised), 2,
    );
  });
});

describe("producing into stock", () => {
  it("does not make the group look profitable when nothing has sold", async () => {
    await givenFactoryStock(1000);
    await transferToBrand(
      {
        variantId, quantity: "1000", fromLocationId: factoryLocId,
        toLocationId: brandLocId, transferDate: day, costSnapshotId: snapshotId,
      },
      ctx,
    );

    const g = await groupProfitAndLoss(periodId);

    // The factory shows a healthy margin; the group shows only the cost of
    // running the month, because not one garment has left the group.
    expect(Number(g.factory.intercompanyRevenue)).toBeGreaterThan(0);
    expect(Number(g.groupExternalRevenue)).toBe(0);
    expect(Number(g.groupProfit)).toBeCloseTo(-Number(g.groupOperatingExpenses), 1);
  });
});

describe("ledger integrity", () => {
  it("keeps both sets of books balanced through the transfer", async () => {
    await givenFactoryStock(1000);
    await transferToBrand(
      {
        variantId, quantity: "1000", fromLocationId: factoryLocId,
        toLocationId: brandLocId, transferDate: day, costSnapshotId: snapshotId,
      },
      ctx,
    );

    const [row] = await db.$queryRaw<{ debit: string; credit: string }[]>`
      SELECT COALESCE(SUM(l."debit"), 0)::text AS debit,
             COALESCE(SUM(l."credit"), 0)::text AS credit
      FROM "journal_lines" l
      JOIN "journal_entries" e ON e."id" = l."journalEntryId"
      WHERE e."status" = 'POSTED'
    `;
    expect(row.debit).toBe(row.credit);
  });

  it("posts no elimination entries into either entity's books", async () => {
    // Consolidation is a view. Neither entity's own accounts are wrong, so
    // nothing is written back to them.
    await givenFactoryStock(100);
    await transferToBrand(
      {
        variantId, quantity: "100", fromLocationId: factoryLocId,
        toLocationId: brandLocId, transferDate: day, costSnapshotId: snapshotId,
      },
      ctx,
    );

    const before = await db.journalEntry.count();
    await groupProfitAndLoss(periodId);
    expect(await db.journalEntry.count()).toBe(before);
  });
});
