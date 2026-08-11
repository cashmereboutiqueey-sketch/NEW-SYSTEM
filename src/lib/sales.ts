import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "./db";
import { postEntry, nextDocumentNumber } from "./ledger";
import { relieveFinishedGoodsForSale } from "./inventory";
import { markUnitsSold } from "./garment-units";
import { writeAudit, type AuditContext } from "./audit";
import type { DraftLine } from "@/core/ledger";
import { dec, sum, roundMoney } from "./money";
import { outstandingForCustomer as customerOutstanding } from "./receivables";

/**
 * The unified Brand order engine.
 *
 * Shopify, a moderator's DM order and a showroom till all create the same
 * `SalesOrder` and relieve the same FIFO stock. What differs is attribution —
 * source, who entered it, which location, which shift — because those are the
 * only things that let the owner tell which channel actually earns money.
 *
 * Revenue and cost of goods are two separate postings on purpose:
 *
 *   DR cash / receivable / clearing    CR revenue
 *   DR cost of goods sold              CR finished goods
 *
 * Recognising revenue without relieving stock is how a system reports a
 * margin it has not earned.
 */

export class SalesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SalesError";
  }
}

const ACC = {
  CASH: "1110",
  POS_DRAWER: "1115",
  BANK: "1120",
  GATEWAY_CLEARING: "1130",
  COD_CLEARING: "1135",
  RECEIVABLE: "1210",
  /// Money taken before the garment existed: a promise, not income.
  CUSTOMER_DEPOSITS: "2400",
  DISCOUNTS: "4200",
  COGS_BRAND: "5300",
  FG_BRAND: "1340",
  PAYMENT_FEES: "6230",
} as const;

/** Revenue account per source, so channel P&L needs no guesswork. */
const REVENUE_ACCOUNT: Record<string, string> = {
  SHOPIFY: "4110",
  MODERATOR: "4120",
  POS: "4130",
  EXHIBITION: "4140",
  WHOLESALE: "4150",
  MANUAL: "4130",
};

/**
 * Where the money sits before it reaches the bank.
 *
 * Cash on delivery is deliberately *not* cash: the courier holds it until
 * they remit, and treating it as cash on the order date overstates the
 * position by whatever is still in transit.
 */
const FUNDS_ACCOUNT: Record<string, string> = {
  CASH: ACC.POS_DRAWER,
  CARD: ACC.GATEWAY_CLEARING,
  COD: ACC.COD_CLEARING,
  BANK_TRANSFER: ACC.BANK,
  WALLET: ACC.GATEWAY_CLEARING,
  STORE_CREDIT: ACC.RECEIVABLE,
  DEPOSIT: ACC.CUSTOMER_DEPOSITS,
};

/**
 * Where a payment actually sits, which depends on whether it has been
 * collected as well as on how it was taken.
 *
 * A clearing account means somebody else is holding the money, and its balance
 * is what they owe. Sending a payment there when it has already been received
 * leaves it stranded: nothing will ever clear it, and the reconciliation screen
 * reports a courier debt that was settled the moment the sale was rung up.
 */
function fundsAccount(method: string, collected: boolean): string {
  // A deposit is the one method where no money moves now. It arrived weeks
  // ago and has been sitting as a liability ever since; settling the sale
  // with it discharges that promise. Sending it to cash would count the same
  // pound twice — once when it was taken, once when the garment was handed
  // over — and leave the liability standing forever.
  if (method === "DEPOSIT") return ACC.CUSTOMER_DEPOSITS;
  if (!collected) return FUNDS_ACCOUNT[method];
  if (method === "STORE_CREDIT") return ACC.RECEIVABLE;
  if (method === "CASH") return ACC.POS_DRAWER;
  // Collected by any other means means it has reached the bank.
  return ACC.BANK;
}

