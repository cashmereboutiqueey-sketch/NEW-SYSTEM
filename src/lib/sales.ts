import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "./db";
import { postEntry, nextDocumentNumber } from "./ledger";
import { relieveFinishedGoodsForSale } from "./inventory";
import { writeAudit, type AuditContext } from "./audit";
import type { DraftLine } from "@/core/ledger";
import { dec, sum } from "./money";

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
};

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
      }),
    )
    .min(1, "An order needs at least one line."),
  payments: z
    .array(
      z.object({
        method: z.enum(["CASH", "CARD", "COD", "BANK_TRANSFER", "WALLET", "STORE_CREDIT"]),
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

  const lines = data.lines.map((l) => {
    const gross = dec(l.retailPrice).times(l.quantity);
    const netPrice = dec(l.retailPrice).times(dec(1).minus(dec(l.discountPct)));
    return { ...l, gross, netPrice, lineTotal: netPrice.times(l.quantity) };
  });

  const grossAmount = sum(lines.map((l) => l.gross));
  const netAmount = sum(lines.map((l) => l.lineTotal));
  const discountAmount = grossAmount.minus(netAmount);
  const shipping = dec(data.shippingAmount);

  const paymentTotal = sum(data.payments.map((p) => dec(p.amount)));
  const dueFromCustomer = netAmount.plus(shipping);
  if (data.payments.length > 0 && !paymentTotal.equals(dueFromCustomer)) {
    throw new SalesError(
      `Payments total ${paymentTotal.toFixed(2)} but the order comes to ${dueFromCustomer.toFixed(2)}.`,
    );
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
    const totalFees = sum(data.payments.map((p) => dec(p.fee)));

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
          create: data.payments.map((p) => ({
            method: p.method,
            amount: dec(p.amount).toString(),
            fee: dec(p.fee).toString(),
            status: p.collected ? "COLLECTED" : "PENDING",
            collectedAt: p.collected ? data.orderDate : null,
            reference: p.reference ?? null,
          })),
        },
      },
    });

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

    // With no payment recorded the customer owes the money, so it is a
    // receivable rather than an assumption that cash arrived.
    const settlements =
      data.payments.length > 0
        ? data.payments.map((p) => ({ code: FUNDS_ACCOUNT[p.method], amount: dec(p.amount) }))
        : [{ code: ACC.RECEIVABLE, amount: dueFromCustomer }];

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
            accountId: await accountId(tx, FUNDS_ACCOUNT[data.payments[0].method]),
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
