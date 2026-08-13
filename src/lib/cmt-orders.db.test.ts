import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import {
  confirmOrder, completeOrder, cancelOrder, cmtOrders, confirmableQuotes, CMTOrderError,
} from "./cmt-orders";

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

const ctx = { userId: null as string | null, reason: null };

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

beforeEach(async () => {
  await db.capacityBooking.deleteMany({ where: { source: "CMT_ORDER" } });
  await db.cMTOrder.deleteMany({});
  await db.cMTQuote.deleteMany({});
  await db.documentSequence.deleteMany({});
});

afterAll(async () => {
  await db.capacityBooking.deleteMany({ where: { source: "CMT_ORDER" } });
  await db.cMTOrder.deleteMany({});
  await db.cMTQuote.deleteMany({});
  await db.cMTClient.deleteMany({ where: { code: "CMT-TEST" } });
  await db.$disconnect();
});

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
      { cmtOrderId: order.cmtOrderId, actualMinutes: 22_000, completedAt: day },
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
      { cmtOrderId: order.cmtOrderId, actualMinutes: 18_000, completedAt: day },
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
        { cmtOrderId: order.cmtOrderId, actualMinutes: 0, completedAt: day },
        { userId: ownerId, reason: null },
      ),
    ).rejects.toThrow(CMTOrderError);
  });

  it("refuses to close the same run twice", async () => {
    const q = await quote();
    const order = await confirm(q.id);
    await completeOrder(
      { cmtOrderId: order.cmtOrderId, actualMinutes: 20_000, completedAt: day },
      { userId: ownerId, reason: null },
    );

    await expect(
      completeOrder(
        { cmtOrderId: order.cmtOrderId, actualMinutes: 20_000, completedAt: day },
        { userId: ownerId, reason: null },
      ),
    ).rejects.toThrow(/already closed/i);
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
      { cmtOrderId: order.cmtOrderId, actualMinutes: 20_000, completedAt: day },
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
      { cmtOrderId: order.cmtOrderId, actualMinutes: 25_000, completedAt: day },
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
