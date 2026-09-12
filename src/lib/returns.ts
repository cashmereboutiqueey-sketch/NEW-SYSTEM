import "server-only";
import { db } from "./db";
import { postEntry, nextDocumentNumber } from "./ledger";
import { dec, roundMoney, Decimal } from "./money";
import { writeAudit, type AuditContext } from "./audit";
import { outstandingOnOrder } from "./receivables";
import { command } from "./command";
import { recordTillCash } from "./till";

/**
 * A customer brings a garment back.
 *
 * A shop takes returns every week. Without this they happen on a piece of
 * paper, and then two things drift at once: the stock says a garment was sold
 * that is hanging on the rail, and the cash says money went out that no
 * document explains. Of everything missing from this system, that was the one
 * that would have started lying soonest.
 *
 * A return is not a negative sale. It reverses two separate things, and
 * getting the second one wrong is how a shop invents profit:
 *
 *   the money:  DR sales returns (4210)   CR cash / what they owe
 *   the goods:  DR finished goods         CR cost of sales
 *
 * The garment goes back at **the cost it originally left at**, taken from the
 * line that sold it, not at today's cost. Restocking at a newer, higher cost
 * would book a gain for a sale that was undone, and a shop that returns
 * enough stock could show a profit made entirely of returns.
 *
 * Its aging clock is not restarted either. A coat sold in March and returned
 * in June is three months old, not new, and dead-stock reporting is worthless
 * if a return can launder the date.
 */

export class ReturnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReturnError";
  }
}

const ACC = {
  POS_DRAWER: "1115",
  BANK: "1120",
  RECEIVABLE: "1210",
  FG_BRAND: "1340",
  SALES_RETURNS: "4210",
  COGS_BRAND: "5300",
  STOCK_LOSS: "5450",
} as const;

/** Where the money goes back from. */
const REFUND_ACCOUNT: Record<string, string> = {
  CASH: ACC.POS_DRAWER,
  CARD: ACC.BANK,
  BANK_TRANSFER: ACC.BANK,
  INSTAPAY: ACC.BANK,
};

export type RefundMethod = "CASH" | "CARD" | "BANK_TRANSFER" | "INSTAPAY" | "AGAINST_BALANCE";

function asDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** How many days after a sale the shop still takes something back. */
export async function returnWindowDays(): Promise<number> {
  const setting = await db.setting.findUnique({ where: { key: "sales.returnWindowDays" } });
  return Number(setting?.value ?? 14);
}

/**
 * What can still be brought back on an order, line by line.
 *
 * Already-returned quantities are subtracted, so the same garment cannot be
 * refunded twice — which is the single most common way a return process
 * leaks money.
 */
export async function returnableLines(salesOrderId: string) {
  const order = await db.salesOrder.findUnique({
    where: { id: salesOrderId },
    include: {
      customer: true,
      payments: { select: { amount: true } },
      lines: {
        include: { variant: { include: { style: true, colorCode: true, sizeCode: true } } },
      },
    },
  });
  if (!order) throw new ReturnError("Order not found.");

  const returns = await db.return.findMany({ where: { salesOrderId } });

  const returnedByVariant = new Map<string, number>();
  for (const r of returns) {
    returnedByVariant.set(r.variantId, (returnedByVariant.get(r.variantId) ?? 0) + r.quantity);
  }

  const windowDays = await returnWindowDays();
  const age = Math.floor(
    (Date.now() - new Date(order.orderDate).getTime()) / 86_400_000,
  );

  return {
    order: {
      id: order.id,
      orderNumber: order.orderNumber,
      orderDate: order.orderDate,
      source: order.source,
      customerId: order.customerId,
      customerName: order.customer?.name ?? null,
      locationId: order.locationId,
      entityId: order.entityId,
      netAmount: dec(order.netAmount).toString(),
      outstanding: outstandingOnOrder(order).toString(),
      daysOld: age,
      /** Past the window is a decision for a person, not a refusal. */
      pastWindow: age > windowDays,
      windowDays,
    },
    lines: order.lines.map((l) => {
      const returned = returnedByVariant.get(l.variantId) ?? 0;
      return {
        variantId: l.variantId,
        sku: l.variant.sku,
        styleName: l.variant.style.nameAr || l.variant.style.nameEn,
        colour: l.variant.colorCode.nameAr || l.variant.colorCode.code,
        size: l.variant.sizeCode.code,
        sold: l.quantity,
        returned,
        returnable: l.quantity - returned,
        /** What the customer paid for one, after any discount. */
        unitPrice: dec(l.netPrice).toString(),
        /** What one cost the shop, frozen at the sale. */
        unitCost: dec(l.unitCost).toString(),
      };
    }),
  };
}

