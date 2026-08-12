import "server-only";
import { db } from "./db";
import { postEntry, nextDocumentNumber } from "./ledger";
import { dec, roundMoney, type Decimal } from "./money";
import { writeAudit, type AuditContext } from "./audit";
import { createSale } from "./sales";

/**
 * Made to order: somebody wants a garment the shop does not have.
 *
 * This is deliberately not a SalesOrder. There is nothing to sell yet — no
 * stock exists, so nothing can be relieved and no revenue can be recognised.
 * Writing it as a sale on the day it is agreed would book income for a coat
 * that has not been cut, and would then have to relieve stock that is not
 * there.
 *
 * So the money moves twice, and means different things each time:
 *
 *   deposit taken:  DR cash            CR customer deposits (a liability)
 *   on delivery:    DR customer deposits  DR cash  CR revenue
 *
 * Between those two, the shop is holding somebody's money against a promise.
 * That is a debt, and it belongs on the liabilities side until the garment is
 * in the customer's hands. Cancelling means giving it back.
 *
 * The deposit is optional by choice. It is a judgement about the customer,
 * not a rule — but the screen shows what is at risk when there is none,
 * because the whole exposure of a bespoke piece is that nobody else wants it.
 */

export class CustomOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomOrderError";
  }
}

const ACC = {
  POS_DRAWER: "1115",
  BANK: "1120",
  CUSTOMER_DEPOSITS: "2400",
} as const;

const DEPOSIT_FUNDS: Record<string, string> = {
  CASH: ACC.POS_DRAWER,
  CARD: ACC.BANK,
  BANK_TRANSFER: ACC.BANK,
  INSTAPAY: ACC.BANK,
};

function asDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ----------------------------------------------------------------- taking

export async function takeCustomOrder(
  input: {
    customerId: string;
    variantId: string;
    quantity: number;
    agreedUnitPrice: string;
    deposit?: { amount: string; method: "CASH" | "CARD" | "BANK_TRANSFER" | "INSTAPAY" } | null;
    entityId: string;
    locationId: string;
    promisedDate?: Date | null;
    orderDate: Date;
    notes?: string | null;
  },
  ctx: AuditContext,
): Promise<{ id: string; orderNumber: string; agreedTotal: string; deposit: string }> {
  if (input.quantity <= 0) {
    throw new CustomOrderError("A custom order needs at least one piece.");
  }

  const unitPrice = roundMoney(dec(input.agreedUnitPrice));
  if (unitPrice.lessThan(0)) throw new CustomOrderError("The price cannot be negative.");

  const total = roundMoney(unitPrice.times(input.quantity));
  const deposit = input.deposit ? roundMoney(dec(input.deposit.amount)) : dec(0);

  if (deposit.lessThan(0)) throw new CustomOrderError("A deposit cannot be negative.");
  if (deposit.greaterThan(total)) {
    // Otherwise the shop owes the customer money on the day it delivers.
    throw new CustomOrderError(
      `The deposit of ${deposit.toFixed(2)} is more than the ${total.toFixed(2)} agreed.`,
    );
  }

  const [customer, variant] = await Promise.all([
    db.customer.findUnique({ where: { id: input.customerId } }),
    db.variant.findUnique({
      where: { id: input.variantId },
      include: { style: true, colorCode: true, sizeCode: true },
    }),
  ]);
  if (!customer) throw new CustomOrderError("Customer not found.");
  if (!variant) throw new CustomOrderError("That style, colour and size does not exist.");

  const orderDate = asDay(input.orderDate);
  if (input.promisedDate && asDay(input.promisedDate) < orderDate) {
    throw new CustomOrderError("The promised date is before the order was taken.");
  }

  return db.$transaction(async (tx) => {
    const orderNumber = await nextDocumentNumber(tx, "CUS", orderDate);

    const order = await tx.customOrder.create({
      data: {
        orderNumber,
        status: "PENDING",
        customerId: input.customerId,
        variantId: input.variantId,
        quantity: input.quantity,
        agreedUnitPrice: unitPrice.toString(),
        agreedTotal: total.toString(),
        depositAmount: deposit.toString(),
        entityId: input.entityId,
        locationId: input.locationId,
        promisedDate: input.promisedDate ? asDay(input.promisedDate) : null,
        notes: input.notes ?? null,
        createdByUserId: ctx.userId,
      },
    });

    if (deposit.greaterThan(0)) {
      const fundsCode = DEPOSIT_FUNDS[input.deposit!.method];
      if (!fundsCode) throw new CustomOrderError(`Cannot take a deposit by ${input.deposit!.method}.`);

      const [funds, liability] = await Promise.all([
        tx.account.findUniqueOrThrow({ where: { code: fundsCode }, select: { id: true } }),
        tx.account.findUniqueOrThrow({
          where: { code: ACC.CUSTOMER_DEPOSITS },
          select: { id: true },
        }),
      ]);

      // The money is real, the sale is not. It sits as something the shop
      // owes until the garment is handed over.
      await postEntry(tx, {
        entityId: input.entityId,
        postingDate: orderDate,
        sourceType: "PAYMENT",
        sourceId: order.id,
        memo: `Deposit on ${orderNumber} — ${customer.name}`,
        ctx,
        lines: [
          {
            accountId: funds.id,
            debit: deposit,
            entityId: input.entityId,
            customerId: input.customerId,
            description: `Deposit taken for ${orderNumber}`,
          },
          {
            accountId: liability.id,
            credit: deposit,
            entityId: input.entityId,
            customerId: input.customerId,
            description: `Held against ${orderNumber}`,
          },
        ],
      });
    }

    await writeAudit(tx, {
      action: "CUSTOM_ORDER_TAKEN",
      entityName: "CustomOrder",
      entityId: order.id,
      after: {
        orderNumber,
        customer: customer.name,
        sku: variant.sku,
        quantity: input.quantity,
        agreedTotal: total.toString(),
        deposit: deposit.toString(),
      },
      ctx,
    });

    return {
      id: order.id,
      orderNumber,
      agreedTotal: total.toString(),
      deposit: deposit.toString(),
    };
  });
}