export const createSaleSchema = z.object({
  source: z.enum(["SHOPIFY", "MODERATOR", "POS", "EXHIBITION", "WHOLESALE", "MANUAL"]),
  channelId: z.string().min(1),
  entityId: z.string().min(1),
  locationId: z.string().min(1),
  customerId: z.string().min(1).nullable().optional(),
  posSessionId: z.string().min(1).nullable().optional(),
  orderDate: z.coerce.date(),
  externalId: z.string().min(1).nullable().optional(),
  shippingAmount: z.coerce.number().min(0).default(0),
  city: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  lines: z
    .array(
      z.object({
        variantId: z.string().min(1),
        quantity: z.coerce.number().int().positive(),
        retailPrice: z.coerce.number().min(0),
        discountPct: z.coerce.number().min(0).max(1).default(0),
        /**
         * Tags the cashier actually scanned. Optional: tapping a tile on the
         * till sells a garment without naming which one, and that is a normal
         * way to work. When they are given, the sale records the exact pieces.
         */
        scannedSerials: z.array(z.string()).optional(),
      }),
    )
    .min(1, "An order needs at least one line."),
  payments: z
    .array(
      z.object({
        method: z.enum([
          "CASH", "CARD", "COD", "BANK_TRANSFER", "WALLET", "STORE_CREDIT", "DEPOSIT",
        ]),
        amount: z.coerce.number().positive(),
        fee: z.coerce.number().min(0).default(0),
        /** COD is pending until the courier remits; card at a till is not. */
        collected: z.boolean().default(false),
        reference: z.string().nullable().optional(),
      }),
    )
    .default([]),
});

export type CreateSaleInput = z.input<typeof createSaleSchema>;

async function accountId(tx: Prisma.TransactionClient, code: string): Promise<string> {
  const a = await tx.account.findUnique({ where: { code }, select: { id: true } });
  if (!a) throw new SalesError(`Account ${code} is missing from the chart of accounts.`);
  return a.id;
}

/**
 * Records a sale from any source.
 *
 * Stock is relieved before revenue is posted, so an order that cannot be
 * fulfilled fails before it has claimed any income.
 */
