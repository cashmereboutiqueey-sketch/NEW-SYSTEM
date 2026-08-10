import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { createPurchaseOrder, receiveGoods, PurchasingError } from "./purchasing";
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

const ctx = { userId: null as string | null, reason: null };

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

const order = (over: Partial<Parameters<typeof createPurchaseOrder>[0]> = {}) =>
  createPurchaseOrder(
    {
      supplierId, orderDate: day, expectedDate: day,
      lines: [{ materialId, quantity: 500, unitPrice: 95 }],
      ...over,
    },
    { userId },
  );

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
});