/** Take more money against a promise already made. */
export async function addDeposit(
  input: {
    customOrderId: string;
    amount: string;
    method: "CASH" | "CARD" | "BANK_TRANSFER" | "INSTAPAY";
    paidOn: Date;
  },
  ctx: AuditContext,
): Promise<{ deposit: string; stillDue: string }> {
  const amount = roundMoney(dec(input.amount));
  if (amount.lessThanOrEqualTo(0)) throw new CustomOrderError("A deposit has to be more than zero.");

  const order = await db.customOrder.findUnique({
    where: { id: input.customOrderId },
    include: { customer: true },
  });
  if (!order) throw new CustomOrderError("Custom order not found.");
  if (order.status === "DELIVERED") {
    throw new CustomOrderError("This order has been delivered; take payment against the sale instead.");
  }
  if (order.status === "CANCELLED") {
    throw new CustomOrderError("This order was cancelled.");
  }

  const already = dec(order.depositAmount);
  const total = dec(order.agreedTotal);
  if (already.plus(amount).greaterThan(total)) {
    throw new CustomOrderError(
      `That would hold ${already.plus(amount).toFixed(2)} against an order of ${total.toFixed(2)}.`,
    );
  }

  const fundsCode = DEPOSIT_FUNDS[input.method];
  if (!fundsCode) throw new CustomOrderError(`Cannot take a deposit by ${input.method}.`);

  return db.$transaction(async (tx) => {
    const [funds, liability] = await Promise.all([
      tx.account.findUniqueOrThrow({ where: { code: fundsCode }, select: { id: true } }),
      tx.account.findUniqueOrThrow({
        where: { code: ACC.CUSTOMER_DEPOSITS },
        select: { id: true },
      }),
    ]);

    await postEntry(tx, {
      entityId: order.entityId,
      postingDate: asDay(input.paidOn),
      sourceType: "PAYMENT",
      sourceId: order.id,
      memo: `Further deposit on ${order.orderNumber}`,
      ctx,
      lines: [
        {
          accountId: funds.id, debit: amount, entityId: order.entityId,
          customerId: order.customerId, description: `Deposit for ${order.orderNumber}`,
        },
        {
          accountId: liability.id, credit: amount, entityId: order.entityId,
          customerId: order.customerId, description: `Held against ${order.orderNumber}`,
        },
      ],
    });

    const updated = await tx.customOrder.update({
      where: { id: order.id },
      data: { depositAmount: already.plus(amount).toString() },
    });

    await writeAudit(tx, {
      action: "CUSTOM_ORDER_DEPOSIT_ADDED",
      entityName: "CustomOrder",
      entityId: order.id,
      before: { deposit: already.toString() },
      after: { deposit: updated.depositAmount.toString(), method: input.method },
      ctx,
    });

    return {
      deposit: dec(updated.depositAmount).toString(),
      stillDue: total.minus(dec(updated.depositAmount)).toString(),
    };
  });
}