export async function recordReturn(
  input: {
    salesOrderId: string;
    variantId: string;
    quantity: number;
    /** RESTOCK puts it back on the shelf; WRITE_OFF does not. */
    disposition: "RESTOCK" | "WRITE_OFF" | "REPAIR_AND_RESTOCK";
    refundMethod: RefundMethod;
    /** Blank means refund what they paid for it. */
    refundAmount?: string | null;
    /** Apply the return value to unpaid debt first; refund the remainder. */
    creditAgainstBalance?: boolean;
    reason?: string | null;
    returnDate: Date;
  },
  ctx: AuditContext,
): Promise<{
  returnNumber: string;
  refunded: string;
  cashRefunded: string;
  creditedBalance: string;
  restocked: number;
  journalEntryId: string;
}> {
  return command("returns.recordReturn", input, ctx, async () => {
    if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) throw new ReturnError("A return needs a positive whole number of garments.");

    const picture = await returnableLines(input.salesOrderId);
    const line = picture.lines.find((l) => l.variantId === input.variantId);
    if (!line) throw new ReturnError("That garment is not on this order.");
    if (picture.lines.filter((l) => l.variantId === input.variantId).length !== 1) {
      throw new ReturnError("This historical invoice has repeated garment lines; reconcile its line allocations before returning it.");
    }
    if (!["RESTOCK", "WRITE_OFF", "REPAIR_AND_RESTOCK"].includes(input.disposition)) {
      throw new ReturnError("Unknown return disposition.");
    }

    if (input.quantity > line.returnable) {
      // Returning more than was bought is either a mistake or a way of taking
      // money out of the drawer with a document behind it.
      throw new ReturnError(
        line.returned > 0
          ? `Only ${line.returnable} of ${line.sku} can still come back; ${line.returned} already has.`
          : `Only ${line.sold} of ${line.sku} were sold on this order.`,
      );
    }

    const paid = dec(line.unitPrice).times(input.quantity);
    const refund =
      input.refundAmount != null && input.refundAmount !== ""
        ? roundMoney(dec(input.refundAmount))
        : roundMoney(paid);

    if (refund.lessThan(0)) throw new ReturnError("A refund cannot be negative.");
    if (refund.greaterThan(paid)) {
      throw new ReturnError(
        `They paid ${paid.toFixed(2)} for those; ${refund.toFixed(2)} is more than that.`,
      );
    }

    const owed = dec(picture.order.outstanding);
    const credit = input.refundMethod === "AGAINST_BALANCE" ? refund
      : input.creditAgainstBalance ? Decimal.max(0, Decimal.min(owed, refund)) : dec(0);
    const cashRefund = refund.minus(credit);
    if (input.refundMethod === "AGAINST_BALANCE") {
      const owed = dec(picture.order.outstanding);
      if (owed.lessThanOrEqualTo(0)) {
        throw new ReturnError(
          "There is nothing outstanding on this order to set the refund against.",
        );
      }
      if (refund.greaterThan(owed)) {
        throw new ReturnError(
          `They only owe ${owed.toFixed(2)} on this order; refund the rest another way.`,
        );
      }
    }

    const entityId = picture.order.entityId;
    if (!entityId) throw new ReturnError("This order is not attached to a company.");

    if (cashRefund.greaterThan(0)) {
      const [collected, refunded] = await Promise.all([
        db.salesPayment.aggregate({
          where: { salesOrderId: input.salesOrderId, status: "COLLECTED", method: { not: "STORE_CREDIT" } },
          _sum: { amount: true },
        }),
        db.journalLine.aggregate({
          where: { account: { code: { in: [ACC.POS_DRAWER, ACC.BANK] } },
            journalEntry: { status: "POSTED", sourceType: "SALES_RETURN", sourceId: input.salesOrderId } },
          _sum: { credit: true },
        }),
      ]);
      const available = dec(collected._sum.amount ?? 0).minus(refunded._sum.credit ?? 0);
      if (cashRefund.greaterThan(available)) {
        throw new ReturnError(`Only ${available.toFixed(2)} of collected money remains refundable. Set the unpaid amount against the customer's balance instead.`);
      }
    }

    const returnDate = asDay(input.returnDate);
    const restocking = input.disposition !== "WRITE_OFF";
    // The cost the garment left at, frozen on the line that sold it.
    const soldMovements = await db.inventoryMovement.findMany({
      where: { type: "SALE", referenceId: input.salesOrderId, lot: { variantId: input.variantId } },
      include: { lot: true },
      orderBy: [{ lot: { receivedDate: "asc" } }, { lot: { sequence: "asc" } }, { id: "asc" }],
    });
    let skip = line.returned;
    let remaining = input.quantity;
    const allocations: { lot: (typeof soldMovements)[number]["lot"]; quantity: number; unitCost: ReturnType<typeof dec> }[] = [];
    for (const movement of soldMovements) {
      const quantity = Number(movement.quantity);
      const skipped = Math.min(skip, quantity);
      skip -= skipped;
      const take = Math.min(remaining, quantity - skipped);
      if (take > 0) allocations.push({ lot: movement.lot, quantity: take, unitCost: dec(movement.unitCost) });
      remaining -= take;
    }
    if (remaining > 0) throw new ReturnError("The original stock allocation is missing. Reconcile this historical sale before returning it.");
    const totalCost = allocations.reduce((s, a) => s.plus(a.unitCost.times(a.quantity)), dec(0));

    return db.$transaction(async (tx) => {
      const returnNumber = await nextDocumentNumber(tx, "RTN", returnDate);

      const accountId = async (code: string) => {
        const a = await tx.account.findUnique({ where: { code }, select: { id: true } });
        if (!a) throw new ReturnError(`Account ${code} is missing from the chart of accounts.`);
        return a.id;
      };

      // --- the money ------------------------------------------------------
      // Shown as a return against revenue rather than netted off sales, so a
      // style with a return problem is visible instead of merely selling less.
      const refundCode =
        input.refundMethod === "AGAINST_BALANCE"
          ? ACC.RECEIVABLE
          : REFUND_ACCOUNT[input.refundMethod];
      if (!refundCode) throw new ReturnError(`Cannot refund by ${input.refundMethod}.`);

      const lines: Parameters<typeof postEntry>[1]["lines"] = [];

      if (refund.greaterThan(0)) {
        lines.push({
          accountId: await accountId(ACC.SALES_RETURNS),
          debit: refund,
          entityId,
          customerId: picture.order.customerId,
          description: `Return ${returnNumber} against ${picture.order.orderNumber}`,
        });
        lines.push({
          accountId: await accountId(refundCode),
          credit: input.refundMethod === "AGAINST_BALANCE" ? credit : cashRefund,
          entityId,
          customerId: picture.order.customerId,
          description:
            input.refundMethod === "AGAINST_BALANCE"
              ? `Set against what they owe on ${picture.order.orderNumber}`
              : `Refunded to customer for ${returnNumber}`,
        });
        if (credit.greaterThan(0) && input.refundMethod !== "AGAINST_BALANCE") {
          lines.push({ accountId: await accountId(ACC.RECEIVABLE), credit, entityId,
            customerId: picture.order.customerId, description: `Debt credited on ${returnNumber}` });
        }
      }

      // --- the goods ------------------------------------------------------
      // Cost of sales is relieved either way: the sale did not happen. What
      // differs is whether the garment becomes stock again or a loss.
      lines.push({
        accountId: await accountId(restocking ? ACC.FG_BRAND : ACC.STOCK_LOSS),
        debit: totalCost,
        entityId,
        description: restocking
          ? `Back on the shelf from ${returnNumber}`
          : `Unsellable return ${returnNumber}`,
      });
      lines.push({
        accountId: await accountId(ACC.COGS_BRAND),
        credit: totalCost,
        entityId,
        description: `Cost of sales reversed for ${returnNumber}`,
      });

      const entry = await postEntry(tx, {
        entityId,
        postingDate: returnDate,
        sourceType: "SALES_RETURN",
        sourceId: input.salesOrderId,
        memo: `Return ${returnNumber} — ${line.sku} ×${input.quantity}`,
        ctx,
        lines,
      });

      // Cash handed back leaves the drawer open where the return is taken;
      // left out, the till reads short by exactly the refund.
      if (input.refundMethod === "CASH" && cashRefund.greaterThan(0)) {
        await recordTillCash(tx, {
          locationId: picture.order.locationId,
          kind: "REFUND",
          amount: cashRefund.negated(),
          reference: returnNumber,
        });
      }

      // A credit note settles part of the invoice, so it is recorded against
      // the order as well as in the ledger.
      //
      // What a customer owes is never stored — it is always the order total
      // less what has settled it. Crediting account 1210 without settling the
      // order would make the ledger and the customer's account disagree, which
      // is the exact drift that rule exists to prevent.
      if (credit.greaterThan(0)) {
        await tx.salesPayment.create({
          data: {
            salesOrderId: input.salesOrderId,
            method: "STORE_CREDIT",
            amount: credit.toString(),
            fee: "0",
            status: "COLLECTED",
            collectedAt: returnDate,
            reference: returnNumber,
          },
        });
      }

      // --- the shelf ------------------------------------------------------
      let restocked = 0;
      // Needing repair is not the same as ready to sell. It comes back onto
      // the books at its cost, but held until somebody releases it — see
      // `releaseRepairedStock` — so the till cannot sell the fault back out.
      const needsRepair = input.disposition === "REPAIR_AND_RESTOCK";
      if (restocking) {
        for (const allocation of allocations) {
        const lotNumber = await nextDocumentNumber(tx, "LOT", returnDate);

        const originalLot = allocation.lot;
        const unitCost = allocation.unitCost;
        const lot = await tx.inventoryLot.create({
          data: {
            lotNumber,
            state: needsRepair ? "AWAITING_REPAIR" : "FINISHED_GOODS",
            variantId: input.variantId,
            locationId: picture.order.locationId,
            entityId,
            productionOrderId: originalLot?.productionOrderId ?? null,
            originalQty: String(allocation.quantity),
            remainingQty: String(allocation.quantity),
            unitCost: unitCost.toString(),
            receivedDate: originalLot?.receivedDate ?? returnDate,
            labelsPrintedAt: originalLot?.labelsPrintedAt ?? returnDate,
            transferMarginPerUnit: originalLot?.transferMarginPerUnit ?? null,
            sourceCostSnapshotId: originalLot?.sourceCostSnapshotId ?? null,
          },
        });

        await tx.inventoryMovement.create({
          data: {
            lotId: lot.id,
            type: "RETURN_IN",
            direction: "IN",
            quantity: String(allocation.quantity),
            unitCost: unitCost.toString(),
            totalCost: unitCost.times(allocation.quantity).toString(),
            movementDate: returnDate,
            toLocationId: picture.order.locationId,
            referenceType: "RETURN",
            referenceId: returnNumber,
            journalEntryId: entry.id,
            notes: input.reason ?? null,
          },
        });

        // The garments themselves come back, so a tag that was sold can be
        // scanned again rather than reading as sold forever.
        const units = await tx.garmentUnit.findMany({
          where: {
            variantId: input.variantId,
            status: "SOLD",
            salesOrderLine: { salesOrderId: input.salesOrderId },
          },
          orderBy: { soldAt: "desc" },
          take: allocation.quantity,
          select: { id: true },
        });
        if (units.length > 0) {
          await tx.garmentUnit.updateMany({
            where: { id: { in: units.map((u) => u.id) } },
            data: {
              // A garment waiting for repair scans as returned, not in stock.
              status: needsRepair ? "RETURNED" : "IN_STOCK",
              lotId: lot.id,
              locationId: picture.order.locationId,
              salesOrderLineId: null,
              soldAt: null,
            },
          });
        }

        restocked += allocation.quantity;
        }
      }

      const record = await tx.return.create({
        data: {
          returnNumber,
          salesOrderId: input.salesOrderId,
          variantId: input.variantId,
          quantity: input.quantity,
          reason: input.reason ?? null,
          disposition: input.disposition,
          refundAmount: refund.toString(),
          costAmount: totalCost.toString(),
          creditAmount: credit.toString(),
          returnDate,
        },
      });

      await writeAudit(tx, {
        action: "SALE_RETURNED",
        entityName: "Return",
        entityId: record.id,
        after: {
          returnNumber,
          order: picture.order.orderNumber,
          sku: line.sku,
          quantity: input.quantity,
          refund: refund.toString(),
          cashRefund: cashRefund.toString(),
          credit: credit.toString(),
          refundMethod: input.refundMethod,
          disposition: input.disposition,
          restocked,
          reason: input.reason ?? null,
        },
        ctx,
      });

      return {
        returnNumber,
        refunded: refund.toString(),
        cashRefunded: cashRefund.toString(),
        creditedBalance: credit.toString(),
        restocked,
        journalEntryId: entry.id,
      };
    });
  });
}