export async function createSale(
  input: CreateSaleInput,
  ctx: AuditContext,
): Promise<{
  salesOrderId: string;
  orderNumber: string;
  netAmount: string;
  cogs: string;
  grossMargin: string;
}> {
  const data = createSaleSchema.parse(input);

  if (data.source === "MODERATOR" && !ctx.userId) {
    // The specification is explicit: a social order must name its moderator.
    throw new SalesError("A moderator order must record which moderator created it.");
  }
  if (data.source === "POS" && !data.posSessionId) {
    throw new SalesError("A POS sale must belong to an open till session.");
  }

  // Idempotency for imports: the same external order can arrive twice.
  if (data.externalId) {
    const existing = await db.salesOrder.findFirst({
      where: { source: data.source, externalId: data.externalId },
      select: { id: true, orderNumber: true, netAmount: true, cogsAmount: true },
    });
    if (existing) {
      return {
        salesOrderId: existing.id,
        orderNumber: existing.orderNumber,
        netAmount: existing.netAmount.toString(),
        cogs: existing.cogsAmount.toString(),
        grossMargin: dec(existing.netAmount).minus(dec(existing.cogsAmount)).toString(),
      };
    }
  }

  if (data.posSessionId) {
    const session = await db.posSession.findUnique({ where: { id: data.posSessionId } });
    if (!session) throw new SalesError("Till session not found.");
    if (session.closedAt) throw new SalesError("That till session is already closed.");
  }

  // Invoice amounts are rounded to the piastre, because that is what an
  // invoice is. A 15% discount on 99.99 gives 84.9915, which no customer can
  // pay; recognising revenue at that figure while collecting 84.99 leaves the
  // journal short by fractions nobody can reconcile. Rounding here keeps the
  // invoice, the revenue posting and the payment in exact agreement.
  const lines = data.lines.map((l) => {
    // Both unit prices are rounded first, then multiplied by a whole
    // quantity. Rounding the multiplication instead would let the gross and
    // net lines disagree by a piastre on the same order, which is exactly the
    // imbalance the ledger then refuses to post.
    const unitPrice = roundMoney(dec(l.retailPrice));
    const netPrice = roundMoney(unitPrice.times(dec(1).minus(dec(l.discountPct))));
    return {
      ...l,
      gross: unitPrice.times(l.quantity),
      netPrice,
      lineTotal: netPrice.times(l.quantity),
    };
  });

  const grossAmount = sum(lines.map((l) => l.gross));
  const netAmount = sum(lines.map((l) => l.lineTotal));
  const discountAmount = grossAmount.minus(netAmount);
  const shipping = roundMoney(dec(data.shippingAmount));

  // A payment is money, so it is held at money precision from here on and
  // every later use — the stored record, the settlement posting, the fee —
  // reads the same rounded figure.
  const payments = data.payments.map((p) => ({
    ...p,
    amount: roundMoney(dec(p.amount)),
    fee: roundMoney(dec(p.fee)),
  }));

  const paymentTotal = sum(payments.map((p) => p.amount));
  const dueFromCustomer = netAmount.plus(shipping);
  // Compared at money precision, not at full precision: EGP cannot be paid in
  // fractions of a piastre, so an order totalling 4,989.3915 is settled in
  // full by 4,989.39. Demanding exact equality here rejects correct payments
  // and reports them with two figures that look identical on screen.
  if (roundMoney(paymentTotal).greaterThan(roundMoney(dueFromCustomer))) {
    // Paying more than the order comes to is not credit, it is a mistake or a
    // refund waiting to happen, and either way it is not this function's job.
    throw new SalesError(
      `Payments total ${paymentTotal.toFixed(2)} but the order only comes to ${dueFromCustomer.toFixed(2)}.`,
    );
  }

  // Whatever the customer did not hand over, they owe. Zero for a normal sale.
  const owed = roundMoney(dueFromCustomer.minus(paymentTotal));
  let dueDate: Date | null = null;

  // Taking some of the money and letting the rest ride is a decision somebody
  // makes at the counter, and it is the one the credit limit exists to govern.
  //
  // An order with no payments recorded at all is a different thing: a Shopify
  // order the courier has not remitted, or a wholesale order awaiting its
  // invoice. Those are unsettled rather than lent, they have always been
  // allowed without a named customer, and the aging report still shows them.
  const partPaid = payments.length > 0 && owed.greaterThan(0);

  if (partPaid) {
    // A debt nobody can be chased for is a loss with extra steps.
    if (!data.customerId) {
      throw new SalesError(
        "A part-paid sale has to be in a customer's name, otherwise nobody can be asked for the rest.",
      );
    }

    const customer = await db.customer.findUnique({
      where: { id: data.customerId },
      select: { name: true, creditLimit: true, creditDays: true },
    });
    if (!customer) throw new SalesError("Customer not found.");

    const alreadyOwed = await customerOutstanding(data.customerId);
    const wouldOwe = alreadyOwed.plus(owed);

    if (wouldOwe.greaterThan(dec(customer.creditLimit))) {
      throw new SalesError(
        `${customer.name} would owe ${wouldOwe.toFixed(2)}, over their ${dec(customer.creditLimit).toFixed(2)} limit` +
          (alreadyOwed.greaterThan(0)
            ? ` — ${alreadyOwed.toFixed(2)} of it from before.`
            : "."),
      );
    }

    // Their agreed terms, not a house default: an aging report is only
    // useful if "late" means late for this particular customer.
    dueDate = new Date(data.orderDate);
    dueDate.setDate(dueDate.getDate() + customer.creditDays);
  }

  // Relieved first: a sale that cannot be fulfilled must not book revenue.
  const relief: { variantId: string; cogs: string }[] = [];
  for (const line of lines) {
    const r = await relieveFinishedGoodsForSale(
      {
        variantId: line.variantId,
        locationId: data.locationId,
        entityId: data.entityId,
        quantity: String(line.quantity),
        saleDate: data.orderDate,
        cogsAccountCode: ACC.COGS_BRAND,
        customerId: data.customerId ?? null,
        referenceType: "SALES_ORDER",
      },
      ctx,
    );
    relief.push({ variantId: line.variantId, cogs: r.cogs });
  }
  const totalCogs = sum(relief.map((r) => dec(r.cogs)));

  return db.$transaction(async (tx) => {
    const orderNumber = await nextDocumentNumber(tx, "SO", data.orderDate);
    const totalFees = sum(payments.map((p) => p.fee));

    const order = await tx.salesOrder.create({
      data: {
        orderNumber,
        source: data.source,
        channelId: data.channelId,
        entityId: data.entityId,
        locationId: data.locationId,
        customerId: data.customerId ?? null,
        posSessionId: data.posSessionId ?? null,
        createdByUserId: ctx.userId,
        externalId: data.externalId ?? null,
        shopifyOrderId: data.source === "SHOPIFY" ? data.externalId ?? null : null,
        status: "CONFIRMED",
        orderDate: data.orderDate,
        dueDate: owed.greaterThan(0) ? dueDate : null,
        grossAmount: grossAmount.toString(),
        discountAmount: discountAmount.toString(),
        netAmount: netAmount.toString(),
        shippingAmount: shipping.toString(),
        paymentFee: totalFees.toString(),
        cogsAmount: totalCogs.toString(),
        city: data.city ?? null,
        notes: data.notes ?? null,
        lines: {
          create: lines.map((l) => {
            const unitCost = dec(
              relief.find((r) => r.variantId === l.variantId)?.cogs ?? 0,
            ).div(l.quantity);
            return {
              variantId: l.variantId,
              quantity: l.quantity,
              retailPrice: dec(l.retailPrice).toString(),
              discountPct: dec(l.discountPct).toString(),
              netPrice: l.netPrice.toString(),
              lineTotal: l.lineTotal.toString(),
              unitCost: unitCost.toString(),
              lineCost: unitCost.times(l.quantity).toString(),
            };
          }),
        },
        payments: {
          create: payments.map((p) => ({
            method: p.method,
            amount: p.amount.toString(),
            fee: p.fee.toString(),
            status: p.collected ? "COLLECTED" : "PENDING",
            collectedAt: p.collected ? data.orderDate : null,
            reference: p.reference ?? null,
          })),
        },
      },
    });

    // The physical garments that left the shop, tied to the line that sold
    // them. Scanned tags are used first so the record names exact pieces.
    const orderLines = await tx.salesOrderLine.findMany({
      where: { salesOrderId: order.id },
      select: { id: true, variantId: true, quantity: true },
    });
    for (const orderLine of orderLines) {
      const source = lines.find((l) => l.variantId === orderLine.variantId);
      await markUnitsSold(tx, {
        variantId: orderLine.variantId,
        quantity: orderLine.quantity,
        locationId: data.locationId,
        entityId: data.entityId,
        salesOrderLineId: orderLine.id,
        soldAt: data.orderDate,
        scannedSerials: source?.scannedSerials,
      });
    }

    // --- revenue -------------------------------------------------------
    // Discounts are shown gross-then-contra rather than netted away, so
    // markdown analysis has something to read.
    const revenueLines: DraftLine[] = [
      {
        accountId: await accountId(tx, REVENUE_ACCOUNT[data.source]),
        credit: grossAmount,
        entityId: data.entityId,
        customerId: data.customerId ?? null,
        description: `${data.source} sale ${orderNumber}`,
      },
    ];
    if (discountAmount.greaterThan(0)) {
      revenueLines.push({
        accountId: await accountId(tx, ACC.DISCOUNTS),
        debit: discountAmount,
        entityId: data.entityId,
        customerId: data.customerId ?? null,
        description: `Discount on ${orderNumber}`,
      });
    }

    // Every pound of the order has to land somewhere: in a drawer, in a
    // clearing account, or on the customer's tab. `owed` is whatever the
    // payments did not cover — the whole order when nothing was paid, part of
    // it when they paid something on account, nothing on a normal sale.
    const settlements = payments.map((p) => ({
      code: fundsAccount(p.method, p.collected),
      amount: p.amount,
    }));

    if (owed.greaterThan(0)) {
      settlements.push({ code: ACC.RECEIVABLE, amount: owed });
    }

    for (const s of settlements) {
      revenueLines.push({
        accountId: await accountId(tx, s.code),
        debit: s.amount,
        entityId: data.entityId,
        customerId: data.customerId ?? null,
        description: `Settlement for ${orderNumber}`,
      });
    }

    if (shipping.greaterThan(0)) {
      revenueLines.push({
        accountId: await accountId(tx, REVENUE_ACCOUNT[data.source]),
        credit: shipping,
        entityId: data.entityId,
        customerId: data.customerId ?? null,
        description: `Shipping charged on ${orderNumber}`,
      });
    }

    const revenueJournal = await postEntry(tx, {
      entityId: data.entityId,
      postingDate: data.orderDate,
      sourceType: "SALES_ORDER",
      sourceId: order.id,
      memo: `${data.source} sale ${orderNumber}`,
      ctx,
      lines: revenueLines,
    });

    // --- payment fees ---------------------------------------------------
    if (totalFees.greaterThan(0)) {
      await postEntry(tx, {
        entityId: data.entityId,
        postingDate: data.orderDate,
        sourceType: "PAYMENT",
        sourceId: order.id,
        memo: `Payment fees on ${orderNumber}`,
        ctx,
        lines: [
          {
            accountId: await accountId(tx, ACC.PAYMENT_FEES),
            debit: totalFees,
            entityId: data.entityId,
            description: `Processor and courier fees ${orderNumber}`,
          },
          {
            // Deducted from wherever that payment landed, so the fee comes
            // off the same balance the money went into.
            accountId: await accountId(
              tx,
              fundsAccount(payments[0].method, payments[0].collected),
            ),
            credit: totalFees,
            entityId: data.entityId,
            description: `Fees deducted at source ${orderNumber}`,
          },
        ],
      });
    }

    await writeAudit(tx, {
      action: "SALE_RECORDED",
      entityName: "SalesOrder",
      entityId: order.id,
      after: {
        orderNumber, source: data.source,
        netAmount: netAmount.toString(),
        cogs: totalCogs.toString(),
        grossMargin: netAmount.minus(totalCogs).toString(),
        journalEntry: revenueJournal.entryNumber,
        moderator: data.source === "MODERATOR" ? ctx.userId : undefined,
      },
      ctx,
    });

    return {
      salesOrderId: order.id,
      orderNumber,
      netAmount: netAmount.toString(),
      cogs: totalCogs.toString(),
      grossMargin: netAmount.minus(totalCogs).toString(),
    };
  });
}