// ------------------------------------------------------------- production

/**
 * Attach the run that will make it.
 *
 * The run is raised through the normal production route, so the cloth is
 * issued, the minutes are costed and the variance is measured exactly as they
 * are for the season's own styles. Nothing about a bespoke piece should be
 * cheaper to account for than a batch of two hundred.
 */
export async function linkProductionOrder(
  input: { customOrderId: string; productionOrderId: string },
  ctx: AuditContext,
): Promise<void> {
  const [order, run] = await Promise.all([
    db.customOrder.findUnique({ where: { id: input.customOrderId }, include: { variant: true } }),
    db.productionOrder.findUnique({
      where: { id: input.productionOrderId },
      include: { customOrder: true },
    }),
  ]);
  if (!order) throw new CustomOrderError("Custom order not found.");
  if (!run) throw new CustomOrderError("Production order not found.");

  if (order.status === "CANCELLED") throw new CustomOrderError("This order was cancelled.");
  if (order.status === "DELIVERED") throw new CustomOrderError("This order has already been delivered.");
  if (order.productionOrderId) {
    throw new CustomOrderError(`${order.orderNumber} already has a run against it.`);
  }
  if (run.customOrder && run.customOrder.id !== order.id) {
    throw new CustomOrderError(`${run.orderNumber} is already making another custom order.`);
  }
  if (run.styleId !== order.variant.styleId) {
    // A run for a different style would deliver the wrong garment and nobody
    // would notice until the customer opened the bag.
    throw new CustomOrderError(
      `${run.orderNumber} makes a different style from what the customer asked for.`,
    );
  }
  if (run.plannedQty < order.quantity) {
    throw new CustomOrderError(
      `${run.orderNumber} plans ${run.plannedQty} pieces but the customer asked for ${order.quantity}.`,
    );
  }

  await db.$transaction(async (tx) => {
    await tx.customOrder.update({
      where: { id: order.id },
      data: { productionOrderId: run.id, status: "IN_PRODUCTION" },
    });

    await writeAudit(tx, {
      action: "CUSTOM_ORDER_IN_PRODUCTION",
      entityName: "CustomOrder",
      entityId: order.id,
      after: { orderNumber: order.orderNumber, run: run.orderNumber },
      ctx,
    });
  });
}

/** Made and waiting on the customer. */
export async function markReady(
  input: { customOrderId: string },
  ctx: AuditContext,
): Promise<void> {
  const order = await db.customOrder.findUnique({ where: { id: input.customOrderId } });
  if (!order) throw new CustomOrderError("Custom order not found.");
  if (order.status === "CANCELLED") throw new CustomOrderError("This order was cancelled.");
  if (order.status === "DELIVERED") throw new CustomOrderError("This order has already been delivered.");

  await db.$transaction(async (tx) => {
    await tx.customOrder.update({ where: { id: order.id }, data: { status: "READY" } });
    await writeAudit(tx, {
      action: "CUSTOM_ORDER_READY",
      entityName: "CustomOrder",
      entityId: order.id,
      after: { orderNumber: order.orderNumber },
      ctx,
    });
  });
}

// -------------------------------------------------------------- delivery

/**
 * The customer collects it. Only now is it a sale.
 *
 * The deposit is presented as a payment on that sale, which is exactly what
 * it is: money already received, discharging the liability it created. The
 * rest is whatever they hand over today — and if they hand over nothing, the
 * balance lands on their account under the ordinary credit rules, because a
 * bespoke coat walking out unpaid is the same risk as any other.
 */