/**
 * Puts a repaired return back on sale.
 *
 * Its quantity and cost do not change — it was never out of the books — only
 * whether it may be sold. The person releasing it is recorded, because saying
 * a garment is fit to sell again is a judgment somebody is answerable for.
 */
export async function releaseRepairedStock(
  input: { lotId: string; note?: string | null },
  ctx: AuditContext,
): Promise<{ lotNumber: string; released: number }> {
  return command("returns.releaseRepairedStock", input, ctx, async () => {
    return db.$transaction(async (tx) => {
      const lot = await tx.inventoryLot.findUnique({ where: { id: input.lotId } });
      if (!lot) throw new ReturnError("That lot no longer exists.");
      if (lot.state !== "AWAITING_REPAIR") {
        throw new ReturnError(`${lot.lotNumber} is not waiting for repair.`);
      }

      await tx.inventoryLot.update({ where: { id: lot.id }, data: { state: "FINISHED_GOODS" } });
      await tx.garmentUnit.updateMany({
        where: { lotId: lot.id, status: "RETURNED" },
        data: { status: "IN_STOCK" },
      });

      await writeAudit(tx, {
        action: "REPAIRED_STOCK_RELEASED",
        entityName: "InventoryLot",
        entityId: lot.id,
        before: { state: "AWAITING_REPAIR" },
        after: { state: "FINISHED_GOODS", note: input.note ?? null },
        ctx,
      });

      return { lotNumber: lot.lotNumber, released: Number(lot.remainingQty) };
    });
  });
}

