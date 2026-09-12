import "server-only";
import { db } from "./db";
import { dec, roundMoney, type Decimal } from "./money";
import { nextDocumentNumber, postEntry } from "./ledger";
import { writeAudit, type AuditContext } from "./audit";
import { command } from "./command";

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
 * Where an external run's money goes.
 *
 * The client pays for good garments delivered, at the price per piece the
 * quote was accepted at. Minutes decide whether the run was worth doing; they
 * do not decide what the client owes.
 */
const ACC = {
  RECEIVABLE: "1210",
  CMT_REVENUE: "4300",
  CLIENT_DEPOSITS: "2410",
  CASH: "1110",
  BANK: "1120",
} as const;

/** Where the money lands, by how it arrived. */
const FUNDS: Record<string, string> = {
  CASH: ACC.CASH,
  BANK_TRANSFER: ACC.BANK,
  INSTAPAY: ACC.BANK,
  CARD: ACC.BANK,
};

/** Days the client has to settle what is left after the handover. */
const DEFAULT_CREDIT_DAYS = 30;

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

async function accountId(tx: Tx, code: string): Promise<string> {
  const account = await tx.account.findUnique({ where: { code }, select: { id: true } });
  if (!account) throw new CMTOrderError(`Account ${code} is missing from the chart of accounts.`);
  return account.id;
}

/** The factory's own books: external manufacturing is the factory's trade. */
async function factoryId(tx: Tx): Promise<string> {
  const factory = await tx.entity.findFirst({ where: { kind: "FACTORY" }, select: { id: true } });
  if (!factory) throw new CMTOrderError("No factory entity exists to bill this from.");
  return factory.id;
}

function asDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
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
  return command("cmt-orders.confirmOrder", input, ctx, async () => {
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
          // What one garment is billed at. The client is invoiced on pieces
          // delivered, so this is the number that decides what they pay.
          agreedUnitPrice: quote.quotedUnitPrice,
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
  });
}

/**
 * Money taken when the order is placed, before a garment is cut.
 *
 * It is not revenue and it is not the factory's money yet: the work has not
 * been done. It sits as a debt to the client until the goods are handed over,
 * and the invoice then settles against it. Recording it here rather than as a
 * loose receipt is what makes "what is this client still owing" answerable.
 */
export async function recordDeposit(
  input: {
    cmtOrderId: string;
    amount: string | number;
    method: "CASH" | "BANK_TRANSFER" | "INSTAPAY" | "CARD";
    paidOn: Date;
    reference?: string | null;
  },
  ctx: AuditContext,
): Promise<{ orderNumber: string; depositHeld: string }> {
  return command("cmt-orders.recordDeposit", input, ctx, async () => {
    const amount = roundMoney(dec(input.amount));
    if (amount.lessThanOrEqualTo(0)) {
      throw new CMTOrderError("A deposit is an amount of money. Record what was actually received.");
    }
    const fundsCode = FUNDS[input.method];
    if (!fundsCode) throw new CMTOrderError("Choose how the deposit arrived.");

    const order = await db.cMTOrder.findUnique({
      where: { id: input.cmtOrderId },
      include: { client: { select: { code: true, name: true } } },
    });
    if (!order) throw new CMTOrderError("That order no longer exists.");
    if (order.status === "CANCELLED") throw new CMTOrderError(`${order.orderNumber} was cancelled.`);
    if (order.invoicedAt) {
      throw new CMTOrderError(
        `${order.orderNumber} has already been invoiced. Record this against the invoice instead.`,
      );
    }

    // More held than the whole contract is worth is a typing error, and the
    // kind that is only noticed when somebody asks for their money back.
    const held = await depositHeld(db, order.id);
    if (held.plus(amount).greaterThan(dec(order.contractValue))) {
      throw new CMTOrderError(
        `Deposits would come to ${held.plus(amount).toFixed(2)}, more than the ${dec(order.contractValue).toFixed(2)} the order is worth.`,
      );
    }

    const paidOn = asDay(input.paidOn);

    return db.$transaction(async (tx) => {
      const entity = await factoryId(tx);
      const entry = await postEntry(tx, {
        entityId: entity,
        postingDate: paidOn,
        sourceType: "PAYMENT",
        sourceId: order.id,
        memo: `Deposit on ${order.orderNumber} — ${order.client.name}`,
        ctx,
        lines: [
          {
            accountId: await accountId(tx, fundsCode),
            debit: amount,
            entityId: entity,
            description: `${order.client.code} deposit on ${order.orderNumber}`,
          },
          {
            accountId: await accountId(tx, ACC.CLIENT_DEPOSITS),
            credit: amount,
            entityId: entity,
            description: `Held for ${order.client.code} against ${order.orderNumber}`,
          },
        ],
      });

      await tx.cMTPayment.create({
        data: {
          cmtOrderId: order.id,
          kind: "DEPOSIT",
          method: input.method,
          amount: amount.toString(),
          paidOn,
          reference: input.reference ?? null,
          journalEntryId: entry.id,
        },
      });
      await tx.cMTOrder.update({
        where: { id: order.id },
        data: { paidAmount: { increment: amount.toString() } },
      });

      await writeAudit(tx, {
        action: "CMT_DEPOSIT_RECEIVED",
        entityName: "CMTOrder",
        entityId: order.id,
        ctx,
        after: {
          orderNumber: order.orderNumber,
          client: order.client.code,
          amount: amount.toString(),
          method: input.method,
          depositHeld: held.plus(amount).toString(),
          journalEntry: entry.entryNumber,
        },
      });

      return { orderNumber: order.orderNumber, depositHeld: held.plus(amount).toString() };
    });
  });
}

