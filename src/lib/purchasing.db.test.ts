import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { approvePurchaseOrder } from "./approvals";
import { createPurchaseOrder, receiveGoods, payGoodsReceipt, PurchasingError } from "./purchasing";
import { apAging, supplierStatements } from "./reports";
import { dec } from "./money";

/** Purchasing against a real database. */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let factoryId: string;
let locationId: string;
let supplierId: string;
let materialId: string;
let day: Date;
let userId: string;


beforeAll(async () => {
  factoryId = (await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } })).id;
  locationId = (await db.location.findFirstOrThrow({ where: { code: "LOC-FAC" } })).id;
  supplierId = (await db.supplier.findFirstOrThrow({ where: { isActive: true } })).id;
  userId = (await db.user.findFirstOrThrow({ where: { email: "owner@cashmere.eg" } })).id;

  // A material with freight, so landed cost is genuinely exercised.
  materialId = (
    await db.material.findFirstOrThrow({ where: { type: "FABRIC", freightPct: { gt: 0 } } })
  ).id;

  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" }, orderBy: { startDate: "asc" },
  });
  day = new Date(period.startDate);
});

async function wipe() {
  await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
  await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
  try {
    await db.goodsReceiptPayment.deleteMany({});
    await db.expensePayment.deleteMany({});
    await db.expense.deleteMany({});
    await db.goodsReceiptLine.deleteMany({});
    await db.goodsReceipt.deleteMany({});
    await db.purchaseOrderLine.deleteMany({});
    await db.purchaseOrder.deleteMany({});
    await db.inventoryMovement.deleteMany({});
    await db.inventoryLot.deleteMany({});
    await db.bankStatementLine.deleteMany({});
    await db.bankStatement.deleteMany({});
    await db.journalLine.deleteMany({});
    await db.journalEntry.deleteMany({});
    await db.auditLog.deleteMany({});
    await db.documentSequence.deleteMany({});
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
  }
}

beforeEach(wipe);
afterAll(async () => { await wipe(); await db.$disconnect(); });

/**
 * An order ready to receive against.
 *
 * These tests are about receiving mechanics — landed cost, price variance,
 * partial delivery. A large order now needs approving before goods can be
 * booked in, so that step happens here rather than in every test; the
 * approval rules themselves are covered in approvals.db.test.ts.
 */
const order = async (over: Partial<Parameters<typeof createPurchaseOrder>[0]> = {}) => {
  const created = await createPurchaseOrder(
    {
      supplierId, orderDate: day, expectedDate: day,
      lines: [{ materialId, quantity: 500, unitPrice: 95 }],
      ...over,
    },
    { userId },
  );

  const raised = await db.purchaseOrder.findUniqueOrThrow({
    where: { id: created.purchaseOrderId },
  });
  if (raised.status === "DRAFT") {
    // Raised by `userId` and approved by them, which is an override the
    // service allows only with a stated reason.
    await approvePurchaseOrder(
      { purchaseOrderId: created.purchaseOrderId, overrideReason: "fixture" },
      { userId },
    );
  }

  return created;
};

describe("raising a purchase order", () => {
  it("prices lines at landed cost using the material's freight and duty", async () => {
    const po = await order();
    const line = await db.purchaseOrderLine.findFirstOrThrow({
      include: { material: true },
    });

    const expected = dec(95).times(
      dec(line.freightPct).plus(dec(line.dutyPct)).plus(1),
    );
    expect(Number(line.effectiveCost)).toBeCloseTo(Number(expected), 2);
    expect(po.poNumber).toMatch(/^PUR-\d{4}-\d{2}-\d{4}$/);
  });

  it("takes the due date from the supplier's agreed credit terms", async () => {
    await order();
    const supplier = await db.supplier.findUniqueOrThrow({ where: { id: supplierId } });
    const po = await db.purchaseOrder.findFirstOrThrow();

    expect(po.creditDays).toBe(supplier.creditDays);
    const expectedDue = new Date(day.getTime() + supplier.creditDays * 86_400_000);
    expect(po.dueDate?.toISOString().slice(0, 10)).toBe(
      expectedDue.toISOString().slice(0, 10),
    );
  });

  it("refuses an order with no lines", async () => {
    await expect(order({ lines: [] })).rejects.toThrow();
  });

  it("refuses to order from an inactive supplier", async () => {
    const dormant = await db.supplier.create({
      data: { code: "SUP-DORMANT", nameEn: "Dormant", nameAr: "متوقف", isActive: false },
    });
    await expect(order({ supplierId: dormant.id })).rejects.toThrow(/inactive/i);
    await db.supplier.delete({ where: { id: dormant.id } });
  });
});

