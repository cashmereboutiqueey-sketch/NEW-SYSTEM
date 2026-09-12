import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import {
  confirmOrder, completeOrder, cancelOrder, cmtOrders, confirmableQuotes,
  recordDeposit, recordPayment, CMTOrderError,
} from "./cmt-orders";
import { dec } from "./money";

/**
 * An accepted quote becomes an order.
 *
 * Before this, accepting a quote was a status and not a commitment: nothing
 * reserved the minutes, so the factory could take on more external work than
 * it had capacity for while the capacity screen still showed it as free.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const MINUTE_RATE = 1.5;
const QUOTED_RATE = 2.2;
const QUANTITY = 500;
const SMV = 40;
const TOTAL_MINUTES = QUANTITY * SMV; // 20,000
const CONTRACT = TOTAL_MINUTES * QUOTED_RATE; // 44,000

let clientId: string;
let periodId: string;
let ratePeriodId: string;
let factoryId: string;
let ownerId: string;
let day: Date;


beforeAll(async () => {
  factoryId = (await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } })).id;
  ownerId = (await db.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;

  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" },
    orderBy: { startDate: "asc" },
  });
  periodId = period.id;
  day = new Date(period.startDate);

  ratePeriodId = (
    await db.minuteRatePeriod.upsert({
      where: { entityId_fiscalPeriodId: { entityId: factoryId, fiscalPeriodId: periodId } },
      update: { actualMinuteRate: String(MINUTE_RATE) },
      create: {
        entityId: factoryId, fiscalPeriodId: periodId,
        operators: 40, workingDays: "26", hoursPerDay: "9",
        utilisationRate: "0.85", efficiencyRate: "0.75",
        totalConversionCost: "364000", netCostPool: "364000",
        grossAvailableMinutes: "561600", productiveMinutes: "358020",
        actualMinuteRate: String(MINUTE_RATE), fullCapacityMinuteRate: "0.6481",
        idlePenaltyPerMinute: "0.8597", idleMinutes: "203580",
      },
    })
  ).id;

  clientId = (
    await db.cMTClient.upsert({
      where: { code: "CMT-TEST" },
      update: {},
      create: { code: "CMT-TEST", name: "عميل تصنيع للاختبار", creditDays: 30 },
    })
  ).id;
});

async function wipe() {
  await db.capacityBooking.deleteMany({ where: { source: "CMT_ORDER" } });
  await db.cMTPayment.deleteMany({});
  await db.cMTOrder.deleteMany({});
  await db.cMTQuote.deleteMany({});
  await db.documentSequence.deleteMany({});
  // Invoicing posts entries, and a posted entry is immutable by trigger —
  // which is the point of the trigger, and the reason it comes off here.
  await db.$executeRawUnsafe('ALTER TABLE "journal_lines" DISABLE TRIGGER USER');
  await db.$executeRawUnsafe('ALTER TABLE "journal_entries" DISABLE TRIGGER USER');
  try {
    await db.journalLine.deleteMany({});
    await db.journalEntry.deleteMany({});
  } finally {
    await db.$executeRawUnsafe('ALTER TABLE "journal_entries" ENABLE TRIGGER USER');
    await db.$executeRawUnsafe('ALTER TABLE "journal_lines" ENABLE TRIGGER USER');
  }
}

beforeEach(wipe);

afterAll(async () => {
  await wipe();
  await db.cMTClient.deleteMany({ where: { code: "CMT-TEST" } });
  await db.$disconnect();
});

const UNIT_PRICE = SMV * QUOTED_RATE; // 88 a garment

/** What an account holds on the factory's books. */
async function balance(code: string): Promise<number> {
  const rows = await db.journalLine.findMany({
    where: { account: { code }, journalEntry: { status: "POSTED" } },
    select: { debit: true, credit: true },
  });
  return rows.reduce((sum, l) => sum + Number(l.debit) - Number(l.credit), 0);
}

async function quote(status: "DRAFT" | "SENT" | "ACCEPTED" | "REJECTED" = "ACCEPTED") {
  return db.cMTQuote.create({
    data: {
      quoteNumber: `CQ-${Math.random().toString(36).slice(2, 10)}`,
      clientId,
      minuteRatePeriodId: ratePeriodId,
      status,
      styleDescription: "قميص قطن",
      quantity: QUANTITY,
      smvPerUnit: String(SMV),
      totalMinutes: String(TOTAL_MINUTES),
      floorMinuteRate: String(MINUTE_RATE),
      quotedMinuteRate: String(QUOTED_RATE),
      marginOverFloorPct: "0.4667",
      quotedUnitPrice: String(SMV * QUOTED_RATE),
      quotedTotal: String(CONTRACT),
      quoteDate: day,
    },
  });
}