/** What has been taken up front and not yet turned into an invoice. */
async function depositHeld(
  client: typeof db | Tx,
  cmtOrderId: string,
): Promise<Decimal> {
  const taken = await client.cMTPayment.aggregate({
    where: { cmtOrderId, kind: "DEPOSIT" },
    _sum: { amount: true },
  });
  return dec(taken._sum.amount ?? 0);
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
  input: {
    cmtOrderId: string;
    actualMinutes: number | string;
    /** Good garments handed over. The client is billed for these. */
    deliveredQty: number;
    completedAt: Date;
  },
  ctx: AuditContext,
) {
  return command("cmt-orders.completeOrder", input, ctx, async () => {
    const order = await db.cMTOrder.findUnique({
      where: { id: input.cmtOrderId },
      include: { client: { select: { code: true, name: true, creditDays: true } } },
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

    // Billed on pieces handed over, not on pieces ordered: a run that came up
    // short is invoiced short, and one that somehow exceeded the order is a
    // number somebody has to explain before it is billed.
    if (!Number.isInteger(input.deliveredQty) || input.deliveredQty <= 0) {
      throw new CMTOrderError("Record how many good garments were handed over.");
    }
    if (input.deliveredQty > order.quantity) {
      throw new CMTOrderError(
        `${input.deliveredQty} garments is more than the ${order.quantity} this order is for. Raise a separate order for the rest.`,
      );
    }

    // Costed at the rate the factory actually runs at, not at the rate quoted:
    // the quote is what the client pays, the minute rate is what it costs.
    const rate = await currentMinuteRate(order.orderDate);
    const actualCost = roundMoney(actualMinutes.times(rate));
    const invoiced = roundMoney(dec(order.agreedUnitPrice).times(input.deliveredQty));
    // What the run earned is measured against what is actually billed for it,
    // not against the whole contract: garments never delivered were never sold.
    const realisedMargin = roundMoney(invoiced.minus(actualCost));

    const completedAt = asDay(input.completedAt);
    const held = await depositHeld(db, order.id);
    const applied = Decimal_min(held, invoiced);
    const creditDays = order.client.creditDays > 0 ? order.client.creditDays : DEFAULT_CREDIT_DAYS;

    return db.$transaction(async (tx) => {
      const entity = await factoryId(tx);
      const invoiceNumber = await nextDocumentNumber(tx, "CMTI", completedAt);

      const lines = [
        {
          accountId: await accountId(tx, ACC.RECEIVABLE),
          debit: invoiced,
          entityId: entity,
          description: `${order.client.code} — ${invoiceNumber} for ${input.deliveredQty} garments on ${order.orderNumber}`,
        },
        {
          accountId: await accountId(tx, ACC.CMT_REVENUE),
          credit: invoiced,
          entityId: entity,
          description: `External manufacturing for ${order.client.code} (${order.orderNumber})`,
        },
      ];

      // The deposit stops being a debt to the client and becomes payment of
      // this invoice. Anything held beyond the invoice — a run that came up
      // short — stays a debt, because it is still their money.
      if (applied.greaterThan(0)) {
        lines.push(
          {
            accountId: await accountId(tx, ACC.CLIENT_DEPOSITS),
            debit: applied,
            entityId: entity,
            description: `Deposit applied to ${invoiceNumber}`,
          },
          {
            accountId: await accountId(tx, ACC.RECEIVABLE),
            credit: applied,
            entityId: entity,
            description: `${order.client.code} — deposit applied to ${invoiceNumber}`,
          },
        );
      }

      const entry = await postEntry(tx, {
        entityId: entity,
        postingDate: completedAt,
        sourceType: "CMT_INVOICE",
        sourceId: order.id,
        memo: `${invoiceNumber} — ${order.client.name} (${order.orderNumber})`,
        ctx,
        lines,
      });

      const dueDate = new Date(completedAt);
      dueDate.setUTCDate(dueDate.getUTCDate() + creditDays);

      const updated = await tx.cMTOrder.update({
        where: { id: order.id },
        data: {
          status: "COMPLETED",
          actualMinutes: actualMinutes.toString(),
          actualCost: actualCost.toString(),
          realisedMargin: realisedMargin.toString(),
          deliveredQty: input.deliveredQty,
          invoiceNumber,
          invoicedAmount: invoiced.toString(),
          invoicedAt: completedAt,
          dueDate,
          completedAt,
        },
      });

      await writeAudit(tx, {
        action: "CMT_ORDER_COMPLETED",
        entityName: "CMTOrder",
        entityId: order.id,
        ctx,
        before: { status: order.status },
        after: {
          orderNumber: order.orderNumber,
          invoiceNumber,
          quotedMinutes: order.totalMinutes.toString(),
          actualMinutes: actualMinutes.toString(),
          actualCost: actualCost.toString(),
          orderedQty: order.quantity,
          deliveredQty: input.deliveredQty,
          unitPrice: dec(order.agreedUnitPrice).toString(),
          invoiced: invoiced.toString(),
          depositApplied: applied.toString(),
          realisedMargin: realisedMargin.toString(),
          dueDate: dueDate.toISOString().slice(0, 10),
          journalEntry: entry.entryNumber,
        },
      });

      return {
        orderNumber: updated.orderNumber,
        invoiceNumber,
        invoiced: invoiced.toString(),
        depositApplied: applied.toString(),
        /** Still to collect, after the deposit came off. */
        outstanding: invoiced.minus(applied).toString(),
        dueDate,
        actualCost: actualCost.toString(),
        realisedMargin: realisedMargin.toString(),
        /** Over the minutes it was sold on. Positive means the run overran. */
        minutesOverrun: actualMinutes.minus(dec(order.totalMinutes)).toString(),
      };
    });
  });
}

/** The smaller of two amounts. */
function Decimal_min(a: Decimal, b: Decimal): Decimal {
  return a.lessThan(b) ? a : b;
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

/**
 * Money received against the invoice: at the handover, or later.
 *
 * The client pays part on the day and the rest within the agreed days, so
 * collection is a series of receipts rather than one event. Each one settles
 * the receivable the invoice raised.
 */
export async function recordPayment(
  input: {
    cmtOrderId: string;
    amount: string | number;
    method: "CASH" | "BANK_TRANSFER" | "INSTAPAY" | "CARD";
    paidOn: Date;
    reference?: string | null;
  },
  ctx: AuditContext,
): Promise<{ orderNumber: string; paid: string; outstanding: string }> {
  return command("cmt-orders.recordPayment", input, ctx, async () => {
    const amount = roundMoney(dec(input.amount));
    if (amount.lessThanOrEqualTo(0)) {
      throw new CMTOrderError("Record the amount actually received.");
    }
    const fundsCode = FUNDS[input.method];
    if (!fundsCode) throw new CMTOrderError("Choose how the money arrived.");

    const order = await db.cMTOrder.findUnique({
      where: { id: input.cmtOrderId },
      include: { client: { select: { code: true, name: true } } },
    });
    if (!order) throw new CMTOrderError("That order no longer exists.");
    if (!order.invoicedAt || !order.invoicedAmount) {
      throw new CMTOrderError(
        `${order.orderNumber} has not been invoiced yet. Close the run first, or record this as a deposit.`,
      );
    }

    const outstanding = dec(order.invoicedAmount).minus(dec(order.paidAmount));
    if (outstanding.lessThanOrEqualTo(0)) {
      throw new CMTOrderError(`${order.invoiceNumber} is already settled in full.`);
    }
    // Taking more than is owed would leave the client a creditor on an invoice
    // that is paid, which is not a state this can represent honestly.
    if (amount.greaterThan(outstanding)) {
      throw new CMTOrderError(
        `Only ${outstanding.toFixed(2)} is still owed on ${order.invoiceNumber}.`,
      );
    }

    const paidOn = asDay(input.paidOn);

    return db.$transaction(async (tx) => {
      const entity = await factoryId(tx);
      const entry = await postEntry(tx, {
        entityId: entity,
        postingDate: paidOn,
        sourceType: "PAYMENT",
        sourceId: order.id,
        memo: `${order.invoiceNumber} — received from ${order.client.name}`,
        ctx,
        lines: [
          {
            accountId: await accountId(tx, fundsCode),
            debit: amount,
            entityId: entity,
            description: `${order.client.code} paid against ${order.invoiceNumber}`,
          },
          {
            accountId: await accountId(tx, ACC.RECEIVABLE),
            credit: amount,
            entityId: entity,
            description: `${order.client.code} — settled on ${order.invoiceNumber}`,
          },
        ],
      });

      await tx.cMTPayment.create({
        data: {
          cmtOrderId: order.id,
          kind: "SETTLEMENT",
          method: input.method,
          amount: amount.toString(),
          paidOn,
          reference: input.reference ?? null,
          journalEntryId: entry.id,
        },
      });
      const updated = await tx.cMTOrder.update({
        where: { id: order.id },
        data: { paidAmount: { increment: amount.toString() } },
        select: { paidAmount: true, invoicedAmount: true },
      });

      const left = dec(updated.invoicedAmount ?? 0).minus(dec(updated.paidAmount));

      await writeAudit(tx, {
        action: "CMT_PAYMENT_RECEIVED",
        entityName: "CMTOrder",
        entityId: order.id,
        ctx,
        after: {
          orderNumber: order.orderNumber,
          invoiceNumber: order.invoiceNumber,
          client: order.client.code,
          amount: amount.toString(),
          method: input.method,
          outstanding: left.toString(),
          journalEntry: entry.entryNumber,
        },
      });

      return {
        orderNumber: order.orderNumber,
        paid: dec(updated.paidAmount).toString(),
        outstanding: left.toString(),
      };
    });
  });
}

export async function cancelOrder(
  input: { cmtOrderId: string; reason: string },
  ctx: AuditContext,
) {
  return command("cmt-orders.cancelOrder", input, ctx, async () => {
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
  });
}

/** Orders with how they turned out against how they were sold. */
export async function cmtOrders(limit = 50) {
  const orders = await db.cMTOrder.findMany({
    include: {
      client: { select: { code: true, name: true } },
      quote: { select: { quoteNumber: true, styleDescription: true } },
      payments: { select: { kind: true, amount: true } },
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
      // What the client was actually billed, and what is left to collect.
      unitPrice: dec(o.agreedUnitPrice).toString(),
      deliveredQty: o.deliveredQty,
      invoiceNumber: o.invoiceNumber,
      invoicedAmount: o.invoicedAmount?.toString() ?? null,
      invoicedAt: o.invoicedAt,
      depositHeld: o.payments
        .filter((p) => p.kind === "DEPOSIT")
        .reduce((sum, p) => sum.plus(dec(p.amount)), dec(0))
        .toString(),
      paidAmount: dec(o.paidAmount).toString(),
      outstanding: o.invoicedAmount
        ? dec(o.invoicedAmount).minus(dec(o.paidAmount)).toString()
        : null,
      overdue:
        o.invoicedAmount != null &&
        dec(o.invoicedAmount).greaterThan(dec(o.paidAmount)) &&
        o.dueDate != null &&
        o.dueDate < new Date(),
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
