import "server-only";
import { z } from "zod";
import { db } from "./db";
import { command } from "./command";
import { writeAudit, type AuditContext } from "./audit";
import { nextDocumentNumber, postEntry } from "./ledger";
import { dec, roundMoney, type Decimal } from "./money";
import { commissionFor, clawBackFor, rateOn } from "@/core/commission";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Paying somebody for the orders they brought in.
 *
 * The shape of this follows one decision, which is the owner's: a moderator
 * earns when the customer's money is actually in, not when the order is
 * taken. In a country where a parcel comes back as often as it does, paying on
 * orders placed pays for sales that never happened, and the shop discovers it
 * a month later with the money gone.
 *
 * So the earning is written at the moment an order becomes fully collected,
 * and the accounting says what that is:
 *
 *   earned:   DR moderator commission   CR payable to moderators
 *   paid:     DR payable to moderators  CR cash or bank
 *   returned: the reverse of the earning, for the pieces that came back
 *
 * Between the first and the second, the shop owes somebody money. That is a
 * debt with a name on it, and it sits on the liabilities side until it is
 * paid, exactly like what is owed to a consignor.
 *
 * Every write here is keyed and idempotent, because the accrual is attempted
 * from every place money changes hands and must never pay twice.
 */

export class CommissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommissionError";
  }
}

const ACC = {
  COMMISSION: "6250",
  OWED_TO_MODERATORS: "2510",
  POS_DRAWER: "1115",
  BANK: "1120",
} as const;

const FUNDS: Record<string, string> = {
  CASH: ACC.POS_DRAWER,
  BANK_TRANSFER: ACC.BANK,
  INSTAPAY: ACC.BANK,
  CARD: ACC.BANK,
};

function asDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/* -------------------------------------------------------------------- rates */

export const rateSchema = z.object({
  userId: z.string().min(1, "Choose whose rate this is."),
  perPieceAmount: z.coerce.number().min(0, "A rate cannot be negative."),
  percentOfNet: z.coerce.number().min(0).max(100, "A percentage above 100 is not a percentage."),
  effectiveFrom: z.string().min(1, "Say what day this rate starts."),
  notes: z.string().nullable().optional(),
});

/**
 * Puts somebody on a rate from a given day.
 *
 * The rate they were on before is closed the day before this one starts rather
 * than edited, so what last month paid stays exactly what last month paid. A
 * commission already written keeps its own copy of the figures regardless.
 */
export async function setModeratorRate(
  input: {
    userId: string;
    perPieceAmount: string;
    /** Typed as a percentage on screen; stored as a fraction. */
    percentOfNet: string;
    effectiveFrom: Date;
    notes?: string | null;
  },
  ctx: AuditContext,
): Promise<{ rateId: string }> {
  return command("moderatorCommission.setRate", input, ctx, async () => {
    const user = await db.user.findUnique({ where: { id: input.userId } });
    if (!user) throw new CommissionError("That user does not exist.");

    const from = asDay(input.effectiveFrom);
    const perPiece = roundMoney(dec(input.perPieceAmount));
    const percent = dec(input.percentOfNet).dividedBy(100);

    if (perPiece.lessThan(0) || percent.lessThan(0)) {
      throw new CommissionError("A rate cannot be negative.");
    }
    if (perPiece.isZero() && percent.isZero()) {
      throw new CommissionError(
        "A rate of nothing earns nothing. Close the rate instead if they are no longer on one.",
      );
    }

    return db.$transaction(async (tx) => {
      const dayBefore = new Date(from.getTime() - 86_400_000);
      await tx.moderatorRate.updateMany({
        where: { userId: input.userId, effectiveTo: null, effectiveFrom: { lt: from } },
        data: { effectiveTo: dayBefore },
      });

      const rate = await tx.moderatorRate.create({
        data: {
          userId: input.userId,
          perPieceAmount: perPiece.toString(),
          percentOfNet: percent.toString(),
          effectiveFrom: from,
          notes: input.notes ?? null,
          createdByUserId: ctx.userId ?? null,
        },
      });

      await writeAudit(tx, {
        action: "MODERATOR_RATE_SET",
        entityName: "ModeratorRate",
        entityId: rate.id,
        after: {
          user: user.name,
          perPiece: perPiece.toString(),
          percent: percent.toString(),
          from: from.toISOString().slice(0, 10),
        },
        ctx,
      });

      return { rateId: rate.id };
    });
  });
}