const confirm = (quoteId: string) =>
  confirmOrder({ quoteId, orderDate: day, dueDate: null }, { userId: ownerId, reason: null });

describe("accepting a quote commits the factory", () => {
  it("raises an order carrying the quote's figures", async () => {
    const q = await quote();
    const result = await confirm(q.id);

    expect(Number(result.contractValue)).toBe(CONTRACT);
    expect(Number(result.minutesBooked)).toBe(TOTAL_MINUTES);

    const order = await db.cMTOrder.findFirstOrThrow();
    expect(order.quantity).toBe(QUANTITY);
    expect(order.status).toBe("CONFIRMED");
  });

  it("books the minutes against the period", async () => {
    const q = await quote();
    await confirm(q.id);

    // The capacity is spent whether or not anybody writes it down. Writing it
    // down is what makes the next quote honest about what is left.
    const booking = await db.capacityBooking.findFirstOrThrow({
      where: { source: "CMT_ORDER" },
    });
    expect(Number(booking.minutes)).toBe(TOTAL_MINUTES);
    expect(booking.fiscalPeriodId).toBe(periodId);
  });

  it("freezes the agreed rate onto the order", async () => {
    const q = await quote();
    await confirm(q.id);

    const order = await db.cMTOrder.findFirstOrThrow();
    // A minute rate recalculated next month must not change what the client
    // agreed to pay.
    expect(Number(order.agreedMinuteRate)).toBeCloseTo(QUOTED_RATE, 8);
  });

  it("refuses a quote that was never accepted", async () => {
    const q = await quote("SENT");
    // An order raised off a draft is a commitment nobody made.
    await expect(confirm(q.id)).rejects.toThrow(/only an accepted quote/i);
  });

  it("refuses to confirm the same quote twice", async () => {
    const q = await quote();
    await confirm(q.id);

    // Twice would book the minutes twice and show capacity the factory does
    // not have as already spent.
    await expect(confirm(q.id)).rejects.toThrow(/already order/i);
    expect(await db.capacityBooking.count({ where: { source: "CMT_ORDER" } })).toBe(1);
  });
});

describe("closing the run out", () => {
  it("costs the actual minutes at the factory's own rate, not the quoted one", async () => {
    const q = await quote();
    const order = await confirm(q.id);

    // Ran over: 22,000 minutes against the 20,000 it was sold on.
    const result = await completeOrder(
      { cmtOrderId: order.cmtOrderId, actualMinutes: 22_000, deliveredQty: QUANTITY, completedAt: day },
      { userId: ownerId, reason: null },
    );

    // The quote is what the client pays; the minute rate is what it costs.
    expect(Number(result.actualCost)).toBe(22_000 * MINUTE_RATE); // 33,000
    expect(Number(result.realisedMargin)).toBe(CONTRACT - 33_000); // 11,000
    expect(Number(result.minutesOverrun)).toBe(2_000);
  });

  it("shows a run that came in under as the better margin it was", async () => {
    const q = await quote();
    const order = await confirm(q.id);

    const result = await completeOrder(
      { cmtOrderId: order.cmtOrderId, actualMinutes: 18_000, deliveredQty: QUANTITY, completedAt: day },
      { userId: ownerId, reason: null },
    );

    expect(Number(result.realisedMargin)).toBe(CONTRACT - 27_000); // 17,000
    expect(Number(result.minutesOverrun)).toBe(-2_000);
  });

  it("refuses to close a run that took no minutes", async () => {
    const q = await quote();
    const order = await confirm(q.id);

    await expect(
      completeOrder(
        { cmtOrderId: order.cmtOrderId, actualMinutes: 0, deliveredQty: QUANTITY, completedAt: day },
        { userId: ownerId, reason: null },
      ),
    ).rejects.toThrow(CMTOrderError);
  });

  it("refuses to close the same run twice", async () => {
    const q = await quote();
    const order = await confirm(q.id);
    await completeOrder(
      { cmtOrderId: order.cmtOrderId, actualMinutes: 20_000, deliveredQty: QUANTITY, completedAt: day },
      { userId: ownerId, reason: null },
    );

    await expect(
      completeOrder(
        { cmtOrderId: order.cmtOrderId, actualMinutes: 20_000, deliveredQty: QUANTITY, completedAt: day },
        { userId: ownerId, reason: null },
      ),
    ).rejects.toThrow(/already closed/i);
  });
});

