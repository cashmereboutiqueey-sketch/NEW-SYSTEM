import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { receiveFinishedGoods } from "./inventory";
import { createSale, openPosSession, closePosSession } from "./sales";
import { createConsignor, receiveConsignment, sellConsignedItem } from "./consignment";
import { recordReturn } from "./returns";
import { collectPayment } from "./receivables";

/**
 * What a till's drawer should hold at close.
 *
 * The audit's case: 500 of the shop's own goods and 500 of a consignor's, both
 * sold for cash on one till. The close counted only the first, so a drawer
 * holding exactly the right cash read 500 over — and a cash refund, or a debt
 * paid off at the counter, was missing the same way.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let brandId: string;
let locationId: string;
let channelId: string;
let variantId: string;
let ownerId: string;
let customerId: string;
let day: Date;

beforeAll(async () => {
  brandId = (await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } })).id;
  locationId = (await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } })).id;
  channelId = (await db.salesChannel.findFirstOrThrow()).id;
  variantId = (await db.variant.findFirstOrThrow()).id;
  ownerId = (await db.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" }, orderBy: { startDate: "asc" },
  });
  day = new Date(period.startDate);
});

async function wipe() {
  await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
  await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
  try {
    await db.commandReceipt.deleteMany({});
    await db.return.deleteMany({});
    await db.consignmentSale.deleteMany({});
    await db.consignorSettlement.deleteMany({});
    await db.consignmentItem.deleteMany({});
    await db.consignor.deleteMany({});
    await db.garmentUnit.deleteMany({});
    await db.salesPayment.deleteMany({});
    await db.salesOrderLine.deleteMany({});
    await db.salesOrder.deleteMany({});
    await db.tillCashEvent.deleteMany({});
    await db.posSession.deleteMany({});
    await db.inventoryMovement.deleteMany({});
    await db.inventoryLot.deleteMany({});
    await db.journalLine.deleteMany({});
    await db.journalEntry.deleteMany({});
    await db.auditLog.deleteMany({});
    await db.documentSequence.deleteMany({});
    await db.customer.deleteMany({ where: { code: { startsWith: "TILL-" } } });
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
  }
}

beforeEach(async () => {
  await wipe();
  customerId = (
    await db.customer.create({
      data: { code: "TILL-CUST", name: "زبونة الدرج", phone: "01000000123", creditLimit: "20000", creditDays: 30 },
    })
  ).id;
  await receiveFinishedGoods(
    {
      variantId, locationId, entityId: brandId,
      quantity: "10", unitCost: "300", materialUnitCost: "240", receivedDate: day,
    },
    { userId: null },
  );
});
afterAll(async () => { await wipe(); await db.$disconnect(); });

const openTill = () =>
  openPosSession({ locationId, cashierUserId: ownerId, openingFloat: "1000" }, { userId: ownerId });

const cashSale = (posSessionId: string | null, amount: number) =>
  createSale(
    {
      source: posSessionId ? "POS" : "MANUAL", channelId, entityId: brandId, locationId,
      posSessionId, customerId, orderDate: day,
      lines: [{ variantId, quantity: 1, retailPrice: amount, discountPct: 0 }],
      payments: [{ method: "CASH", amount, fee: 0, collected: true }],
    },
    { userId: ownerId },
  );

describe("the drawer's expected cash", () => {
  it("counts a consignor's garment sold for cash on the same till", async () => {
    const till = await openTill();
    await cashSale(till.posSessionId, 500);

    const consignor = await createConsignor({ code: "TILL-C", name: "مورّدة", commissionRate: "0.25" }, { userId: ownerId });
    const item = await receiveConsignment(
      { consignorId: consignor.id, description: "فستان", quantity: 2, retailPrice: "500", locationId, receivedDate: day },
      { userId: ownerId },
    );
    await sellConsignedItem(
      { itemId: item.id, quantity: 1, paymentMethod: "CASH", posSessionId: till.posSessionId, saleDate: day },
      { userId: ownerId },
    );

    // Owner closing their own till is the allowed exception.
    const closed = await closePosSession({ posSessionId: till.posSessionId, countedCash: "2000" }, { userId: ownerId });
    expect(Number(closed.expectedCash)).toBe(2000);
    expect(Number(closed.variance)).toBe(0);
  });

  it("takes a cash refund out of the drawer it was paid from", async () => {
    const till = await openTill();
    const sale = await cashSale(till.posSessionId, 800);
    await recordReturn(
      {
        salesOrderId: sale.salesOrderId, variantId, quantity: 1,
        disposition: "RESTOCK", refundMethod: "CASH", returnDate: day,
      },
      { userId: ownerId },
    );

    const closed = await closePosSession({ posSessionId: till.posSessionId, countedCash: "1000" }, { userId: ownerId });
    expect(Number(closed.expectedCash)).toBe(1000);
  });

  it("puts a debt paid off at the counter in today's till, not the one it was sold on", async () => {
    // Sold on account before any till was opened, paid off in cash later.
    const credit = await createSale(
      {
        source: "MANUAL", channelId, entityId: brandId, locationId, customerId, orderDate: day,
        lines: [{ variantId, quantity: 1, retailPrice: 600, discountPct: 0 }],
        payments: [],
      },
      { userId: ownerId },
    );
    const till = await openTill();
    await collectPayment(
      { salesOrderId: credit.salesOrderId, method: "CASH", amount: "600", collectedOn: day },
      { userId: ownerId, reason: null },
    );

    const closed = await closePosSession({ posSessionId: till.posSessionId, countedCash: "1600" }, { userId: ownerId });
    expect(Number(closed.expectedCash)).toBe(1600);
  });

  it("refuses a sale rung up on a till at another location", async () => {
    const till = await openTill();
    const elsewhere = await db.location.findFirstOrThrow({ where: { id: { not: locationId }, isActive: true } });
    await expect(
      createSale(
        {
          source: "POS", channelId, entityId: brandId, locationId: elsewhere.id,
          posSessionId: till.posSessionId, customerId, orderDate: day,
          lines: [{ variantId, quantity: 1, retailPrice: 100, discountPct: 0 }],
          payments: [{ method: "CASH", amount: 100, fee: 0, collected: true }],
        },
        { userId: ownerId },
      ),
    ).rejects.toThrow(/another location/i);
  });
});

describe("one till per location", () => {
  it("opens only one of two simultaneous tills at the same place", async () => {
    const outcomes = await Promise.allSettled([openTill(), openTill()]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(await db.posSession.count({ where: { locationId, closedAt: null } })).toBe(1);
  });
});
