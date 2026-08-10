import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { receiveFinishedGoods } from "./inventory";
import {
  takeCustomOrder,
  addDeposit,
  linkProductionOrder,
  markReady,
  deliverCustomOrder,
  cancelCustomOrder,
  customOrderList,
  depositsHeld,
  CustomOrderError,
} from "./custom-orders";
import { outstandingForCustomer } from "./receivables";
import { dec } from "./money";

/**
 * A garment somebody wants that does not exist yet.
 *
 * The thing these tests exist to protect is the difference between money and
 * income. A deposit is the shop holding somebody else's money against a
 * promise — a liability — and it stays one until the customer walks out with
 * the coat. Getting that wrong books revenue for something that has not been
 * cut, and leaves a liability standing forever afterwards.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let brandId: string;
let showroomId: string;
let variantId: string;
let styleId: string;
let channelId: string;
let customerId: string;
let day: Date;

const ctx = { userId: null as string | null, reason: null };

beforeAll(async () => {
  brandId = (await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } })).id;
  showroomId = (await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } })).id;
  channelId = (await db.salesChannel.findFirstOrThrow()).id;

  const variant = await db.variant.findFirstOrThrow();
  variantId = variant.id;
  styleId = variant.styleId;

  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" },
    orderBy: { startDate: "asc" },
  });
  day = new Date(period.startDate);
});

async function wipe() {
  await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
  await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
  try {
    await db.customOrder.deleteMany({});
    await db.garmentUnit.deleteMany({});
    await db.salesPayment.deleteMany({});
    await db.salesOrderLine.deleteMany({});
    await db.salesOrder.deleteMany({});
    await db.inventoryMovement.deleteMany({});
    await db.inventoryLot.deleteMany({});
    await db.journalLine.deleteMany({});
    await db.journalEntry.deleteMany({});
    await db.auditLog.deleteMany({});
    await db.documentSequence.deleteMany({});
    await db.customer.deleteMany({ where: { code: { startsWith: "CO-" } } });
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
  }

  const c = await db.customer.create({
    data: {
      code: "CO-CUST", name: "هدى شعراوي", phone: "01000000009",
      creditLimit: "3000", creditDays: 14,
    },
  });
  customerId = c.id;
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await db.$disconnect();
});

async function accountBalance(code: string) {
  const account = await db.account.findUniqueOrThrow({ where: { code } });
  const rows = await db.journalLine.findMany({
    where: { accountId: account.id, journalEntry: { status: "POSTED" } },
    select: { debit: true, credit: true },
  });
  return rows
    .reduce((s, r) => s.plus(dec(r.debit)).minus(dec(r.credit)), dec(0))
    .toNumber();
}

async function ledgerGap() {
  const rows = await db.journalLine.findMany({
    where: { journalEntry: { status: "POSTED" } },
    select: { debit: true, credit: true },
  });
  return rows
    .reduce((s, r) => s.plus(dec(r.debit)).minus(dec(r.credit)), dec(0))
    .toNumber();
}

/** The garment arrives on the shelf, as production would deliver it. */
async function garmentMade(quantity = 1) {
  await receiveFinishedGoods(
    {
      variantId, locationId: showroomId, entityId: brandId,
      quantity: String(quantity), unitCost: "900", materialUnitCost: "700",
      receivedDate: day,
    },
    ctx,
  );
}

function order(over: Partial<Parameters<typeof takeCustomOrder>[0]> = {}) {
  return takeCustomOrder(
    {
      customerId, variantId, quantity: 1,
      agreedUnitPrice: "4000",
      deposit: { amount: "1500", method: "CASH" },
      entityId: brandId, locationId: showroomId,
      orderDate: day,
      promisedDate: new Date(day.getTime() + 14 * 86_400_000),
      ...over,
    },
    ctx,
  );
}

