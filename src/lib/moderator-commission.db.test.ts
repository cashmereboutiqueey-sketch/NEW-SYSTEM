import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import {
  setModeratorRate,
  endModeratorRate,
  accrueCommissionForOrder,
  reverseCommissionForReturn,
  settleModerator,
  moderatorPositions,
  totalOwedToModerators,
  CommissionError,
} from "./moderator-commission";
import { dec } from "./money";

/**
 * Paying somebody for the orders they brought in, against a real ledger.
 *
 * Everything here defends one rule, which is the owner's: the commission is
 * earned when the customer's money is in, not when the order is written. The
 * whole point of that rule is the parcel that comes back, so most of what
 * follows is about money that did not arrive, or arrived and then left again.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const ctx = { userId: null as string | null, reason: null };

let brandId: string;
let locationId: string;
let channelId: string;
let customerId: string;
let variantId: string;
let day: Date;
let moderatorId: string;

/** What an account's balance is, debits positive. */
async function balance(code: string): Promise<number> {
  const account = await db.account.findUniqueOrThrow({ where: { code } });
  const sum = await db.journalLine.aggregate({
    where: { accountId: account.id },
    _sum: { debit: true, credit: true },
  });
  return dec(sum._sum.debit ?? 0).minus(dec(sum._sum.credit ?? 0)).toNumber();
}

beforeAll(async () => {
  brandId = (await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } })).id;
  locationId = (await db.location.findFirstOrThrow({ where: { entityId: brandId, isActive: true } })).id;
  channelId = (await db.salesChannel.findFirstOrThrow({})).id;
  customerId = (await db.customer.findFirstOrThrow({})).id;
  variantId = (await db.variant.findFirstOrThrow({})).id;

  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" },
    orderBy: { startDate: "asc" },
  });
  day = new Date(period.startDate);

  moderatorId = (
    await db.user.upsert({
      where: { email: "commission-test@example.com" },
      update: {},
      create: {
        email: "commission-test@example.com",
        name: "Commission Test Moderator",
        passwordHash: "x",
        role: "MODERATOR",
      },
    })
  ).id;
});

async function wipe() {
  await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
  await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
  try {
    await db.moderatorCommission.deleteMany({});
    await db.moderatorSettlement.deleteMany({});
    await db.moderatorRate.deleteMany({});
    await db.salesPayment.deleteMany({});
    await db.salesOrderLine.deleteMany({});
    await db.salesOrder.deleteMany({});
    await db.journalLine.deleteMany({});
    await db.journalEntry.deleteMany({});
    await db.documentSequence.deleteMany({});
    await db.auditLog.deleteMany({});
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
  }
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await db.user.deleteMany({ where: { email: "commission-test@example.com" } });
  await db.$disconnect();
});

/**
 * An order written straight into the table.
 *
 * Deliberately not through `createSale`: this file is about what the
 * commission does with an order, and going through the whole sales engine
 * would make a failure here ambiguous between the two.
 */
async function anOrder(opts: {
  pieces: number;
  net: string;
  collected: boolean;
  shipping?: string;
  by?: string | null;
}) {
  const order = await db.salesOrder.create({
    data: {
      orderNumber: `TEST-${Math.random().toString(36).slice(2, 10)}`,
      channelId,
      customerId,
      entityId: brandId,
      locationId,
      source: "MODERATOR",
      status: "DELIVERED",
      createdByUserId: opts.by === undefined ? moderatorId : opts.by,
      orderDate: day,
      grossAmount: opts.net,
      netAmount: opts.net,
      shippingAmount: opts.shipping ?? "0",
      collectedDate: opts.collected ? day : null,
      lines: {
        create: [
          {
            variantId,
            quantity: opts.pieces,
            retailPrice: dec(opts.net).dividedBy(opts.pieces).toString(),
            netPrice: dec(opts.net).dividedBy(opts.pieces).toString(),
            lineTotal: opts.net,
            unitCost: "0",
            lineCost: "0",
          },
        ],
      },
      payments: {
        create: [
          {
            method: "CASH",
            amount: dec(opts.net).plus(dec(opts.shipping ?? 0)).toString(),
            fee: "0",
            status: opts.collected ? "COLLECTED" : "PENDING",
            collectedAt: opts.collected ? day : null,
          },
        ],
      },
    },
  });
  return order;
}

