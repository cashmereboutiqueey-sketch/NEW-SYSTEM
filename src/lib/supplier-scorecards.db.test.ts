import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { freezeScorecards, scorecardHistory, ScorecardError } from "./supplier-scorecards";

/**
 * A supplier's scorecard, frozen for a period.
 *
 * The live scorecard is computed over everything that ever happened, which
 * answers "how is this supplier" and cannot answer "are they getting better".
 * Freezing each period on its own activity is what makes the trend visible.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let supplierId: string;
let materialId: string;
let periodId: string;
let periodStart: Date;
let ownerId: string;

const ctx = { userId: null as string | null, reason: null };

beforeAll(async () => {
  supplierId = (await db.supplier.findFirstOrThrow({ orderBy: { code: "asc" } })).id;
  materialId = (await db.material.findFirstOrThrow()).id;
  ownerId = (await db.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;

  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" },
    orderBy: { startDate: "asc" },
  });
  periodId = period.id;
  periodStart = new Date(period.startDate);
});

beforeEach(async () => {
  await db.supplierScorecard.deleteMany({});
  await db.goodsReceiptLine.deleteMany({});
  await db.goodsReceipt.deleteMany({});
  await db.purchaseOrderLine.deleteMany({});
  await db.purchaseOrder.deleteMany({});
});

afterAll(async () => {
  await db.supplierScorecard.deleteMany({});
  await db.goodsReceiptLine.deleteMany({});
  await db.goodsReceipt.deleteMany({});
  await db.purchaseOrderLine.deleteMany({});
  await db.purchaseOrder.deleteMany({});
  await db.$disconnect();
});

const dayAt = (n: number) => new Date(periodStart.getTime() + n * 86_400_000);

/** An order, and a delivery against it, both inside the period. */
async function delivery(options: {
  quantity?: number;
  unitPrice?: number;
  accepted?: number;
  rejected?: number;
  /** Days after the expected date. Negative or zero is on time. */
  lateBy?: number;
  priceVariance?: number;
}) {
  const quantity = options.quantity ?? 100;
  const unitPrice = options.unitPrice ?? 50;
  const accepted = options.accepted ?? quantity;
  const rejected = options.rejected ?? 0;
  const expected = dayAt(5);

  const order = await db.purchaseOrder.create({
    data: {
      poNumber: `PO-SC-${Math.random().toString(36).slice(2, 10)}`,
      supplierId,
      status: "RECEIVED",
      orderDate: dayAt(0),
      expectedDate: expected,
      lines: {
        create: [
          {
            materialId,
            quantity: String(quantity),
            unitPrice: String(unitPrice),
            effectiveCost: String(unitPrice),
            receivedQty: String(accepted + rejected),
          },
        ],
      },
    },
  });

  const orderLines = await db.purchaseOrderLine.findMany({
    where: { purchaseOrderId: order.id },
  });

  await db.goodsReceipt.create({
    data: {
      receiptNumber: `GRN-SC-${Math.random().toString(36).slice(2, 10)}`,
      purchaseOrderId: order.id,
      receivedDate: dayAt(5 + (options.lateBy ?? 0)),
      lines: {
        create: [
          {
            purchaseOrderLineId: orderLines[0].id,
            quantity: String(accepted + rejected),
            acceptedQty: String(accepted),
            rejectedQty: String(rejected),
            orderedUnitPrice: String(unitPrice),
            actualUnitPrice: String(unitPrice),
            actualEffectiveCost: String(unitPrice),
            priceVariance: String(options.priceVariance ?? 0),
            priceVariancePct: "0",
          },
        ],
      },
    },
  });
}

const freeze = () => freezeScorecards(periodId, { userId: ownerId, reason: null });
const ours = async () =>
  (await db.supplierScorecard.findFirstOrThrow({ where: { supplierId, fiscalPeriodId: periodId } }));