export async function deliverCustomOrder(
  input: {
    customOrderId: string;
    deliveredOn: Date;
    payNow?: { amount: string; method: "CASH" | "CARD" | "BANK_TRANSFER" | "INSTAPAY" } | null;
    channelId: string;
  },
  ctx: AuditContext,
): Promise<{ orderNumber: string; salesOrderNumber: string; stillOwed: string }> {
  const order = await db.customOrder.findUnique({
    where: { id: input.customOrderId },
    include: { customer: true, variant: true },
  });
  if (!order) throw new CustomOrderError("Custom order not found.");
  if (order.status === "CANCELLED") throw new CustomOrderError("This order was cancelled.");
  if (order.status === "DELIVERED") {
    throw new CustomOrderError(`${order.orderNumber} has already been delivered.`);
  }

  const total = dec(order.agreedTotal);
  const deposit = dec(order.depositAmount);
  const payNow = input.payNow ? roundMoney(dec(input.payNow.amount)) : dec(0);

  if (payNow.lessThan(0)) throw new CustomOrderError("A payment cannot be negative.");
  if (deposit.plus(payNow).greaterThan(total)) {
    throw new CustomOrderError(
      `The deposit and today's payment come to ${deposit.plus(payNow).toFixed(2)}, more than the ${total.toFixed(2)} agreed.`,
    );
  }

  // The sale relieves real stock, so the garment must actually be on the
  // shelf. If production has not delivered it, this fails here rather than
  // booking revenue for something that does not exist.
  const payments: {
    method: "CASH" | "CARD" | "BANK_TRANSFER" | "INSTAPAY" | "DEPOSIT";
    amount: number;
    fee: number;
    collected: boolean;
  }[] = [];

  if (deposit.greaterThan(0)) {
    payments.push({ method: "DEPOSIT", amount: deposit.toNumber(), fee: 0, collected: true });
  }
  if (payNow.greaterThan(0)) {
    payments.push({
      method: input.payNow!.method,
      amount: payNow.toNumber(),
      fee: 0,
      collected: true,
    });
  }

  const sale = await createSale(
    {
      source: "MANUAL",
      channelId: input.channelId,
      entityId: order.entityId,
      locationId: order.locationId,
      customerId: order.customerId,
      orderDate: asDay(input.deliveredOn),
      notes: `Custom order ${order.orderNumber}`,
      lines: [
        {
          variantId: order.variantId,
          quantity: order.quantity,
          retailPrice: dec(order.agreedUnitPrice).toNumber(),
          discountPct: 0,
        },
      ],
      payments,
    },
    ctx,
  );

  const stillOwed = total.minus(deposit).minus(payNow);

  await db.$transaction(async (tx) => {
    await tx.customOrder.update({
      where: { id: order.id },
      data: {
        status: "DELIVERED",
        deliveredAt: asDay(input.deliveredOn),
        salesOrderId: sale.salesOrderId,
      },
    });

    await writeAudit(tx, {
      action: "CUSTOM_ORDER_DELIVERED",
      entityName: "CustomOrder",
      entityId: order.id,
      after: {
        orderNumber: order.orderNumber,
        salesOrder: sale.orderNumber,
        deposit: deposit.toString(),
        paidOnDelivery: payNow.toString(),
        stillOwed: stillOwed.toString(),
      },
      ctx,
    });
  });

  return {
    orderNumber: order.orderNumber,
    salesOrderNumber: sale.orderNumber,
    stillOwed: stillOwed.toString(),
  };
}

/**
 * The customer changes their mind, or the shop cannot make it.
 *
 * The deposit goes back. Keeping it would be a decision about somebody's
 * money that a stock system has no business making quietly, so the refund is
 * the only behaviour here and anything else is a manual journal somebody
 * signs their name to.
 */