/** Returned garments held back until repaired. */
export async function awaitingRepair() {
  const lots = await db.inventoryLot.findMany({
    where: { state: "AWAITING_REPAIR", remainingQty: { gt: 0 } },
    include: { variant: { include: { style: true } }, location: true },
    orderBy: { createdAt: "asc" },
  });
  return lots.map((l) => ({
    lotId: l.id,
    lotNumber: l.lotNumber,
    sku: l.variant?.sku ?? "—",
    nameEn: l.variant?.style.nameEn ?? "—",
    nameAr: l.variant?.style.nameAr ?? "—",
    location: l.location?.nameAr || l.location?.nameEn || "—",
    quantity: Number(l.remainingQty),
    since: l.createdAt,
  }));
}

/** Orders a customer could bring something back from. */
export async function recentOrdersForReturn(search?: string | null, limit = 40) {
  const orders = await db.salesOrder.findMany({
    where: {
      status: { not: "CANCELLED" },
      ...(search?.trim()
        ? {
            OR: [
              { orderNumber: { contains: search.trim(), mode: "insensitive" as const } },
              { customer: { name: { contains: search.trim(), mode: "insensitive" as const } } },
              { customer: { phone: { contains: search.trim() } } },
            ],
          }
        : {}),
    },
    include: {
      customer: true,
      lines: true,
      payments: { select: { amount: true } },
    },
    orderBy: { orderDate: "desc" },
    take: limit,
  });

  const returns = await db.return.groupBy({
    by: ["salesOrderId"],
    where: { salesOrderId: { in: orders.map((o) => o.id) } },
    _sum: { quantity: true, refundAmount: true },
  });
  const returnedFor = new Map(returns.map((r) => [r.salesOrderId, r]));

  return orders.map((o) => {
    const sold = o.lines.reduce((s, l) => s + l.quantity, 0);
    const back = returnedFor.get(o.id)?._sum.quantity ?? 0;
    return {
      id: o.id,
      orderNumber: o.orderNumber,
      orderDate: o.orderDate,
      source: o.source,
      customerName: o.customer?.name ?? null,
      customerPhone: o.customer?.phone ?? null,
      netAmount: dec(o.netAmount).toString(),
      units: sold,
      returnedUnits: back,
      refunded: dec(returnedFor.get(o.id)?._sum.refundAmount ?? 0).toString(),
      fullyReturned: back >= sold,
    };
  });
}