describe("taking the order", () => {
  it("holds the deposit as something owed, not as income", async () => {
    const taken = await order();

    expect(Number(taken.agreedTotal)).toBe(4000);
    expect(Number(taken.deposit)).toBe(1500);

    // Cash in the drawer, and a liability of the same size. Nothing else.
    expect(await accountBalance("1115")).toBeCloseTo(1500, 2);
    // A liability carries a credit balance, hence negative under debit−credit.
    expect(await accountBalance("2400")).toBeCloseTo(-1500, 2);
    // Not a penny of revenue: there is no garment yet.
    expect(await accountBalance("4130")).toBeCloseTo(0, 2);
    expect(await ledgerGap()).toBeCloseTo(0, 6);
  });

  it("works with no deposit at all", async () => {
    const taken = await order({ deposit: null });
    expect(Number(taken.deposit)).toBe(0);
    expect(await accountBalance("2400")).toBeCloseTo(0, 2);
  });

  it("refuses a deposit larger than the price", async () => {
    // Otherwise the shop owes the customer money on the day it delivers.
    await expect(
      order({ deposit: { amount: "5000", method: "CASH" } }),
    ).rejects.toThrow(/more than the/i);
  });

  it("refuses a promise date before the order", async () => {
    await expect(
      order({ promisedDate: new Date(day.getTime() - 86_400_000) }),
    ).rejects.toThrow(/before the order/i);
  });

  it("refuses no pieces", async () => {
    await expect(order({ quantity: 0 })).rejects.toThrow(CustomOrderError);
  });

  it("takes more money later", async () => {
    const taken = await order();
    const more = await addDeposit(
      { customOrderId: taken.id, amount: "1000", method: "BANK_TRANSFER", paidOn: day },
      ctx,
    );

    expect(Number(more.deposit)).toBe(2500);
    expect(Number(more.stillDue)).toBe(1500);
    expect(await accountBalance("2400")).toBeCloseTo(-2500, 2);
    expect(await accountBalance("1120")).toBeCloseTo(1000, 2);
  });

  it("refuses to hold more than the whole price", async () => {
    const taken = await order();
    await expect(
      addDeposit({ customOrderId: taken.id, amount: "3000", method: "CASH", paidOn: day }, ctx),
    ).rejects.toThrow(/against an order of/i);
  });
});

describe("putting it into production", () => {
  it("attaches a run and moves the order along", async () => {
    const taken = await order();
    const run = await db.productionOrder.create({
      data: {
        orderNumber: "PO-TEST-CO-1", styleId, plannedQty: 1,
        status: "DRAFT", orderDate: day,
      },
    });

    await linkProductionOrder({ customOrderId: taken.id, productionOrderId: run.id }, ctx);

    const after = await db.customOrder.findUniqueOrThrow({ where: { id: taken.id } });
    expect(after.status).toBe("IN_PRODUCTION");
    expect(after.productionOrderId).toBe(run.id);
  });

  it("refuses a run for a different style", async () => {
    const other = await db.style.findFirstOrThrow({ where: { id: { not: styleId } } });
    const taken = await order();
    const run = await db.productionOrder.create({
      data: {
        orderNumber: "PO-TEST-CO-2", styleId: other.id, plannedQty: 1,
        status: "DRAFT", orderDate: day,
      },
    });

    // Nobody would notice until the customer opened the bag.
    await expect(
      linkProductionOrder({ customOrderId: taken.id, productionOrderId: run.id }, ctx),
    ).rejects.toThrow(/different style/i);
  });

  it("refuses a run too small for what was promised", async () => {
    const taken = await order({ quantity: 5 });
    const run = await db.productionOrder.create({
      data: {
        orderNumber: "PO-TEST-CO-3", styleId, plannedQty: 2,
        status: "DRAFT", orderDate: day,
      },
    });

    await expect(
      linkProductionOrder({ customOrderId: taken.id, productionOrderId: run.id }, ctx),
    ).rejects.toThrow(/asked for/i);
  });

  it("refuses to attach a second run", async () => {
    const taken = await order();
    const runs = await Promise.all([
      db.productionOrder.create({
        data: { orderNumber: "PO-TEST-CO-4", styleId, plannedQty: 1, status: "DRAFT", orderDate: day },
      }),
      db.productionOrder.create({
        data: { orderNumber: "PO-TEST-CO-5", styleId, plannedQty: 1, status: "DRAFT", orderDate: day },
      }),
    ]);

    await linkProductionOrder({ customOrderId: taken.id, productionOrderId: runs[0].id }, ctx);
    await expect(
      linkProductionOrder({ customOrderId: taken.id, productionOrderId: runs[1].id }, ctx),
    ).rejects.toThrow(/already has a run/i);
  });
});

