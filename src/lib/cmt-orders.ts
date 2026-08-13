import "server-only";
import { db } from "./db";
import { dec, roundMoney, type Decimal } from "./money";
import { nextDocumentNumber } from "./ledger";
import { writeAudit, type AuditContext } from "./audit";

/**
 * An accepted quote becomes an order.
 *
 * The quotes screen could mark a quote ACCEPTED and nothing happened. The
 * cmt_orders table had no writer, so an accepted quote was a status and not a
 * commitment: nothing reserved the minutes, nothing tracked whether the run
 * came in on the minutes it was priced at, and the factory could accept more
 * external work than it had capacity to do while the screen showed it as free.
 *
 * Confirming an order books the minutes against the period. That is the whole
 * point of accepting it — the capacity is spent whether or not anybody wrote
 * it down, and only writing it down makes the next quote honest.
 *
 * The agreed rate is frozen onto the order. A minute rate recalculated next
 * month must not retrospectively change what a client agreed to pay.
 */

export class CMTOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CMTOrderError";
  }
}

/**
 * Turn an accepted quote into a confirmed order.
 *
 * Only from ACCEPTED: an order raised off a draft or a rejected quote is a
 * commitment nobody made.
 */
export async function confirmOrder(
  input: { quoteId: string; orderDate: Date; dueDate?: Date | null },
  ctx: AuditContext,
) {
  const quote = await db.cMTQuote.findUnique({
    where: { id: input.quoteId },
    include: {
      client: { select: { id: true, code: true, name: true } },
      minuteRatePeriod: { select: { fiscalPeriodId: true } },
      orders: { select: { id: true, orderNumber: true } },
    },
  });
  if (!quote) throw new CMTOrderError("That quote no longer exists.");

  if (quote.status !== "ACCEPTED") {
    throw new CMTOrderError(
      `Quote ${quote.quoteNumber} is ${quote.status.toLowerCase()}. Only an accepted quote becomes an order.`,
    );
  }
  if (quote.orders.length > 0) {
    // Confirming twice would book the minutes twice and show capacity the
    // factory does not have as already spent.
    throw new CMTOrderError(
      `Quote ${quote.quoteNumber} is already order ${quote.orders[0].orderNumber}.`,
    );
  }

  return db.$transaction(async (tx) => {
    const orderNumber = await nextDocumentNumber(tx, "CMT", input.orderDate);

    const order = await tx.cMTOrder.create({
      data: {
        orderNumber,
        clientId: quote.clientId,
        quoteId: quote.id,
        status: "CONFIRMED",
        quantity: quote.quantity,
        smvPerUnit: quote.smvPerUnit,
        totalMinutes: quote.totalMinutes,
        // Frozen: a rate recalculated next month must not change what the
        // client agreed to pay.
        agreedMinuteRate: quote.quotedMinuteRate,
        contractValue: quote.quotedTotal,
        orderDate: input.orderDate,
        dueDate: input.dueDate ?? null,
      },
    });

    // The minutes are spent whether or not anybody writes them down. Writing
    // them down is what makes the next quote honest about what is left.
    await tx.capacityBooking.create({
      data: {
        fiscalPeriodId: quote.minuteRatePeriod.fiscalPeriodId,
        source: "CMT_ORDER",
        cmtOrderId: order.id,
        minutes: quote.totalMinutes,
        notes: `CMT ${orderNumber} — ${quote.client.name}`,
      },
    });

    await writeAudit(tx, {
      action: "CMT_ORDER_CONFIRMED",
      entityName: "CMTOrder",
      entityId: order.id,
      ctx,
      after: {
        orderNumber,
        quote: quote.quoteNumber,
        client: quote.client.code,
        quantity: quote.quantity,
        totalMinutes: quote.totalMinutes.toString(),
        contractValue: quote.quotedTotal.toString(),
      },
    });

    return {
      cmtOrderId: order.id,
      orderNumber,
      contractValue: quote.quotedTotal.toString(),
      minutesBooked: quote.totalMinutes.toString(),
    };
  });
}

/**
 * Close a run out against what it actually took.
 *
 * The realised margin is the point. A quote priced at 39 minutes a garment
 * that took 47 was not profitable at the rate quoted, and until the actual
 * minutes are recorded nobody can say so — which is how a factory ends up
 * repeating the job that lost it money.
 */
