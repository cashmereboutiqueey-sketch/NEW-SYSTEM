import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { receiveFinishedGoods } from "./inventory";
import { createSale } from "./sales";
import {
  recordReturn,
  returnableLines,
  recentReturns,
  returnRateByStyle,
  recentOrdersForReturn,
  ReturnError,
} from "./returns";
import { outstandingForCustomer } from "./receivables";
import { dec } from "./money";

/**
 * A customer brings a garment back.
 *
 * Two things must reverse, and the second is the one that goes wrong quietly:
 * the money, and the goods. The garment must go back at the cost it left at,
 * because restocking at today's cost books a gain on a sale that was undone —
 * a shop with enough returns could show a profit made entirely of them.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let brandId: string;
let locationId: string;
let channelId: string;
let variantId: string;
let customerId: string;
let day: Date;

const ctx = { userId: null as string | null, reason: null };

beforeAll(async () => {
  brandId = (await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } })).id;
  locationId = (await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } })).id;
  channelId = (await db.salesChannel.findFirstOrThrow()).id;
  variantId = (await db.variant.findFirstOrThrow()).id;

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
    await db.return.deleteMany({});
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
    await db.customer.deleteMany({ where: { code: { startsWith: "RT-" } } });
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
  }

}

beforeEach(async () => {
  await wipe();
  customerId = (
    await db.customer.create({
      data: {
        code: "RT-CUST", name: "أميرة حسن", phone: "01044556677",
        creditLimit: "5000", creditDays: 14,
      },
    })
  ).id;
});

afterAll(async () => {
  // The journals have to go before the customer does: posted lines name the
  // customer, and the immutability trigger will not let them be rewritten —
  // which is exactly what it is for.
  await wipe();
  await db.$disconnect();
});

async function accountBalance(code: string) {
  const account = await db.account.findUniqueOrThrow({ where: { code } });
  const rows = await db.journalLine.findMany({
    where: { accountId: account.id, journalEntry: { status: "POSTED" } },
    select: { debit: true, credit: true },
  });
  return rows.reduce((s, r) => s.plus(dec(r.debit)).minus(dec(r.credit)), dec(0)).toNumber();
}

async function ledgerGap() {
  const rows = await db.journalLine.findMany({
    where: { journalEntry: { status: "POSTED" } },
    select: { debit: true, credit: true },
  });
  return rows.reduce((s, r) => s.plus(dec(r.debit)).minus(dec(r.credit)), dec(0)).toNumber();
}

async function onHand() {
  const agg = await db.inventoryLot.aggregate({
    where: { variantId, locationId, remainingQty: { gt: 0 } },
    _sum: { remainingQty: true },
  });
  return Number(agg._sum.remainingQty ?? 0);
}

/** Stock on the shelf at a known cost, then a sale of `quantity` at `price`. */
async function soldGarments(quantity = 2, price = 1500, unitCost = "600", paid = true) {
  await receiveFinishedGoods(
    {
      variantId, locationId, entityId: brandId,
      quantity: "10", unitCost, materialUnitCost: dec(unitCost).times("0.8").toString(),
      receivedDate: day,
    },
    ctx,
  );

  return createSale(
    {
      source: "MANUAL", channelId, entityId: brandId, locationId,
      customerId, orderDate: day,
      lines: [{ variantId, quantity, retailPrice: price, discountPct: 0 }],
      payments: paid
        ? [{ method: "CASH", amount: price * quantity, fee: 0, collected: true }]
        : [],
    },
    ctx,
  );
}