const tenAPiece = () =>
  setModeratorRate(
    { userId: moderatorId, perPieceAmount: "10", percentOfNet: "0", effectiveFrom: day },
    ctx,
  );

describe("putting somebody on a rate", () => {
  it("stores the percentage as a fraction, not as a number of per cents", () => {
    // 5 typed on screen is 0.05 in the books, and getting this backwards pays
    // somebody five times the order.
    return setModeratorRate(
      { userId: moderatorId, perPieceAmount: "0", percentOfNet: "5", effectiveFrom: day },
      ctx,
    ).then(async () => {
      const rate = await db.moderatorRate.findFirstOrThrow({ where: { userId: moderatorId } });
      expect(Number(rate.percentOfNet)).toBeCloseTo(0.05, 6);
    });
  });

  it("closes the old rate the day before the new one, rather than editing it", async () => {
    await tenAPiece();
    const later = new Date(day.getTime() + 30 * 86_400_000);
    await setModeratorRate(
      { userId: moderatorId, perPieceAmount: "15", percentOfNet: "0", effectiveFrom: later },
      ctx,
    );

    const rates = await db.moderatorRate.findMany({
      where: { userId: moderatorId },
      orderBy: { effectiveFrom: "asc" },
    });
    expect(rates).toHaveLength(2);
    expect(rates[0].effectiveTo).not.toBeNull();
    expect(rates[0].effectiveTo!.getTime()).toBe(later.getTime() - 86_400_000);
    expect(rates[1].effectiveTo).toBeNull();
  });

  it("refuses a rate of nothing, which is a way of saying nothing", async () => {
    await expect(
      setModeratorRate(
        { userId: moderatorId, perPieceAmount: "0", percentOfNet: "0", effectiveFrom: day },
        ctx,
      ),
    ).rejects.toThrow(CommissionError);
  });
});

describe("earning it", () => {
  it("pays nothing on an order whose money has not arrived", async () => {
    await tenAPiece();
    const order = await anOrder({ pieces: 3, net: "1500", collected: false });

    expect(await accrueCommissionForOrder(order.id, ctx)).toBeNull();
    expect(await db.moderatorCommission.count()).toBe(0);
  });

  it("pays on the same order the moment the money is in", async () => {
    await tenAPiece();
    const order = await anOrder({ pieces: 3, net: "1500", collected: true });

    const result = await accrueCommissionForOrder(order.id, ctx);
    expect(Number(result?.amount)).toBeCloseTo(30, 2);
  });

  it("books it as an expense and a debt, not as money going out", async () => {
    await tenAPiece();
    const order = await anOrder({ pieces: 3, net: "1500", collected: true });
    await accrueCommissionForOrder(order.id, ctx);

    // Expense up, liability up. Nothing has left the drawer.
    expect(await balance("6250")).toBeCloseTo(30, 2);
    expect(await balance("2510")).toBeCloseTo(-30, 2);
    expect(await balance("1115")).toBeCloseTo(0, 2);
  });

  it("writes nothing the second time it is called", async () => {
    await tenAPiece();
    const order = await anOrder({ pieces: 3, net: "1500", collected: true });

    await accrueCommissionForOrder(order.id, ctx);
    expect(await accrueCommissionForOrder(order.id, ctx)).toBeNull();
    expect(await db.moderatorCommission.count()).toBe(1);
    expect(await balance("6250")).toBeCloseTo(30, 2);
  });

  it("ignores shipping, so a further parcel is not a better sale", async () => {
    await setModeratorRate(
      { userId: moderatorId, perPieceAmount: "0", percentOfNet: "10", effectiveFrom: day },
      ctx,
    );
    const order = await anOrder({ pieces: 1, net: "1000", shipping: "200", collected: true });
    const result = await accrueCommissionForOrder(order.id, ctx);
    // 10% of the net thousand, not of the twelve hundred collected.
    expect(Number(result?.amount)).toBeCloseTo(100, 2);
  });

  it("pays nobody on an order nobody is recorded as taking", async () => {
    await tenAPiece();
    const order = await anOrder({ pieces: 3, net: "1500", collected: true, by: null });
    expect(await accrueCommissionForOrder(order.id, ctx)).toBeNull();
  });

  it("pays nothing to somebody who was not on a rate that day", async () => {
    const order = await anOrder({ pieces: 3, net: "1500", collected: true });
    expect(await accrueCommissionForOrder(order.id, ctx)).toBeNull();

    // Put on a rate starting tomorrow: the order collected today still earns
    // nothing, because that is not what they were on when it was collected.
    await setModeratorRate(
      {
        userId: moderatorId,
        perPieceAmount: "10",
        percentOfNet: "0",
        effectiveFrom: new Date(day.getTime() + 86_400_000),
      },
      ctx,
    );
    expect(await accrueCommissionForOrder(order.id, ctx)).toBeNull();
  });

  it("keeps the rate it was paid at, so a later raise does not rewrite it", async () => {
    await tenAPiece();
    const order = await anOrder({ pieces: 2, net: "1000", collected: true });
    await accrueCommissionForOrder(order.id, ctx);

    await setModeratorRate(
      {
        userId: moderatorId,
        perPieceAmount: "50",
        percentOfNet: "0",
        effectiveFrom: new Date(day.getTime() + 86_400_000),
      },
      ctx,
    );

    const line = await db.moderatorCommission.findFirstOrThrow();
    expect(Number(line.perPieceAmount)).toBeCloseTo(10, 2);
    expect(Number(line.amount)).toBeCloseTo(20, 2);
  });
});