/** Takes somebody off commission from a day, without touching what they earned. */
export async function endModeratorRate(
  input: { userId: string; lastDay: Date },
  ctx: AuditContext,
): Promise<void> {
  return command("moderatorCommission.endRate", input, ctx, async () => {
    const last = asDay(input.lastDay);
    const closed = await db.moderatorRate.updateMany({
      where: { userId: input.userId, effectiveTo: null },
      data: { effectiveTo: last },
    });
    if (closed.count === 0) throw new CommissionError("They are not on a rate.");

    await db.$transaction(async (tx) => {
      await writeAudit(tx, {
        action: "MODERATOR_RATE_ENDED",
        entityName: "ModeratorRate",
        entityId: input.userId,
        after: { until: last.toISOString().slice(0, 10) },
        ctx,
      });
    });
  });
}

/* ------------------------------------------------------------------ earning */

/** Whether every piaster the order is owed has actually been collected. */
function isCollected(order: {
  netAmount: Prisma.Decimal;
  shippingAmount: Prisma.Decimal;
  collectedDate: Date | null;
  payments: { status: string; amount: Prisma.Decimal }[];
}): boolean {
  if (order.collectedDate) return true;
  const due = roundMoney(dec(order.netAmount).plus(dec(order.shippingAmount)));
  const taken = order.payments
    .filter((p) => p.status === "COLLECTED")
    .reduce((s, p) => s.plus(dec(p.amount)), dec(0));
  return roundMoney(taken).greaterThanOrEqualTo(due);
}

/**
 * Writes what an order earned its moderator, if it earned anything.
 *
 * Safe to call from anywhere money is taken, and it is: a sale paid in full at
 * the counter, a debt collected later, a Shopify order marked paid. The unique
 * key on the source means the second and third calls write nothing, so no
 * caller has to know whether another one got there first.
 *
 * Silent when there is nothing to do — no moderator, no rate, or the money is
 * not all in — because this is a hook on somebody else's transaction and an
 * exception here would roll back a collection that was perfectly good.
 */