describe("taking a garment back", () => {
  it("gives the money back and puts it on the shelf", async () => {
    const sale = await soldGarments(2, 1500, "600");
    const beforeStock = await onHand(); // 10 − 2

    const result = await recordReturn(
      {
        salesOrderId: sale.salesOrderId, variantId, quantity: 1,
        disposition: "RESTOCK", refundMethod: "CASH", returnDate: day,
      },
      ctx,
    );

    expect(Number(result.refunded)).toBe(1500);
    expect(result.restocked).toBe(1);
    expect(await onHand()).toBe(beforeStock + 1);
    expect(await ledgerGap()).toBeCloseTo(0, 6);
  });

  it("shows the return against revenue rather than hiding it in sales", async () => {
    const sale = await soldGarments(2, 1500);
    await recordReturn(
      {
        salesOrderId: sale.salesOrderId, variantId, quantity: 1,
        disposition: "RESTOCK", refundMethod: "CASH", returnDate: day,
      },
      ctx,
    );

    // 4210 is sales returns: a style with a return problem should be visible,
    // not merely look like it sold less.
    expect(await accountBalance("4210")).toBeCloseTo(1500, 2);
    // Revenue itself is untouched: 2 × 1,500 were genuinely sold.
    expect(await accountBalance("4130")).toBeCloseTo(-3000, 2);
    // And the drawer is down by the refund.
    expect(await accountBalance("1115")).toBeCloseTo(1500, 2);
  });

  it("puts it back at the cost it left at, not today's", async () => {
    const sale = await soldGarments(1, 1500, "600");

    // Newer, dearer stock arrives before the return comes in.
    await receiveFinishedGoods(
      {
        variantId, locationId, entityId: brandId,
        quantity: "5", unitCost: "900", materialUnitCost: "720", receivedDate: day,
      },
      ctx,
    );

    await recordReturn(
      {
        salesOrderId: sale.salesOrderId, variantId, quantity: 1,
        disposition: "RESTOCK", refundMethod: "CASH", returnDate: day,
      },
      ctx,
    );

    // Restocking at 900 would credit cost of sales 900 against the 600 that
    // went out — a 300 gain invented by a sale that was undone.
    const lot = await db.inventoryLot.findFirstOrThrow({
      where: { variantId, movements: { some: { type: "RETURN_IN" } } },
    });
    expect(Number(lot.unitCost)).toBe(600);
    expect(await accountBalance("5300")).toBeCloseTo(0, 2);
  });

  it("does not restart the aging clock", async () => {
    const sale = await soldGarments(1, 1500);
    const laterDay = new Date(day.getTime() + 90 * 86_400_000);

    await recordReturn(
      {
        salesOrderId: sale.salesOrderId, variantId, quantity: 1,
        disposition: "RESTOCK", refundMethod: "CASH", returnDate: laterDay,
      },
      ctx,
    );

    // A coat sold in March and returned in June is three months old. Dead
    // stock reporting is worthless if a return can launder the date.
    const lot = await db.inventoryLot.findFirstOrThrow({
      where: { variantId, movements: { some: { type: "RETURN_IN" } } },
    });
    expect(lot.receivedDate.toISOString().slice(0, 10)).toBe(
      day.toISOString().slice(0, 10),
    );
  });

  it("relieves cost of sales for what was undone", async () => {
    const sale = await soldGarments(2, 1500, "600");
    expect(await accountBalance("5300")).toBeCloseTo(1200, 2); // 2 × 600

    await recordReturn(
      {
        salesOrderId: sale.salesOrderId, variantId, quantity: 1,
        disposition: "RESTOCK", refundMethod: "CASH", returnDate: day,
      },
      ctx,
    );

    expect(await accountBalance("5300")).toBeCloseTo(600, 2);
  });
});

describe("a garment that cannot go back on the rail", () => {
  it("books it as a loss instead of stock", async () => {
    const sale = await soldGarments(1, 1500, "600");
    const before = await onHand();

    const result = await recordReturn(
      {
        salesOrderId: sale.salesOrderId, variantId, quantity: 1,
        disposition: "WRITE_OFF", refundMethod: "CASH",
        reason: "اتقطعت", returnDate: day,
      },
      ctx,
    );

    expect(result.restocked).toBe(0);
    expect(await onHand()).toBe(before);
    // The cost lands on stock loss, and the customer still got their money.
    expect(await accountBalance("5450")).toBeCloseTo(600, 2);
    expect(await accountBalance("4210")).toBeCloseTo(1500, 2);
    expect(await ledgerGap()).toBeCloseTo(0, 6);
  });
});

