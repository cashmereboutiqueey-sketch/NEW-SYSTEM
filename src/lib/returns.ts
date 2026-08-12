import "server-only";
import { db } from "./db";
import { postEntry, nextDocumentNumber } from "./ledger";
import { dec, roundMoney, type Decimal } from "./money";
import { writeAudit, type AuditContext } from "./audit";
import { outstandingOnOrder } from "./receivables";

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
    reason?: string | null;
    returnDate: Date;
  },
  ctx: AuditContext,
): Promise<{
  returnNumber: string;
  refunded: string;
  restocked: number;
  journalEntryId: string;
}> {
  if (input.quantity <= 0) throw new ReturnError("A return needs at least one garment.");

  const picture = await returnableLines(input.salesOrderId);
  const line = picture.lines.find((l) => l.variantId === input.variantId);
  if (!line) throw new ReturnError("That garment is not on this order.");

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

  const returnDate = asDay(input.returnDate);
  const restocking = input.disposition !== "WRITE_OFF";
  // The cost the garment left at, frozen on the line that sold it.
  const unitCost = dec(line.unitCost);
  const totalCost = unitCost.times(input.quantity);

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
        credit: refund,
        entityId,
        customerId: picture.order.customerId,
        description:
          input.refundMethod === "AGAINST_BALANCE"
            ? `Set against what they owe on ${picture.order.orderNumber}`
            : `Refunded to customer for ${returnNumber}`,
      });
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

    // A credit note settles part of the invoice, so it is recorded against
    // the order as well as in the ledger.
    //
    // What a customer owes is never stored — it is always the order total
    // less what has settled it. Crediting account 1210 without settling the
    // order would make the ledger and the customer's account disagree, which
    // is the exact drift that rule exists to prevent.
    if (input.refundMethod === "AGAINST_BALANCE" && refund.greaterThan(0)) {
      await tx.salesPayment.create({
        data: {
          salesOrderId: input.salesOrderId,
          method: "STORE_CREDIT",
          amount: refund.toString(),
          fee: "0",
          status: "COLLECTED",
          collectedAt: returnDate,
          reference: returnNumber,
        },
      });
    }

    // --- the shelf ------------------------------------------------------
    let restocked = 0;
    if (restocking) {
      const lotNumber = await nextDocumentNumber(tx, "LOT", returnDate);

      // A new lot at the original cost, keeping the original receipt date so
      // the aging clock is not laundered by the trip out and back.
      const originalLot = await tx.inventoryLot.findFirst({
        where: { variantId: input.variantId, entityId },
        orderBy: [{ receivedDate: "asc" }, { sequence: "asc" }],
        select: { receivedDate: true, labelsPrintedAt: true, productionOrderId: true },
      });

      const lot = await tx.inventoryLot.create({
        data: {
          lotNumber,
          state: "FINISHED_GOODS",
          variantId: input.variantId,
          locationId: picture.order.locationId,
          entityId,
          productionOrderId: originalLot?.productionOrderId ?? null,
          originalQty: String(input.quantity),
          remainingQty: String(input.quantity),
          unitCost: unitCost.toString(),
          receivedDate: originalLot?.receivedDate ?? returnDate,
          labelsPrintedAt: originalLot?.labelsPrintedAt ?? returnDate,
        },
      });

      await tx.inventoryMovement.create({
        data: {
          lotId: lot.id,
          type: "RETURN_IN",
          quantity: String(input.quantity),
          unitCost: unitCost.toString(),
          totalCost: totalCost.toString(),
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
        take: input.quantity,
        select: { id: true },
      });
      if (units.length > 0) {
        await tx.garmentUnit.updateMany({
          where: { id: { in: units.map((u) => u.id) } },
          data: {
            status: "IN_STOCK",
            lotId: lot.id,
            locationId: picture.order.locationId,
            salesOrderLineId: null,
            soldAt: null,
          },
        });
      }

      restocked = input.quantity;
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
      restocked,
      journalEntryId: entry.id,
    };
  });
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