describe("billing the client", () => {
  const deposit = (cmtOrderId: string, amount: number) =>
    recordDeposit(
      { cmtOrderId, amount, method: "BANK_TRANSFER", paidOn: day, reference: "TT-1" },
      { userId: ownerId, reason: null },
    );

  const closeOut = (cmtOrderId: string, deliveredQty = QUANTITY) =>
    completeOrder(
      { cmtOrderId, actualMinutes: 20_000, deliveredQty, completedAt: day },
      { userId: ownerId, reason: null },
    );

  it("invoices the pieces handed over, at the price per piece the quote was accepted at", async () => {
    const order = await confirm((await quote()).id);

    const result = await closeOut(order.cmtOrderId);

    expect(Number(result.invoiced)).toBe(QUANTITY * UNIT_PRICE); // 44,000
    expect(result.invoiceNumber).toMatch(/^CMTI-/);
    // Owed by the client, earned by the factory.
    expect(await balance("1210")).toBeCloseTo(QUANTITY * UNIT_PRICE, 2);
    expect(await balance("4300")).toBeCloseTo(-QUANTITY * UNIT_PRICE, 2);
  });

  it("bills a short delivery short", async () => {
    const order = await confirm((await quote()).id);

    // Ordered 500, handed over 460: the client pays for 460.
    const result = await closeOut(order.cmtOrderId, 460);

    expect(Number(result.invoiced)).toBe(460 * UNIT_PRICE); // 40,480
    // The margin is measured against what was billed, not against the whole
    // contract: garments never delivered were never sold.
    expect(Number(result.realisedMargin)).toBe(460 * UNIT_PRICE - 20_000 * MINUTE_RATE);
  });

  it("refuses to bill more garments than the order is for", async () => {
    const order = await confirm((await quote()).id);

    await expect(closeOut(order.cmtOrderId, QUANTITY + 1)).rejects.toThrow(/more than the 500/i);
  });

  it("holds a deposit as a debt until the goods are handed over", async () => {
    const order = await confirm((await quote()).id);

    await deposit(order.cmtOrderId, 10_000);

    // Money in, and a liability — not revenue, because nothing has been made.
    expect(await balance("1120")).toBeCloseTo(10_000, 2);
    expect(await balance("2410")).toBeCloseTo(-10_000, 2);
    expect(await balance("4300")).toBe(0);
  });

  it("settles the deposit against the invoice, and leaves the rest owed", async () => {
    const order = await confirm((await quote()).id);
    await deposit(order.cmtOrderId, 10_000);

    const result = await closeOut(order.cmtOrderId);

    expect(Number(result.depositApplied)).toBe(10_000);
    expect(Number(result.outstanding)).toBe(QUANTITY * UNIT_PRICE - 10_000); // 34,000
    // The deposit is no longer a debt to the client, and the receivable is
    // what is genuinely still to come.
    expect(await balance("2410")).toBeCloseTo(0, 2);
    expect(await balance("1210")).toBeCloseTo(QUANTITY * UNIT_PRICE - 10_000, 2);
  });

  it("gives the client thirty days for what is left", async () => {
    const order = await confirm((await quote()).id);

    const result = await closeOut(order.cmtOrderId);

    const expected = new Date(day);
    expected.setUTCDate(expected.getUTCDate() + 30);
    expect(result.dueDate.toISOString().slice(0, 10)).toBe(expected.toISOString().slice(0, 10));
  });

  it("collects against the invoice until nothing is owed", async () => {
    const order = await confirm((await quote()).id);
    await deposit(order.cmtOrderId, 10_000);
    await closeOut(order.cmtOrderId);

    const part = await recordPayment(
      { cmtOrderId: order.cmtOrderId, amount: 20_000, method: "INSTAPAY", paidOn: day },
      { userId: ownerId, reason: null },
    );
    expect(Number(part.outstanding)).toBe(14_000);

    const rest = await recordPayment(
      { cmtOrderId: order.cmtOrderId, amount: 14_000, method: "CASH", paidOn: day },
      { userId: ownerId, reason: null },
    );
    expect(Number(rest.outstanding)).toBe(0);
    // Nothing left owed, and the whole invoice has been received.
    expect(await balance("1210")).toBeCloseTo(0, 2);
  });

  it("refuses more money than the invoice is short", async () => {
    const order = await confirm((await quote()).id);
    await closeOut(order.cmtOrderId);

    await expect(
      recordPayment(
        { cmtOrderId: order.cmtOrderId, amount: QUANTITY * UNIT_PRICE + 1, method: "CASH", paidOn: day },
        { userId: ownerId, reason: null },
      ),
    ).rejects.toThrow(/is still owed/i);
  });

  it("refuses a deposit worth more than the whole contract", async () => {
    const order = await confirm((await quote()).id);

    await expect(deposit(order.cmtOrderId, CONTRACT + 1)).rejects.toThrow(/more than the/i);
  });

  it("refuses to collect against an order that has not been invoiced", async () => {
    const order = await confirm((await quote()).id);

    await expect(
      recordPayment(
        { cmtOrderId: order.cmtOrderId, amount: 1_000, method: "CASH", paidOn: day },
        { userId: ownerId, reason: null },
      ),
    ).rejects.toThrow(/has not been invoiced/i);
  });

  it("keeps the books balanced through the whole thing", async () => {
    const order = await confirm((await quote()).id);
    await deposit(order.cmtOrderId, 10_000);
    await closeOut(order.cmtOrderId);
    await recordPayment(
      { cmtOrderId: order.cmtOrderId, amount: 34_000, method: "BANK_TRANSFER", paidOn: day },
      { userId: ownerId, reason: null },
    );

    const rows = await db.journalLine.findMany({
      where: { journalEntry: { status: "POSTED" } },
      select: { debit: true, credit: true },
    });
    const debits = rows.reduce((sum, l) => sum.plus(dec(l.debit)), dec(0));
    const credits = rows.reduce((sum, l) => sum.plus(dec(l.credit)), dec(0));
    expect(debits.toString()).toBe(credits.toString());
  });

  it("shows what is still owed on the list", async () => {
    const order = await confirm((await quote()).id);
    await deposit(order.cmtOrderId, 10_000);
    await closeOut(order.cmtOrderId);

    const row = (await cmtOrders()).find((o) => o.orderNumber === order.orderNumber)!;
    expect(row.invoiceNumber).toMatch(/^CMTI-/);
    expect(Number(row.invoicedAmount)).toBe(QUANTITY * UNIT_PRICE);
    expect(Number(row.depositHeld)).toBe(10_000);
    expect(Number(row.outstanding)).toBe(34_000);
    expect(row.deliveredQty).toBe(QUANTITY);
  });
});