describe("when the goods come back", () => {
  it("takes back what the returned pieces were worth", async () => {
    await tenAPiece();
    const order = await anOrder({ pieces: 5, net: "2500", collected: true });
    await accrueCommissionForOrder(order.id, ctx);

    const result = await reverseCommissionForReturn(
      { returnId: "rtn-1", salesOrderId: order.id, piecesReturned: 2, netRefunded: "1000" },
      ctx,
    );
    expect(Number(result?.amount)).toBeCloseTo(-20, 2);
    expect(Number((await totalOwedToModerators()).toString())).toBeCloseTo(30, 2);
  });

  it("unwinds the books rather than leaving the expense standing", async () => {
    await tenAPiece();
    const order = await anOrder({ pieces: 5, net: "2500", collected: true });
    await accrueCommissionForOrder(order.id, ctx);
    await reverseCommissionForReturn(
      { returnId: "rtn-1", salesOrderId: order.id, piecesReturned: 5, netRefunded: "2500" },
      ctx,
    );

    expect(await balance("6250")).toBeCloseTo(0, 2);
    expect(await balance("2510")).toBeCloseTo(0, 2);
  });

  it("never takes back more than was earned, however the return is typed", async () => {
    await tenAPiece();
    const order = await anOrder({ pieces: 2, net: "1000", collected: true });
    await accrueCommissionForOrder(order.id, ctx);

    await reverseCommissionForReturn(
      { returnId: "rtn-a", salesOrderId: order.id, piecesReturned: 2, netRefunded: "1000" },
      ctx,
    );
    await reverseCommissionForReturn(
      { returnId: "rtn-b", salesOrderId: order.id, piecesReturned: 2, netRefunded: "1000" },
      ctx,
    );

    const owed = await totalOwedToModerators();
    expect(Number(owed.toString())).toBeCloseTo(0, 2);
    expect(owed.greaterThanOrEqualTo(0)).toBe(true);
  });

  it("writes nothing twice for the same return", async () => {
    await tenAPiece();
    const order = await anOrder({ pieces: 5, net: "2500", collected: true });
    await accrueCommissionForOrder(order.id, ctx);

    await reverseCommissionForReturn(
      { returnId: "rtn-1", salesOrderId: order.id, piecesReturned: 1, netRefunded: "500" },
      ctx,
    );
    expect(
      await reverseCommissionForReturn(
        { returnId: "rtn-1", salesOrderId: order.id, piecesReturned: 1, netRefunded: "500" },
        ctx,
      ),
    ).toBeNull();
    expect(await db.moderatorCommission.count({ where: { kind: "REVERSED" } })).toBe(1);
  });

  it("takes nothing back on an order that never earned anything", async () => {
    const order = await anOrder({ pieces: 3, net: "1500", collected: true });
    expect(
      await reverseCommissionForReturn(
        { returnId: "rtn-1", salesOrderId: order.id, piecesReturned: 3, netRefunded: "1500" },
        ctx,
      ),
    ).toBeNull();
  });
});