export async function accrueCommissionForOrder(
  salesOrderId: string,
  ctx: AuditContext,
): Promise<{ amount: string; userId: string } | null> {
  const order = await db.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: {
      id: true,
      orderNumber: true,
      createdByUserId: true,
      entityId: true,
      netAmount: true,
      shippingAmount: true,
      collectedDate: true,
      orderDate: true,
      status: true,
      payments: { select: { status: true, amount: true, collectedAt: true } },
      lines: { select: { quantity: true } },
    },
  });
  if (!order || !order.createdByUserId || !order.entityId) return null;
  if (order.status === "CANCELLED") return null;
  if (!isCollected(order)) return null;

  const sourceKey = `order:${order.id}`;
  if (await db.moderatorCommission.findUnique({ where: { sourceKey } })) return null;

  // The day the money landed, not the day the order was taken: that is the day
  // the rate is read against and the day the expense belongs to.
  const collectedAt = order.collectedDate
    ?? order.payments
      .filter((p) => p.status === "COLLECTED" && p.collectedAt)
      .map((p) => p.collectedAt!)
      .sort((a, b) => b.getTime() - a.getTime())[0]
    ?? order.orderDate;
  const earnedOn = asDay(collectedAt);

  const rates = await db.moderatorRate.findMany({ where: { userId: order.createdByUserId } });
  const rate = rateOn(rates, earnedOn);
  if (!rate) return null;

  const pieces = order.lines.reduce((s, l) => s + l.quantity, 0);
  const amount = commissionFor(
    { perPieceAmount: rate.perPieceAmount.toString(), percentOfNet: rate.percentOfNet.toString() },
    { pieces, netAmount: order.netAmount.toString() },
  );
  if (amount.lessThanOrEqualTo(0)) return null;

  return command(
    "moderatorCommission.accrue",
    { salesOrderId, sourceKey },
    ctx,
    async () =>
      db.$transaction(async (tx) => {
        const [expense, payable] = await Promise.all([
          tx.account.findUniqueOrThrow({ where: { code: ACC.COMMISSION }, select: { id: true } }),
          tx.account.findUniqueOrThrow({ where: { code: ACC.OWED_TO_MODERATORS }, select: { id: true } }),
        ]);

        const entry = await postEntry(tx, {
          entityId: order.entityId!,
          postingDate: earnedOn,
          sourceType: "PAYMENT",
          sourceId: order.id,
          memo: `Commission on ${order.orderNumber}`,
          ctx,
          lines: [
            {
              accountId: expense.id,
              debit: amount,
              entityId: order.entityId!,
              description: `Commission on ${order.orderNumber}`,
            },
            {
              accountId: payable.id,
              credit: amount,
              entityId: order.entityId!,
              description: `Owed for ${order.orderNumber}`,
            },
          ],
        });

        await tx.moderatorCommission.create({
          data: {
            kind: "EARNED",
            sourceKey,
            userId: order.createdByUserId!,
            salesOrderId: order.id,
            rateId: rate.id,
            perPieceAmount: rate.perPieceAmount.toString(),
            percentOfNet: rate.percentOfNet.toString(),
            pieces,
            netAmount: order.netAmount.toString(),
            amount: amount.toString(),
            earnedOn,
            entityId: order.entityId!,
            journalEntryId: entry.id,
          },
        });

        await writeAudit(tx, {
          action: "MODERATOR_COMMISSION_EARNED",
          entityName: "SalesOrder",
          entityId: order.id,
          after: { orderNumber: order.orderNumber, pieces, amount: amount.toString() },
          ctx,
        });

        return { amount: amount.toString(), userId: order.createdByUserId! };
      }),
  );
}

/**
 * Takes back what the returned pieces were worth.
 *
 * Only where the order earned something in the first place: a return on an
 * order collected before anybody was on a rate takes nothing back, because
 * nothing was paid. Capped at what is left of the earning, so a return typed
 * twice cannot leave somebody owing money they never had.
 */
export async function reverseCommissionForReturn(
  input: { returnId: string; salesOrderId: string; piecesReturned: number; netRefunded: string },
  ctx: AuditContext,
): Promise<{ amount: string } | null> {
  const sourceKey = `return:${input.returnId}`;
  if (await db.moderatorCommission.findUnique({ where: { sourceKey } })) return null;

  const existing = await db.moderatorCommission.findMany({
    where: { salesOrderId: input.salesOrderId },
  });
  const earned = existing.find((c) => c.kind === "EARNED");
  if (!earned) return null;

  const clawedBack = existing
    .filter((c) => c.kind === "REVERSED")
    .reduce((s, c) => s.plus(dec(c.amount).abs()), dec(0));

  const amount = clawBackFor(
    { perPieceAmount: earned.perPieceAmount.toString(), percentOfNet: earned.percentOfNet.toString() },
    { pieces: input.piecesReturned, netAmount: input.netRefunded },
    earned.amount.toString(),
    clawedBack.toString(),
  );
  if (amount.lessThanOrEqualTo(0)) return null;

  return command(
    "moderatorCommission.reverse",
    { sourceKey },
    ctx,
    async () =>
      db.$transaction(async (tx) => {
        const [expense, payable] = await Promise.all([
          tx.account.findUniqueOrThrow({ where: { code: ACC.COMMISSION }, select: { id: true } }),
          tx.account.findUniqueOrThrow({ where: { code: ACC.OWED_TO_MODERATORS }, select: { id: true } }),
        ]);
        const order = await tx.salesOrder.findUniqueOrThrow({
          where: { id: input.salesOrderId },
          select: { orderNumber: true },
        });

        const entry = await postEntry(tx, {
          entityId: earned.entityId,
          postingDate: asDay(new Date()),
          sourceType: "PAYMENT",
          sourceId: input.salesOrderId,
          memo: `Commission returned on ${order.orderNumber}`,
          ctx,
          lines: [
            {
              accountId: payable.id,
              debit: amount,
              entityId: earned.entityId,
              description: `Commission clawed back on ${order.orderNumber}`,
            },
            {
              accountId: expense.id,
              credit: amount,
              entityId: earned.entityId,
              description: `Goods returned on ${order.orderNumber}`,
            },
          ],
        });

        await tx.moderatorCommission.create({
          data: {
            kind: "REVERSED",
            sourceKey,
            userId: earned.userId,
            salesOrderId: input.salesOrderId,
            rateId: earned.rateId,
            perPieceAmount: earned.perPieceAmount,
            percentOfNet: earned.percentOfNet,
            pieces: -input.piecesReturned,
            netAmount: dec(input.netRefunded).negated().toString(),
            amount: amount.negated().toString(),
            earnedOn: asDay(new Date()),
            entityId: earned.entityId,
            journalEntryId: entry.id,
          },
        });

        await writeAudit(tx, {
          action: "MODERATOR_COMMISSION_REVERSED",
          entityName: "SalesOrder",
          entityId: input.salesOrderId,
          after: { orderNumber: order.orderNumber, pieces: input.piecesReturned, amount: amount.toString() },
          ctx,
        });

        return { amount: amount.negated().toString() };
      }),
  );
}