describe("handing it over", () => {
  it("turns the deposit into revenue and takes the rest", async () => {
    const taken = await order(); // 4,000 agreed, 1,500 deposit
    await garmentMade();
    await markReady({ customOrderId: taken.id }, ctx);

    const delivered = await deliverCustomOrder(
      {
        customOrderId: taken.id,
        deliveredOn: day,
        payNow: { amount: "2500", method: "CASH" },
        channelId,
      },
      ctx,
    );

    expect(Number(delivered.stillOwed)).toBe(0);

    // The liability is discharged: the promise was kept.
    expect(await accountBalance("2400")).toBeCloseTo(0, 2);
    // Revenue is the whole agreed price, recognised today and not before.
    expect(await accountBalance("4130")).toBeCloseTo(-4000, 2);
    // 1,500 on the day of the order plus 2,500 today.
    expect(await accountBalance("1115")).toBeCloseTo(4000, 2);
    expect(await ledgerGap()).toBeCloseTo(0, 6);
  });

  it("does not count the deposit as cash twice", async () => {
    const taken = await order();
    await garmentMade();
    await deliverCustomOrder(
      { customOrderId: taken.id, deliveredOn: day, payNow: { amount: "2500", method: "CASH" }, channelId },
      ctx,
    );

    // The drawer holds 4,000, not 5,500. The deposit arrived once.
    expect(await accountBalance("1115")).toBeCloseTo(4000, 2);
  });

  it("puts an unpaid balance on the customer's account", async () => {
    const taken = await order(); // 1,500 deposit, 2,500 left
    await garmentMade();

    const delivered = await deliverCustomOrder(
      { customOrderId: taken.id, deliveredOn: day, payNow: { amount: "1000", method: "CASH" }, channelId },
      ctx,
    );

    expect(Number(delivered.stillOwed)).toBe(1500);
    // Their limit is 3,000, so 1,500 is within it and lands as a receivable.
    expect((await outstandingForCustomer(customerId)).toNumber()).toBe(1500);
    expect(await accountBalance("1210")).toBeCloseTo(1500, 2);
    expect(await ledgerGap()).toBeCloseTo(0, 6);
  });

  it("refuses when the garment is not actually there", async () => {
    const taken = await order();
    // No stock: production has not delivered. Booking revenue here would
    // claim income for a coat nobody has made.
    await expect(
      deliverCustomOrder(
        { customOrderId: taken.id, deliveredOn: day, payNow: { amount: "2500", method: "CASH" }, channelId },
        ctx,
      ),
    ).rejects.toThrow();

    const after = await db.customOrder.findUniqueOrThrow({ where: { id: taken.id } });
    expect(after.status).not.toBe("DELIVERED");
    // And the deposit is still held, untouched.
    expect(await accountBalance("2400")).toBeCloseTo(-1500, 2);
  });

  it("refuses to take more than what is left", async () => {
    const taken = await order();
    await garmentMade();
    await expect(
      deliverCustomOrder(
        { customOrderId: taken.id, deliveredOn: day, payNow: { amount: "9000", method: "CASH" }, channelId },
        ctx,
      ),
    ).rejects.toThrow(/more than the/i);
  });

  it("cannot be delivered twice", async () => {
    const taken = await order();
    await garmentMade(2);
    await deliverCustomOrder(
      { customOrderId: taken.id, deliveredOn: day, payNow: { amount: "2500", method: "CASH" }, channelId },
      ctx,
    );

    await expect(
      deliverCustomOrder(
        { customOrderId: taken.id, deliveredOn: day, payNow: { amount: "2500", method: "CASH" }, channelId },
        ctx,
      ),
    ).rejects.toThrow(/already been delivered/i);
  });

  it("leaves a sales order behind that can be found from either end", async () => {
    const taken = await order();
    await garmentMade();
    const delivered = await deliverCustomOrder(
      { customOrderId: taken.id, deliveredOn: day, payNow: { amount: "2500", method: "CASH" }, channelId },
      ctx,
    );

    const after = await db.customOrder.findUniqueOrThrow({
      where: { id: taken.id },
      include: { salesOrder: true },
    });
    expect(after.status).toBe("DELIVERED");
    expect(after.salesOrder?.orderNumber).toBe(delivered.salesOrderNumber);
    expect(after.deliveredAt).not.toBeNull();
  });
});