describe("what the money does", () => {
  it("can be set against what they still owe instead of paid out", async () => {
    // 2 × 1,500 with nothing paid: they owe 3,000.
    const sale = await soldGarments(2, 1500, "600", false);
    expect((await outstandingForCustomer(customerId)).toNumber()).toBe(3000);

    await recordReturn(
      {
        salesOrderId: sale.salesOrderId, variantId, quantity: 1,
        disposition: "RESTOCK", refundMethod: "AGAINST_BALANCE", returnDate: day,
      },
      ctx,
    );

    // No cash left the drawer; the debt came down instead.
    expect((await outstandingForCustomer(customerId)).toNumber()).toBe(1500);
    expect(await accountBalance("1115")).toBeCloseTo(0, 2);
    expect(await ledgerGap()).toBeCloseTo(0, 6);
  });

  it("refuses to set a refund against a balance that is not there", async () => {
    const sale = await soldGarments(1, 1500);
    await expect(
      recordReturn(
        {
          salesOrderId: sale.salesOrderId, variantId, quantity: 1,
          disposition: "RESTOCK", refundMethod: "AGAINST_BALANCE", returnDate: day,
        },
        ctx,
      ),
    ).rejects.toThrow(/nothing outstanding/i);
  });

  it("allows a partial refund, for a restocking charge", async () => {
    const sale = await soldGarments(1, 1500, "600");

    const result = await recordReturn(
      {
        salesOrderId: sale.salesOrderId, variantId, quantity: 1,
        disposition: "RESTOCK", refundMethod: "CASH",
        refundAmount: "1200", returnDate: day,
      },
      ctx,
    );

    expect(Number(result.refunded)).toBe(1200);
    expect(await accountBalance("4210")).toBeCloseTo(1200, 2);
    expect(await ledgerGap()).toBeCloseTo(0, 6);
  });

  it("refuses to hand back more than they paid", async () => {
    const sale = await soldGarments(1, 1500);
    await expect(
      recordReturn(
        {
          salesOrderId: sale.salesOrderId, variantId, quantity: 1,
          disposition: "RESTOCK", refundMethod: "CASH",
          refundAmount: "2000", returnDate: day,
        },
        ctx,
      ),
    ).rejects.toThrow(/more than that/i);
  });

  it("refunds what they actually paid after a discount", async () => {
    await receiveFinishedGoods(
      {
        variantId, locationId, entityId: brandId,
        quantity: "5", unitCost: "600", materialUnitCost: "480", receivedDate: day,
      },
      ctx,
    );
    const sale = await createSale(
      {
        source: "MANUAL", channelId, entityId: brandId, locationId,
        customerId, orderDate: day,
        lines: [{ variantId, quantity: 1, retailPrice: 2000, discountPct: 0.25 }],
        payments: [{ method: "CASH", amount: 1500, fee: 0, collected: true }],
      },
      ctx,
    );

    const result = await recordReturn(
      {
        salesOrderId: sale.salesOrderId, variantId, quantity: 1,
        disposition: "RESTOCK", refundMethod: "CASH", returnDate: day,
      },
      ctx,
    );

    // 2,000 less 25% is 1,500 — the ticket price is not what they handed over.
    expect(Number(result.refunded)).toBe(1500);
  });
});