/* --------------------------------------------------------------- settlement */

/**
 * Pays a moderator what the lines say they are owed.
 *
 * Claims the exact lines it pays rather than recomputing a total, so one
 * written between the screen loading and the button being pressed is neither
 * paid twice nor quietly missed. A claw-back is settled alongside the earnings
 * it reduces, which is why the total can only be paid whole.
 */
export async function settleModerator(
  input: {
    userId: string;
    method: "CASH" | "BANK_TRANSFER" | "INSTAPAY";
    paidOn: Date;
    notes?: string | null;
  },
  ctx: AuditContext,
): Promise<{ number: string; amount: string; lines: number }> {
  return command("moderatorCommission.settle", input, ctx, async () => {
    const user = await db.user.findUnique({ where: { id: input.userId } });
    if (!user) throw new CommissionError("That user does not exist.");

    const outstanding = await db.moderatorCommission.findMany({
      where: { userId: input.userId, settlementId: null },
      orderBy: { earnedOn: "asc" },
    });
    if (outstanding.length === 0) throw new CommissionError(`Nothing is owed to ${user.name}.`);

    const amount = roundMoney(outstanding.reduce((s, c) => s.plus(dec(c.amount)), dec(0)));
    if (amount.lessThanOrEqualTo(0)) {
      throw new CommissionError(
        `${user.name} has ${amount.toFixed(2)} outstanding — returns have cancelled out the earnings. ` +
          `Nothing to pay, and nothing to collect back.`,
      );
    }

    const entity = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });
    const paidOn = asDay(input.paidOn);

    return db.$transaction(async (tx) => {
      const number = await nextDocumentNumber(tx, "MCS", paidOn);

      const [payable, funds] = await Promise.all([
        tx.account.findUniqueOrThrow({ where: { code: ACC.OWED_TO_MODERATORS }, select: { id: true } }),
        tx.account.findUniqueOrThrow({ where: { code: FUNDS[input.method] }, select: { id: true } }),
      ]);

      const entry = await postEntry(tx, {
        entityId: entity.id,
        postingDate: paidOn,
        sourceType: "PAYMENT",
        sourceId: input.userId,
        memo: `${number} — commission paid to ${user.name}`,
        ctx,
        lines: [
          {
            accountId: payable.id,
            debit: amount,
            entityId: entity.id,
            description: `Commission settled to ${user.name}`,
          },
          {
            accountId: funds.id,
            credit: amount,
            entityId: entity.id,
            description: `${number} paid by ${input.method.toLowerCase()}`,
          },
        ],
      });

      const settlement = await tx.moderatorSettlement.create({
        data: {
          number,
          userId: input.userId,
          amount: amount.toString(),
          method: input.method,
          paidOn,
          notes: input.notes ?? null,
          entityId: entity.id,
          journalEntryId: entry.id,
          paidByUserId: ctx.userId ?? null,
        },
      });

      await tx.moderatorCommission.updateMany({
        where: { id: { in: outstanding.map((c) => c.id) } },
        data: { settlementId: settlement.id },
      });

      await writeAudit(tx, {
        action: "MODERATOR_COMMISSION_SETTLED",
        entityName: "ModeratorSettlement",
        entityId: settlement.id,
        after: { number, user: user.name, amount: amount.toString(), lines: outstanding.length },
        ctx,
      });

      return { number, amount: amount.toString(), lines: outstanding.length };
    });
  });
}