describe("paying it over", () => {
  it("clears the debt and takes the money out of the drawer", async () => {
    await tenAPiece();
    const order = await anOrder({ pieces: 3, net: "1500", collected: true });
    await accrueCommissionForOrder(order.id, ctx);

    const result = await settleModerator(
      { userId: moderatorId, method: "CASH", paidOn: day },
      ctx,
    );
    expect(Number(result.amount)).toBeCloseTo(30, 2);
    expect(result.number).toMatch(/^MCS-/);

    // The debt is gone, the expense stays where it was, and the cash left.
    expect(await balance("2510")).toBeCloseTo(0, 2);
    expect(await balance("6250")).toBeCloseTo(30, 2);
    expect(await balance("1115")).toBeCloseTo(-30, 2);
  });

  it("claims the lines it paid, so a second settlement finds nothing", async () => {
    await tenAPiece();
    const order = await anOrder({ pieces: 3, net: "1500", collected: true });
    await accrueCommissionForOrder(order.id, ctx);
    await settleModerator({ userId: moderatorId, method: "CASH", paidOn: day }, ctx);

    await expect(
      settleModerator({ userId: moderatorId, method: "CASH", paidOn: day }, ctx),
    ).rejects.toThrow(/Nothing is owed/i);
  });

  it("pays the earnings net of what came back", async () => {
    await tenAPiece();
    const order = await anOrder({ pieces: 5, net: "2500", collected: true });
    await accrueCommissionForOrder(order.id, ctx);
    await reverseCommissionForReturn(
      { returnId: "rtn-1", salesOrderId: order.id, piecesReturned: 2, netRefunded: "1000" },
      ctx,
    );

    const result = await settleModerator({ userId: moderatorId, method: "CASH", paidOn: day }, ctx);
    expect(Number(result.amount)).toBeCloseTo(30, 2);
    expect(result.lines).toBe(2);
  });

  it("refuses to pay when returns have cancelled the earnings out", async () => {
    await tenAPiece();
    const order = await anOrder({ pieces: 2, net: "1000", collected: true });
    await accrueCommissionForOrder(order.id, ctx);
    await reverseCommissionForReturn(
      { returnId: "rtn-1", salesOrderId: order.id, piecesReturned: 2, netRefunded: "1000" },
      ctx,
    );

    await expect(
      settleModerator({ userId: moderatorId, method: "CASH", paidOn: day }, ctx),
    ).rejects.toThrow(/nothing to pay/i);
  });
});

describe("what the screen reads back", () => {
  it("shows the rate, what was earned, what came back and what is owed", async () => {
    await tenAPiece();
    const first = await anOrder({ pieces: 3, net: "1500", collected: true });
    const second = await anOrder({ pieces: 2, net: "1000", collected: true });
    await accrueCommissionForOrder(first.id, ctx);
    await accrueCommissionForOrder(second.id, ctx);
    await reverseCommissionForReturn(
      { returnId: "rtn-1", salesOrderId: first.id, piecesReturned: 1, netRefunded: "500" },
      ctx,
    );

    const me = (await moderatorPositions()).find((p) => p.userId === moderatorId)!;
    expect(Number(me.perPieceAmount)).toBeCloseTo(10, 2);
    expect(me.orders).toBe(2);
    expect(Number(me.earned.toString())).toBeCloseTo(50, 2);
    expect(Number(me.clawedBack.toString())).toBeCloseTo(10, 2);
    expect(Number(me.owed.toString())).toBeCloseTo(40, 2);
  });

  it("keeps somebody taken off commission, and what they earned before", async () => {
    await tenAPiece();
    const order = await anOrder({ pieces: 3, net: "1500", collected: true });
    await accrueCommissionForOrder(order.id, ctx);
    await endModeratorRate({ userId: moderatorId, lastDay: day }, ctx);

    const me = (await moderatorPositions()).find((p) => p.userId === moderatorId)!;
    expect(me.perPieceAmount).toBeNull();
    expect(Number(me.owed.toString())).toBeCloseTo(30, 2);
  });
});