describe("cancelling", () => {
  it("gives the minutes back", async () => {
    const q = await quote();
    const order = await confirm(q.id);

    await cancelOrder(
      { cmtOrderId: order.cmtOrderId, reason: "العميل ألغى" },
      { userId: ownerId, reason: null },
    );

    // Capacity that is no longer committed is capacity the factory can sell
    // again; leaving the booking would turn down work it could take.
    expect(await db.capacityBooking.count({ where: { source: "CMT_ORDER" } })).toBe(0);
  });

  it("insists on a reason", async () => {
    const q = await quote();
    const order = await confirm(q.id);

    await expect(
      cancelOrder({ cmtOrderId: order.cmtOrderId, reason: "  " }, { userId: ownerId, reason: null }),
    ).rejects.toThrow(/needs a reason/i);
  });

  it("will not cancel a run that already happened", async () => {
    const q = await quote();
    const order = await confirm(q.id);
    await completeOrder(
      { cmtOrderId: order.cmtOrderId, actualMinutes: 20_000, deliveredQty: QUANTITY, completedAt: day },
      { userId: ownerId, reason: null },
    );

    await expect(
      cancelOrder({ cmtOrderId: order.cmtOrderId, reason: "غيرت رأيي" }, { userId: ownerId, reason: null }),
    ).rejects.toThrow(/already happened/i);
  });
});

describe("the list", () => {
  it("reports the overrun against what the run was sold on", async () => {
    const q = await quote();
    const order = await confirm(q.id);
    await completeOrder(
      { cmtOrderId: order.cmtOrderId, actualMinutes: 25_000, deliveredQty: QUANTITY, completedAt: day },
      { userId: ownerId, reason: null },
    );

    const rows = await cmtOrders();
    const ours = rows.find((r) => r.id === order.cmtOrderId)!;

    expect(Number(ours.minutesOverrun)).toBe(5_000);
    expect(Number(ours.overrunPct)).toBeCloseTo(0.25, 6);
    expect(Number(ours.marginPct)).toBeCloseTo((CONTRACT - 37_500) / CONTRACT, 6);
  });

  it("offers an accepted quote once and then stops", async () => {
    const q = await quote();
    expect((await confirmableQuotes()).some((c) => c.id === q.id)).toBe(true);

    await confirm(q.id);
    expect((await confirmableQuotes()).some((c) => c.id === q.id)).toBe(false);
  });
});