export async function completeOrder(
  input: { cmtOrderId: string; actualMinutes: number | string; completedAt: Date },
  ctx: AuditContext,
) {
  const order = await db.cMTOrder.findUnique({
    where: { id: input.cmtOrderId },
    include: { client: { select: { code: true } } },
  });
  if (!order) throw new CMTOrderError("That order no longer exists.");
  if (order.status === "COMPLETED") {
    throw new CMTOrderError(`${order.orderNumber} is already closed.`);
  }
  if (order.status === "CANCELLED") {
    throw new CMTOrderError(`${order.orderNumber} was cancelled.`);
  }

  const actualMinutes = dec(input.actualMinutes);
  if (actualMinutes.lessThanOrEqualTo(0)) {
    throw new CMTOrderError("A completed run took some minutes. Record how many.");
  }

  // Costed at the rate the factory actually runs at, not at the rate quoted:
  // the quote is what the client pays, the minute rate is what it costs.
  const rate = await currentMinuteRate(order.orderDate);
  const actualCost = roundMoney(actualMinutes.times(rate));
  const realisedMargin = roundMoney(dec(order.contractValue).minus(actualCost));

  const updated = await db.cMTOrder.update({
    where: { id: order.id },
    data: {
      status: "COMPLETED",
      actualMinutes: actualMinutes.toString(),
      actualCost: actualCost.toString(),
      realisedMargin: realisedMargin.toString(),
      completedAt: input.completedAt,
    },
  });

  await writeAudit(db, {
    action: "CMT_ORDER_COMPLETED",
    entityName: "CMTOrder",
    entityId: order.id,
    ctx,
    before: { status: order.status },
    after: {
      orderNumber: order.orderNumber,
      quotedMinutes: order.totalMinutes.toString(),
      actualMinutes: actualMinutes.toString(),
      actualCost: actualCost.toString(),
      realisedMargin: realisedMargin.toString(),
    },
  });

  return {
    orderNumber: updated.orderNumber,
    actualCost: actualCost.toString(),
    realisedMargin: realisedMargin.toString(),
    /** Over the minutes it was sold on. Positive means the run overran. */
    minutesOverrun: actualMinutes.minus(dec(order.totalMinutes)).toString(),
  };
}

async function currentMinuteRate(when: Date): Promise<Decimal> {
  const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });
  const period = await db.minuteRatePeriod.findFirst({
    where: {
      entityId: factory.id,
      fiscalPeriod: { startDate: { lte: when }, endDate: { gte: when } },
    },
    orderBy: { calculatedAt: "desc" },
  });
  if (!period) {
    throw new CMTOrderError(
      "No minute rate has been calculated for that period, so the run cannot be costed.",
    );
  }
  return dec(period.actualMinuteRate);
}

export async function cancelOrder(
  input: { cmtOrderId: string; reason: string },
  ctx: AuditContext,
) {
  const order = await db.cMTOrder.findUnique({ where: { id: input.cmtOrderId } });
  if (!order) throw new CMTOrderError("That order no longer exists.");
  if (order.status === "COMPLETED") {
    throw new CMTOrderError("A completed run cannot be cancelled. It already happened.");
  }
  if (!input.reason.trim()) {
    throw new CMTOrderError("Cancelling an order needs a reason.");
  }

  return db.$transaction(async (tx) => {
    await tx.cMTOrder.update({
      where: { id: order.id },
      data: { status: "CANCELLED" },
    });

    // The minutes go back: capacity that is no longer committed is capacity
    // the factory can sell again, and leaving the booking would turn down
    // work it could actually take.
    await tx.capacityBooking.deleteMany({ where: { cmtOrderId: order.id } });

    await writeAudit(tx, {
      action: "CMT_ORDER_CANCELLED",
      entityName: "CMTOrder",
      entityId: order.id,
      ctx,
      before: { status: order.status },
      after: { status: "CANCELLED", reason: input.reason },
    });

    return { orderNumber: order.orderNumber, minutesReleased: order.totalMinutes.toString() };
  });
}

/** Orders with how they turned out against how they were sold. */
export async function cmtOrders(limit = 50) {
  const orders = await db.cMTOrder.findMany({
    include: {
      client: { select: { code: true, name: true } },
      quote: { select: { quoteNumber: true, styleDescription: true } },
    },
    orderBy: { orderDate: "desc" },
    take: limit,
  });

  return orders.map((o) => {
    const overrun = o.actualMinutes
      ? dec(o.actualMinutes).minus(dec(o.totalMinutes))
      : null;

    return {
      id: o.id,
      orderNumber: o.orderNumber,
      quoteNumber: o.quote?.quoteNumber ?? null,
      description: o.quote?.styleDescription ?? "—",
      clientCode: o.client.code,
      clientName: o.client.name,
      status: o.status,
      quantity: o.quantity,
      totalMinutes: o.totalMinutes.toString(),
      agreedMinuteRate: o.agreedMinuteRate.toString(),
      contractValue: o.contractValue.toString(),
      actualMinutes: o.actualMinutes?.toString() ?? null,
      actualCost: o.actualCost?.toString() ?? null,
      realisedMargin: o.realisedMargin?.toString() ?? null,
      marginPct:
        o.realisedMargin && dec(o.contractValue).greaterThan(0)
          ? dec(o.realisedMargin).div(dec(o.contractValue)).toString()
          : null,
      minutesOverrun: overrun?.toString() ?? null,
      overrunPct:
        overrun && dec(o.totalMinutes).greaterThan(0)
          ? overrun.div(dec(o.totalMinutes)).toString()
          : null,
      orderDate: o.orderDate,
      dueDate: o.dueDate,
      completedAt: o.completedAt,
    };
  });
}

/** Accepted quotes that have not been turned into an order yet. */
export async function confirmableQuotes() {
  const quotes = await db.cMTQuote.findMany({
    where: { status: "ACCEPTED", orders: { none: {} } },
    include: { client: { select: { code: true, name: true } } },
    orderBy: { quoteDate: "desc" },
  });

  return quotes.map((q) => ({
    id: q.id,
    quoteNumber: q.quoteNumber,
    description: q.styleDescription,
    clientCode: q.client.code,
    clientName: q.client.name,
    quantity: q.quantity,
    totalMinutes: q.totalMinutes.toString(),
    quotedTotal: q.quotedTotal.toString(),
  }));
}