/** Opens a till. One cashier, one location, one shift. */
export async function openPosSession(
  input: { locationId: string; cashierUserId: string; openingFloat: string; openedAt?: Date },
  ctx: AuditContext,
): Promise<{ posSessionId: string; sessionNumber: string }> {
  const openedAt = input.openedAt ?? new Date();

  return db.$transaction(async (tx) => {
    const alreadyOpen = await tx.posSession.findFirst({
      where: { locationId: input.locationId, closedAt: null },
    });
    if (alreadyOpen) {
      throw new SalesError(
        `Till ${alreadyOpen.sessionNumber} is still open at this location. Close it before opening another.`,
      );
    }

    const sessionNumber = await nextDocumentNumber(tx, "TILL", openedAt);
    const session = await tx.posSession.create({
      data: {
        sessionNumber,
        locationId: input.locationId,
        cashierUserId: input.cashierUserId,
        openingFloat: dec(input.openingFloat).toString(),
        openedAt,
      },
    });

    await writeAudit(tx, {
      action: "POS_SESSION_OPENED",
      entityName: "PosSession",
      entityId: session.id,
      after: { sessionNumber, openingFloat: input.openingFloat },
      ctx,
    });

    return { posSessionId: session.id, sessionNumber };
  });
}

/**
 * Closes a till and reconciles the drawer.
 *
 * A variance is recorded, never silently absorbed: forcing the count to match
 * the system is how a till stops being evidence of anything.
 */