/** What has come back lately, and what it cost. */
export async function recentReturns(limit = 60) {
  const returns = await db.return.findMany({
    include: {
      salesOrder: { include: { customer: true } },
      variant: { include: { style: true, colorCode: true, sizeCode: true } },
    },
    orderBy: [{ returnDate: "desc" }, { createdAt: "desc" }],
    take: limit,
  });

  return returns.map((r) => ({
    id: r.id,
    returnNumber: r.returnNumber,
    orderNumber: r.salesOrder.orderNumber,
    customerName: r.salesOrder.customer?.name ?? null,
    sku: r.variant.sku,
    styleName: r.variant.style.nameAr || r.variant.style.nameEn,
    colour: r.variant.colorCode.nameAr || r.variant.colorCode.code,
    size: r.variant.sizeCode.code,
    quantity: r.quantity,
    refundAmount: dec(r.refundAmount).toString(),
    disposition: r.disposition,
    reason: r.reason,
    returnDate: r.returnDate,
  }));
}

/**
 * Which styles come back most.
 *
 * A style with a high return rate is usually telling you something specific —
 * the sizing is wrong, or the photograph flatters it — and that is worth
 * knowing before the next production run rather than after.
 */
export async function returnRateByStyle(): Promise<
  { styleId: string; styleName: string; sold: number; returned: number; rate: string }[]