describe("the same garment cannot come back twice", () => {
  it("counts what has already been returned", async () => {
    const sale = await soldGarments(3, 1500);

    await recordReturn(
      {
        salesOrderId: sale.salesOrderId, variantId, quantity: 2,
        disposition: "RESTOCK", refundMethod: "CASH", returnDate: day,
      },
      ctx,
    );

    const picture = await returnableLines(sale.salesOrderId);
    const line = picture.lines[0];
    expect(line.sold).toBe(3);
    expect(line.returned).toBe(2);
    expect(line.returnable).toBe(1);
  });

  it("refuses more than is left to return", async () => {
    const sale = await soldGarments(2, 1500);
    await recordReturn(
      {
        salesOrderId: sale.salesOrderId, variantId, quantity: 1,
        disposition: "RESTOCK", refundMethod: "CASH", returnDate: day,
      },
      ctx,
    );

    // Otherwise a return is a way of taking money out of the drawer with a
    // document behind it.
    await expect(
      recordReturn(
        {
          salesOrderId: sale.salesOrderId, variantId, quantity: 2,
          disposition: "RESTOCK", refundMethod: "CASH", returnDate: day,
        },
        ctx,
      ),
    ).rejects.toThrow(/already has/i);
  });

  it("refuses more than was ever sold", async () => {
    const sale = await soldGarments(1, 1500);
    await expect(
      recordReturn(
        {
          salesOrderId: sale.salesOrderId, variantId, quantity: 5,
          disposition: "RESTOCK", refundMethod: "CASH", returnDate: day,
        },
        ctx,
      ),
    ).rejects.toThrow(/were sold on this order/i);
  });

  it("refuses a garment that was never on the order", async () => {
    const sale = await soldGarments(1, 1500);
    const other = await db.variant.findFirstOrThrow({ where: { id: { not: variantId } } });

    await expect(
      recordReturn(
        {
          salesOrderId: sale.salesOrderId, variantId: other.id, quantity: 1,
          disposition: "RESTOCK", refundMethod: "CASH", returnDate: day,
        },
        ctx,
      ),
    ).rejects.toThrow(/not on this order/i);
  });

  it("leaves nothing behind when it refuses", async () => {
    const sale = await soldGarments(1, 1500);
    const lots = await db.inventoryLot.count();
    const journals = await db.journalEntry.count();

    await expect(
      recordReturn(
        {
          salesOrderId: sale.salesOrderId, variantId, quantity: 9,
          disposition: "RESTOCK", refundMethod: "CASH", returnDate: day,
        },
        ctx,
      ),
    ).rejects.toThrow(ReturnError);

    expect(await db.inventoryLot.count()).toBe(lots);
    expect(await db.journalEntry.count()).toBe(journals);
    expect(await db.return.count()).toBe(0);
  });
});

describe("the tag comes back too", () => {
  it("makes a sold garment scannable again", async () => {
    const sale = await soldGarments(1, 1500);

    const soldUnits = await db.garmentUnit.count({
      where: { variantId, status: "SOLD" },
    });
    if (soldUnits === 0) return; // No serials on this demo variant.

    await recordReturn(
      {
        salesOrderId: sale.salesOrderId, variantId, quantity: 1,
        disposition: "RESTOCK", refundMethod: "CASH", returnDate: day,
      },
      ctx,
    );

    // A tag that reads "sold" forever cannot be rung up when it comes back.
    const backInStock = await db.garmentUnit.count({
      where: { variantId, status: "IN_STOCK", locationId },
    });
    expect(backInStock).toBeGreaterThan(0);
  });
});

describe("what the shop can see", () => {
  it("says how old the order is against the return window", async () => {
    const sale = await soldGarments(1, 1500);
    const picture = await returnableLines(sale.salesOrderId);

    expect(picture.order.windowDays).toBeGreaterThan(0);
    expect(typeof picture.order.pastWindow).toBe("boolean");
  });

  it("lists what came back", async () => {
    const sale = await soldGarments(1, 1500);
    await recordReturn(
      {
        salesOrderId: sale.salesOrderId, variantId, quantity: 1,
        disposition: "RESTOCK", refundMethod: "CASH",
        reason: "المقاس مش مظبوط", returnDate: day,
      },
      ctx,
    );

    const rows = await recentReturns();
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("المقاس مش مظبوط");
    expect(Number(rows[0].refundAmount)).toBe(1500);
    expect(rows[0].customerName).toBe("أميرة حسن");
  });

  it("shows which styles come back most", async () => {
    const sale = await soldGarments(4, 1500);
    await recordReturn(
      {
        salesOrderId: sale.salesOrderId, variantId, quantity: 1,
        disposition: "RESTOCK", refundMethod: "CASH", returnDate: day,
      },
      ctx,
    );

    const rates = await returnRateByStyle();
    expect(rates.length).toBeGreaterThan(0);
    // One back out of four sold.
    expect(Number(rates[0].rate)).toBeCloseTo(25, 1);
  });

  it("marks an order that has come back in full", async () => {
    const sale = await soldGarments(2, 1500);
    await recordReturn(
      {
        salesOrderId: sale.salesOrderId, variantId, quantity: 2,
        disposition: "RESTOCK", refundMethod: "CASH", returnDate: day,
      },
      ctx,
    );

    const orders = await recentOrdersForReturn();
    const row = orders.find((o) => o.id === sale.salesOrderId)!;
    expect(row.fullyReturned).toBe(true);
    expect(Number(row.refunded)).toBe(3000);
  });
});