export async function closePosSession(
  input: { posSessionId: string; countedCash: string; note?: string | null },
  ctx: AuditContext,
): Promise<{ expectedCash: string; countedCash: string; variance: string }> {
  return db.$transaction(async (tx) => {
    const session = await tx.posSession.findUnique({
      where: { id: input.posSessionId },
      include: { orders: { include: { payments: true } } },
    });
    if (!session) throw new SalesError("Till session not found.");
    if (session.closedAt) throw new SalesError("That till session is already closed.");

    // One person sells, another counts. A cashier who counts their own drawer
    // is the only witness to a shortfall they caused, and the variance figure
    // stops meaning anything.
    //
    // The owner is the way out of a dead end — somebody has to be able to
    // close a till when nobody else is on the floor — and their name goes on
    // the row, which is the whole point of recording who closed it.
    if (ctx.userId && ctx.userId === session.cashierUserId) {
      const closer = await tx.user.findUnique({
        where: { id: ctx.userId },
        select: { role: true },
      });
      if (closer?.role !== "OWNER") {
        throw new SalesError(
          "You took the money on this till, so somebody else has to count it.",
        );
      }
    }

    const cashTaken = session.orders
      .flatMap((o) => o.payments)
      .filter((p) => p.method === "CASH")
      .reduce((s, p) => s.plus(dec(p.amount)), dec(0));

    const expected = dec(session.openingFloat).plus(cashTaken);
    const counted = dec(input.countedCash);
    const variance = counted.minus(expected);

    await tx.posSession.update({
      where: { id: session.id },
      data: {
        closedAt: new Date(),
        closedByUserId: ctx.userId,
        countedCash: counted.toString(),
        expectedCash: expected.toString(),
        cashVariance: variance.toString(),
        varianceNote: input.note ?? null,
      },
    });

    await writeAudit(tx, {
      action: variance.isZero() ? "POS_SESSION_CLOSED" : "POS_SESSION_CLOSED_WITH_VARIANCE",
      entityName: "PosSession",
      entityId: session.id,
      after: {
        expectedCash: expected.toString(),
        countedCash: counted.toString(),
        variance: variance.toString(),
        orders: session.orders.length,
      },
      ctx: { ...ctx, reason: input.note ?? null },
    });

    return {
      expectedCash: expected.toString(),
      countedCash: counted.toString(),
      variance: variance.toString(),
    };
  });
}