> {
  const [soldLines, returns] = await Promise.all([
    db.salesOrderLine.findMany({
      where: { salesOrder: { status: { not: "CANCELLED" } } },
      include: { variant: { include: { style: true } } },
    }),
    db.return.findMany({ include: { variant: { include: { style: true } } } }),
  ]);

  const byStyle = new Map<string, { name: string; sold: number; returned: number }>();

  for (const l of soldLines) {
    const style = l.variant.style;
    const row = byStyle.get(style.id) ?? {
      name: style.nameAr || style.nameEn,
      sold: 0,
      returned: 0,
    };
    row.sold += l.quantity;
    byStyle.set(style.id, row);
  }

  for (const r of returns) {
    const style = r.variant.style;
    const row = byStyle.get(style.id) ?? {
      name: style.nameAr || style.nameEn,
      sold: 0,
      returned: 0,
    };
    row.returned += r.quantity;
    byStyle.set(style.id, row);
  }

  return [...byStyle.entries()]
    .filter(([, r]) => r.returned > 0)
    .map(([styleId, r]) => ({
      styleId,
      styleName: r.name,
      sold: r.sold,
      returned: r.returned,
      rate: r.sold > 0 ? ((r.returned / r.sold) * 100).toFixed(1) : "0.0",
    }))
    .sort((a, b) => Number(b.rate) - Number(a.rate));
}