describe("receiving goods", () => {
  it("puts accepted quantity into stock at the invoiced price", async () => {
    const po = await order();
    const line = await db.purchaseOrderLine.findFirstOrThrow();

    const result = await receiveGoods(
      {
        purchaseOrderId: po.purchaseOrderId, receivedDate: day,
        locationId, entityId: factoryId, invoiceRef: "INV-8891",
        lines: [{ purchaseOrderLineId: line.id, acceptedQty: 500, rejectedQty: 0, actualUnitPrice: 95 }],
      },
      { userId },
    );

    expect(result.lotsCreated).toBe(1);
    const lot = await db.inventoryLot.findFirstOrThrow();
    expect(lot.remainingQty.toString()).toBe("500");
    expect(Number(lot.unitCost)).toBeCloseTo(Number(line.effectiveCost), 2);
  });

  it("captures purchase price variance when the invoice differs from the order", async () => {
    // The specification's own example: fabric ordered at 95, invoiced at 112.
    const po = await order();
    const line = await db.purchaseOrderLine.findFirstOrThrow();

    const result = await receiveGoods(
      {
        purchaseOrderId: po.purchaseOrderId, receivedDate: day,
        locationId, entityId: factoryId,
        lines: [{ purchaseOrderLineId: line.id, acceptedQty: 500, rejectedQty: 0, actualUnitPrice: 112 }],
      },
      { userId },
    );

    expect(Number(result.priceVariance)).toBeCloseTo((112 - 95) * 500, 2);

    const receiptLine = await db.goodsReceiptLine.findFirstOrThrow();
    expect(Number(receiptLine.priceVariancePct)).toBeCloseTo((112 - 95) / 95, 6);
    // The lot carries the price actually paid, not the price hoped for.
    const lot = await db.inventoryLot.findFirstOrThrow();
    expect(Number(lot.unitCost)).toBeGreaterThan(Number(line.effectiveCost));
  });

  it("keeps rejected goods out of stock", async () => {
    const po = await order();
    const line = await db.purchaseOrderLine.findFirstOrThrow();

    await receiveGoods(
      {
        purchaseOrderId: po.purchaseOrderId, receivedDate: day,
        locationId, entityId: factoryId,
        lines: [{ purchaseOrderLineId: line.id, acceptedQty: 460, rejectedQty: 40, actualUnitPrice: 95 }],
      },
      { userId },
    );

    // Only what passed inspection is stock the factory could cut.
    const lot = await db.inventoryLot.findFirstOrThrow();
    expect(lot.remainingQty.toString()).toBe("460");
  });

  it("supports partial delivery and closes the order when it completes", async () => {
    const po = await order();
    const line = await db.purchaseOrderLine.findFirstOrThrow();

    await receiveGoods(
      {
        purchaseOrderId: po.purchaseOrderId, receivedDate: day,
        locationId, entityId: factoryId,
        lines: [{ purchaseOrderLineId: line.id, acceptedQty: 200, rejectedQty: 0, actualUnitPrice: 95 }],
      },
      { userId },
    );
    expect(
      (await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.purchaseOrderId } })).status,
    ).toBe("PARTIALLY_RECEIVED");

    await receiveGoods(
      {
        purchaseOrderId: po.purchaseOrderId, receivedDate: day,
        locationId, entityId: factoryId,
        lines: [{ purchaseOrderLineId: line.id, acceptedQty: 300, rejectedQty: 0, actualUnitPrice: 95 }],
      },
      { userId },
    );
    expect(
      (await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.purchaseOrderId } })).status,
    ).toBe("RECEIVED");

    // Two deliveries, two FIFO layers.
    expect(await db.inventoryLot.count()).toBe(2);
  });

  it("refuses to receive more than was ordered", async () => {
    // Usually a delivery booked against the wrong order; accepting it would
    // put stock in that no order accounts for.
    const po = await order();
    const line = await db.purchaseOrderLine.findFirstOrThrow();

    await expect(
      receiveGoods(
        {
          purchaseOrderId: po.purchaseOrderId, receivedDate: day,
          locationId, entityId: factoryId,
          lines: [{ purchaseOrderLineId: line.id, acceptedQty: 600, rejectedQty: 0, actualUnitPrice: 95 }],
        },
        { userId },
      ),
    ).rejects.toThrow(/only 500 is outstanding/i);
  });

  it("refuses to receive against a fully received order", async () => {
    const po = await order();
    const line = await db.purchaseOrderLine.findFirstOrThrow();
    await receiveGoods(
      {
        purchaseOrderId: po.purchaseOrderId, receivedDate: day,
        locationId, entityId: factoryId,
        lines: [{ purchaseOrderLineId: line.id, acceptedQty: 500, rejectedQty: 0, actualUnitPrice: 95 }],
      },
      { userId },
    );

    await expect(
      receiveGoods(
        {
          purchaseOrderId: po.purchaseOrderId, receivedDate: day,
          locationId, entityId: factoryId,
          lines: [{ purchaseOrderLineId: line.id, acceptedQty: 1, rejectedQty: 0, actualUnitPrice: 95 }],
        },
        { userId },
      ),
    ).rejects.toThrow(PurchasingError);
  });

  it("posts the receipt to the ledger and keeps it balanced", async () => {
    const po = await order();
    const line = await db.purchaseOrderLine.findFirstOrThrow();
    await receiveGoods(
      {
        purchaseOrderId: po.purchaseOrderId, receivedDate: day,
        locationId, entityId: factoryId,
        lines: [{ purchaseOrderLineId: line.id, acceptedQty: 500, rejectedQty: 0, actualUnitPrice: 95 }],
      },
      { userId },
    );

    const [row] = await db.$queryRaw<{ debit: string; credit: string }[]>`
      SELECT COALESCE(SUM(l."debit"), 0)::text AS debit,
             COALESCE(SUM(l."credit"), 0)::text AS credit
      FROM "journal_lines" l
      JOIN "journal_entries" e ON e."id" = l."journalEntryId"
      WHERE e."status" = 'POSTED'
    `;
    expect(row.debit).toBe(row.credit);

    // Raw materials debited, payables credited.
    const [raw] = await db.$queryRaw<{ balance: string }[]>`
      SELECT COALESCE(SUM(l."debit") - SUM(l."credit"), 0)::text AS balance
      FROM "journal_lines" l
      JOIN "journal_entries" e ON e."id" = l."journalEntryId"
      JOIN "accounts" a ON a."id" = l."accountId"
      WHERE a."code" = '1310' AND e."status" = 'POSTED'
    `;
    expect(Number(raw.balance)).toBeGreaterThan(0);
  });

  it("records which delivery each lot came in on", async () => {
    // The receipt line was created and the lot never pointed at it, so a
    // roll of fabric could not be traced back to its delivery or price.
    const po = await order();
    const line = await db.purchaseOrderLine.findFirstOrThrow();
    await receiveGoods(
      {
        purchaseOrderId: po.purchaseOrderId, receivedDate: day, locationId, entityId: factoryId,
        lines: [{ purchaseOrderLineId: line.id, acceptedQty: 500, rejectedQty: 0, actualUnitPrice: 95 }],
      },
      { userId },
    );

    const lot = await db.inventoryLot.findFirstOrThrow({ include: { goodsReceiptLine: true } });
    expect(lot.goodsReceiptLine?.purchaseOrderLineId).toBe(line.id);
  });
});