export async function cancelCustomOrder(
  input: {
    customOrderId: string;
    reason: string;
    cancelledOn: Date;
    refundMethod?: "CASH" | "CARD" | "BANK_TRANSFER" | "INSTAPAY";
  },
  ctx: AuditContext,
): Promise<{ refunded: string }> {
  if (!input.reason.trim()) {
    throw new CustomOrderError("Say why it was cancelled — somebody will ask later.");
  }

  const order = await db.customOrder.findUnique({ where: { id: input.customOrderId } });
  if (!order) throw new CustomOrderError("Custom order not found.");
  if (order.status === "DELIVERED") {
    throw new CustomOrderError("This order was delivered; a return is not a cancellation.");
  }
  if (order.status === "CANCELLED") throw new CustomOrderError("Already cancelled.");

  const deposit = dec(order.depositAmount);

  return db.$transaction(async (tx) => {
    if (deposit.greaterThan(0)) {
      const fundsCode = DEPOSIT_FUNDS[input.refundMethod ?? "CASH"];
      const [funds, liability] = await Promise.all([
        tx.account.findUniqueOrThrow({ where: { code: fundsCode }, select: { id: true } }),
        tx.account.findUniqueOrThrow({
          where: { code: ACC.CUSTOMER_DEPOSITS },
          select: { id: true },
        }),
      ]);

      // Exactly the reverse of taking it: the promise is discharged by
      // handing the money back rather than by handing over a garment.
      await postEntry(tx, {
        entityId: order.entityId,
        postingDate: asDay(input.cancelledOn),
        sourceType: "PAYMENT",
        sourceId: order.id,
        memo: `Deposit returned on cancelled ${order.orderNumber}`,
        ctx,
        lines: [
          {
            accountId: liability.id, debit: deposit, entityId: order.entityId,
            customerId: order.customerId,
            description: `Released ${order.orderNumber}`,
          },
          {
            accountId: funds.id, credit: deposit, entityId: order.entityId,
            customerId: order.customerId,
            description: `Refund to customer for ${order.orderNumber}`,
          },
        ],
      });
    }

    await tx.customOrder.update({
      where: { id: order.id },
      data: {
        status: "CANCELLED",
        cancelledAt: asDay(input.cancelledOn),
        cancelReason: input.reason.trim(),
        depositAmount: "0",
      },
    });

    await writeAudit(tx, {
      action: "CUSTOM_ORDER_CANCELLED",
      entityName: "CustomOrder",
      entityId: order.id,
      before: { deposit: deposit.toString(), status: order.status },
      after: { refunded: deposit.toString(), reason: input.reason.trim() },
      ctx,
    });

    return { refunded: deposit.toString() };
  });
}

// ----------------------------------------------------------------- views

export async function customOrderList(includeFinished = false) {
  const orders = await db.customOrder.findMany({
    where: includeFinished
      ? {}
      : { status: { in: ["PENDING", "IN_PRODUCTION", "READY"] } },
    include: {
      customer: true,
      variant: { include: { style: true, colorCode: true, sizeCode: true } },
      productionOrder: true,
      salesOrder: true,
    },
    orderBy: [{ status: "asc" }, { promisedDate: "asc" }, { createdAt: "desc" }],
  });

  return orders.map((o) => ({
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    customerName: o.customer.name,
    customerPhone: o.customer.phone,
    sku: o.variant.sku,
    styleName: o.variant.style.nameAr || o.variant.style.nameEn,
    styleId: o.variant.styleId,
    colour: o.variant.colorCode.nameAr || o.variant.colorCode.code,
    size: o.variant.sizeCode.code,
    quantity: o.quantity,
    agreedTotal: dec(o.agreedTotal).toString(),
    deposit: dec(o.depositAmount).toString(),
    /** What the shop is exposed to if they never come back for it. */
    atRisk: dec(o.agreedTotal).minus(dec(o.depositAmount)).toString(),
    promisedDate: o.promisedDate,
    runNumber: o.productionOrder?.orderNumber ?? null,
    runStatus: o.productionOrder?.status ?? null,
    salesOrderNumber: o.salesOrder?.orderNumber ?? null,
    notes: o.notes,
  }));
}

/** What the shop is holding against promises it has not yet kept. */
export async function depositsHeld(): Promise<Decimal> {
  const open = await db.customOrder.aggregate({
    where: { status: { in: ["PENDING", "IN_PRODUCTION", "READY"] } },
    _sum: { depositAmount: true },
  });
  return dec(open._sum.depositAmount ?? 0);
}

/** Runs that could be attached to a custom order: same style, not yet taken. */
export async function availableRuns(styleId: string) {
  return db.productionOrder.findMany({
    where: {
      styleId,
      status: { notIn: ["CANCELLED"] },
      customOrder: null,
    },
    orderBy: { orderDate: "desc" },
    take: 25,
    select: {
      id: true, orderNumber: true, status: true, plannedQty: true,
      actualQty: true, orderDate: true,
    },
  });
}