/* ------------------------------------------------------------------ reading */

export type ModeratorPosition = {
  userId: string;
  name: string;
  role: string;
  perPieceAmount: string | null;
  percentOfNet: string | null;
  since: Date | null;
  orders: number;
  pieces: number;
  earned: Decimal;
  clawedBack: Decimal;
  owed: Decimal;
};

/** Everybody on a rate, and what each is owed right now. */
export async function moderatorPositions(): Promise<ModeratorPosition[]> {
  const today = asDay(new Date());

  const [users, commissions] = await Promise.all([
    db.user.findMany({
      where: { moderatorRates: { some: {} } },
      select: {
        id: true,
        name: true,
        role: true,
        moderatorRates: { orderBy: { effectiveFrom: "asc" } },
      },
      orderBy: { name: "asc" },
    }),
    db.moderatorCommission.groupBy({
      by: ["userId", "kind"],
      where: { settlementId: null },
      _sum: { amount: true, pieces: true },
      _count: { _all: true },
    }),
  ]);

  return users.map((u) => {
    const live = rateOn(u.moderatorRates, today);
    const mine = commissions.filter((c) => c.userId === u.id);
    const earned = mine
      .filter((c) => c.kind === "EARNED")
      .reduce((s, c) => s.plus(dec(c._sum.amount ?? 0)), dec(0));
    const clawedBack = mine
      .filter((c) => c.kind === "REVERSED")
      .reduce((s, c) => s.plus(dec(c._sum.amount ?? 0).abs()), dec(0));

    return {
      userId: u.id,
      name: u.name,
      role: u.role,
      perPieceAmount: live ? live.perPieceAmount.toString() : null,
      percentOfNet: live ? live.percentOfNet.toString() : null,
      since: live ? live.effectiveFrom : null,
      orders: mine.filter((c) => c.kind === "EARNED").reduce((s, c) => s + c._count._all, 0),
      pieces: mine.reduce((s, c) => s + (c._sum.pieces ?? 0), 0),
      earned,
      clawedBack,
      owed: earned.minus(clawedBack),
    };
  });
}

/** The individual lines behind what somebody is owed. */
export async function unsettledLines(userId?: string | null, limit = 100) {
  const rows = await db.moderatorCommission.findMany({
    where: { settlementId: null, ...(userId ? { userId } : {}) },
    include: {
      salesOrder: { select: { orderNumber: true, source: true } },
      user: { select: { name: true } },
    },
    orderBy: { earnedOn: "desc" },
    take: limit,
  });

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    user: r.user.name,
    orderNumber: r.salesOrder.orderNumber,
    source: r.salesOrder.source,
    pieces: r.pieces,
    netAmount: r.netAmount.toString(),
    perPieceAmount: r.perPieceAmount.toString(),
    percentOfNet: r.percentOfNet.toString(),
    amount: r.amount.toString(),
    earnedOn: r.earnedOn,
  }));
}

/** What has already been paid over. */
export async function recentSettlements(limit = 25) {
  const rows = await db.moderatorSettlement.findMany({
    include: { user: { select: { name: true } }, _count: { select: { commissions: true } } },
    orderBy: { paidOn: "desc" },
    take: limit,
  });
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    user: r.user.name,
    amount: r.amount.toString(),
    method: r.method,
    paidOn: r.paidOn,
    lines: r._count.commissions,
  }));
}

/** What the brand owes moderators in total, for the tile that says so. */
export async function totalOwedToModerators(): Promise<Decimal> {
  const sum = await db.moderatorCommission.aggregate({
    where: { settlementId: null },
    _sum: { amount: true },
  });
  return dec(sum._sum.amount ?? 0);
}