async function payablesLedger(): Promise<number> {
  const [row] = await db.$queryRaw<{ balance: string }[]>`
    SELECT COALESCE(SUM(l."credit") - SUM(l."debit"), 0)::text AS balance
    FROM "journal_lines" l
    JOIN "journal_entries" e ON e."id" = l."journalEntryId"
    JOIN "accounts" a ON a."id" = l."accountId"
    WHERE a."code" = '2110' AND e."status" = 'POSTED'
  `;
  return Number(row.balance);
}

/**
 * What a delivery leaves owing.
 *
 * The audit's figures: 199,540 credited to payables for material received,
 * and a payables aging showing nothing, because it read expenses only. The
 * only way to pay a delivery was to raise an expense for it, which put the
 * same debt on the books twice.
 */
describe("paying for deliveries", () => {
  async function delivered(acceptedQty = 500, actualUnitPrice = 95) {
    const po = await order();
    const line = await db.purchaseOrderLine.findFirstOrThrow();
    return receiveGoods(
      {
        purchaseOrderId: po.purchaseOrderId, receivedDate: day, locationId, entityId: factoryId,
        invoiceRef: "INV-2201",
        lines: [{ purchaseOrderLineId: line.id, acceptedQty, rejectedQty: 0, actualUnitPrice }],
      },
      { userId },
    );
  }

  it("puts the delivery on the aging at exactly what payables were credited", async () => {
    const receipt = await delivered();

    const aging = await apAging();
    const row = aging.rows.find((r) => r.id === receipt.goodsReceiptId);
    expect(row?.kind).toBe("DELIVERY");
    expect(Number(row!.outstanding)).toBeCloseTo(Number(receipt.payable), 2);
    expect(Number(aging.total)).toBeCloseTo(await payablesLedger(), 2);
    expect(Number(aging.unreconciled)).toBeCloseTo(0, 2);
  });

  it("names the supplier on their statement", async () => {
    const receipt = await delivered();
    const statements = await supplierStatements();
    const mine = statements.find((s) => s.supplierId === supplierId);
    expect(mine?.invoices.some((i) => i.id === receipt.goodsReceiptId && i.kind === "DELIVERY")).toBe(true);
  });

  it("dates the debt on the supplier's terms from the day the goods arrived", async () => {
    const receipt = await delivered();
    const supplier = await db.supplier.findUniqueOrThrow({ where: { id: supplierId } });
    const row = await db.goodsReceipt.findUniqueOrThrow({ where: { id: receipt.goodsReceiptId } });
    expect(row.dueDate?.toISOString().slice(0, 10)).toBe(
      new Date(day.getTime() + supplier.creditDays * 86_400_000).toISOString().slice(0, 10),
    );
  });

  it("pays part of it, and payables and the aging fall together", async () => {
    const receipt = await delivered();
    const owed = Number(receipt.payable);

    const paid = await payGoodsReceipt(
      { goodsReceiptId: receipt.goodsReceiptId, amount: 10_000, paidDate: day, method: "BANK_TRANSFER" },
      { userId },
    );

    expect(Number(paid.outstanding)).toBeCloseTo(owed - 10_000, 2);
    expect(await payablesLedger()).toBeCloseTo(owed - 10_000, 2);
    const aging = await apAging();
    expect(Number(aging.total)).toBeCloseTo(owed - 10_000, 2);
    expect(Number(aging.unreconciled)).toBeCloseTo(0, 2);
  });

  it("drops off the aging once paid in full", async () => {
    const receipt = await delivered();
    await payGoodsReceipt(
      { goodsReceiptId: receipt.goodsReceiptId, amount: Number(receipt.payable), paidDate: day },
      { userId },
    );
    const aging = await apAging();
    expect(aging.rows.some((r) => r.id === receipt.goodsReceiptId)).toBe(false);
    expect(await payablesLedger()).toBeCloseTo(0, 2);
  });

  it("refuses to pay more than is owed", async () => {
    const receipt = await delivered();
    await expect(
      payGoodsReceipt(
        { goodsReceiptId: receipt.goodsReceiptId, amount: Number(receipt.payable) + 1, paidDate: day },
        { userId },
      ),
    ).rejects.toThrow(/exceeds/i);
  });

  it("pays only once when two payments of the balance race", async () => {
    const receipt = await delivered();
    const pay = () =>
      payGoodsReceipt(
        { goodsReceiptId: receipt.goodsReceiptId, amount: Number(receipt.payable), paidDate: day },
        { userId },
      );
    const outcomes = await Promise.allSettled([pay(), pay()]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(await db.goodsReceiptPayment.count()).toBe(1);
  });
});