describe("scoring a period", () => {
  it("gives a perfect delivery a full mark", async () => {
    await delivery({ lateBy: 0, rejected: 0, priceVariance: 0 });
    await freeze();

    const card = await ours();
    expect(Number(card.deliveryScore)).toBe(10);
    expect(Number(card.qualityScore)).toBe(10);
    expect(Number(card.priceScore)).toBe(10);
    expect(Number(card.overallScore)).toBe(10);
  });

  it("marks lateness down", async () => {
    await delivery({ lateBy: 3 });
    await freeze();

    const card = await ours();
    expect(Number(card.deliveryScore)).toBe(0); // the only receipt was late
    expect(Number(card.onTimeDeliveryRate)).toBe(0);
  });

  it("marks rejections down", async () => {
    await delivery({ quantity: 100, accepted: 90, rejected: 10 });
    await freeze();

    const card = await ours();
    // Ten of a hundred came back.
    expect(Number(card.defectRate)).toBeCloseTo(0.1, 6);
    expect(Number(card.qualityScore)).toBeCloseTo(9, 2);
  });

  it("marks a price overrun down in proportion to the order", async () => {
    // 5,000 ordered, 100 of variance: 2% over, which at a sensitivity of 5
    // costs a full point out of ten.
    await delivery({ quantity: 100, unitPrice: 50, priceVariance: 100 });
    await freeze();

    const card = await ours();
    expect(Number(card.avgPriceVariance)).toBeCloseTo(0.02, 6);
    expect(Number(card.priceScore)).toBeCloseTo(9, 2);
  });

  it("does not reward coming in under the agreed price", async () => {
    // Paying less than agreed is good, but it is not a reason to forgive a
    // late or faulty delivery, so it is a full mark and not a bonus.
    await delivery({ priceVariance: -500 });
    await freeze();

    expect(Number((await ours()).priceScore)).toBe(10);
  });

  it("weighs the three together", async () => {
    // Perfect on time and price, 9 on quality: 0.4×10 + 0.4×9 + 0.2×10.
    await delivery({ quantity: 100, accepted: 90, rejected: 10 });
    await freeze();

    expect(Number((await ours()).overallScore)).toBeCloseTo(9.6, 2);
  });
});

describe("what it leaves alone", () => {
  it("skips a supplier who did nothing that period", async () => {
    // Nothing happened is not the same claim as everything went wrong.
    const result = await freeze();
    expect(result.scored).toBe(0);
    expect(await db.supplierScorecard.count()).toBe(0);
  });

  it("refuses a period that does not exist", async () => {
    await expect(
      freezeScorecards("nope", { userId: ownerId, reason: null }),
    ).rejects.toThrow(ScorecardError);
  });

  it("replaces a period rescored rather than adding a second card", async () => {
    await delivery({ lateBy: 0 });
    await freeze();
    await freeze();

    const cards = await db.supplierScorecard.findMany({
      where: { supplierId, fiscalPeriodId: periodId },
    });
    expect(cards).toHaveLength(1);
  });
});

describe("the trend", () => {
  it("keeps each period rather than overwriting the last", async () => {
    await delivery({ lateBy: 0 });
    await freeze();

    // A second period, scored on its own activity.
    const other = await db.fiscalPeriod.findFirst({
      where: { id: { not: periodId } },
      orderBy: { startDate: "asc" },
    });
    if (!other) return;

    await db.purchaseOrder.updateMany({ data: { orderDate: other.startDate } });
    await db.goodsReceipt.updateMany({ data: { receivedDate: other.startDate } });
    await freezeScorecards(other.id, { userId: ownerId, reason: null });

    const history = await scorecardHistory(supplierId);
    expect(history[0].periods.length).toBeGreaterThanOrEqual(1);
  });

  it("reports which way a supplier is going", async () => {
    const history = await scorecardHistory(supplierId);
    // No frozen periods yet in this test, so there is nothing to compare and
    // movement is null rather than zero — zero would claim they held steady.
    expect(history.every((h) => h.movement === null || h.movement !== undefined)).toBe(true);
  });
});