describe("cancelling", () => {
  it("gives the deposit back", async () => {
    const taken = await order();
    const result = await cancelCustomOrder(
      { customOrderId: taken.id, reason: "غيّرت رأيها", cancelledOn: day, refundMethod: "CASH" },
      ctx,
    );

    expect(Number(result.refunded)).toBe(1500);
    // Both sides go back to nothing: the money left, the promise is gone.
    expect(await accountBalance("2400")).toBeCloseTo(0, 2);
    expect(await accountBalance("1115")).toBeCloseTo(0, 2);
    expect(await ledgerGap()).toBeCloseTo(0, 6);
  });

  it("insists on a reason", async () => {
    const taken = await order();
    await expect(
      cancelCustomOrder({ customOrderId: taken.id, reason: "   ", cancelledOn: day }, ctx),
    ).rejects.toThrow(/why it was cancelled/i);
  });

  it("refuses to cancel something already delivered", async () => {
    const taken = await order();
    await garmentMade();
    await deliverCustomOrder(
      { customOrderId: taken.id, deliveredOn: day, payNow: { amount: "2500", method: "CASH" }, channelId },
      ctx,
    );

    await expect(
      cancelCustomOrder({ customOrderId: taken.id, reason: "أي حاجة", cancelledOn: day }, ctx),
    ).rejects.toThrow(/a return is not a cancellation/i);
  });

  it("cannot be cancelled twice", async () => {
    const taken = await order();
    await cancelCustomOrder({ customOrderId: taken.id, reason: "خلاص", cancelledOn: day }, ctx);
    await expect(
      cancelCustomOrder({ customOrderId: taken.id, reason: "تاني", cancelledOn: day }, ctx),
    ).rejects.toThrow(/already cancelled/i);
  });
});

describe("what the shop can see", () => {
  it("shows what is owed on each promise and what is at risk", async () => {
    const taken = await order();
    const list = await customOrderList();
    const row = list.find((r) => r.id === taken.id)!;

    expect(row.customerName).toBe("هدى شعراوي");
    expect(Number(row.agreedTotal)).toBe(4000);
    expect(Number(row.deposit)).toBe(1500);
    // What the shop loses if nobody ever collects a bespoke piece.
    expect(Number(row.atRisk)).toBe(2500);
    expect(row.status).toBe("PENDING");
  });

  it("totals the money held against promises not yet kept", async () => {
    await order();
    await order({ deposit: { amount: "800", method: "CASH" } });

    expect((await depositsHeld()).toNumber()).toBe(2300);
    // Which is exactly what the liability account says.
    expect(await accountBalance("2400")).toBeCloseTo(-2300, 2);
  });

  it("drops delivered orders off the open list", async () => {
    const taken = await order();
    await garmentMade();
    await deliverCustomOrder(
      { customOrderId: taken.id, deliveredOn: day, payNow: { amount: "2500", method: "CASH" }, channelId },
      ctx,
    );

    expect((await customOrderList()).find((r) => r.id === taken.id)).toBeUndefined();
    expect((await customOrderList(true)).find((r) => r.id === taken.id)).toBeTruthy();
    // And nothing is held against it any more.
    expect((await depositsHeld()).toNumber()).toBe(0);
  });
});
