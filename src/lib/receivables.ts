import "server-only";
import { db } from "./db";
import { postEntry, nextDocumentNumber } from "./ledger";
import { dec, roundMoney, type Decimal } from "./money";
import { writeAudit, type AuditContext } from "./audit";

/**
 * What customers owe, and collecting it.
 *
 * A shop that lets people pay half now and half later is running a small bank
 * whether it admits it or not, and the thing that sinks those is not bad debt
 * — it is not knowing who owes what. So the balance is never stored: it is
 * always the order total minus what has actually been collected against it.
 * A stored balance is a number that drifts from the truth the first time
 * somebody edits a payment.
 *
 * The ledger side is deliberately plain:
 *
 *   sale on account:  DR cash (part)  DR receivable (rest)  CR revenue
 *   collection later: DR cash         CR receivable
 *
 * so the receivables account always equals the sum of what the orders say is
 * outstanding. `audit-books.ts` checks exactly that.
 */

export class ReceivableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceivableError";
  }
}

const ACC = {
  CASH: "1110",
  POS_DRAWER: "1115",
  BANK: "1120",
  RECEIVABLE: "1210",
} as const;

/** Where the money lands when somebody comes in and settles up. */
const COLLECTION_ACCOUNT: Record<string, string> = {
  CASH: ACC.POS_DRAWER,
  CARD: ACC.BANK,
  BANK_TRANSFER: ACC.BANK,
  INSTAPAY: ACC.BANK,
};

/**
 * What one order still owes.
 *
 * Only payments actually collected count. A COD payment the courier is still
 * holding is not money the customer owes — it is money somebody else owes —
 * so it reduces the customer's debt but sits in a clearing account until the
 * courier remits.
 */
export function outstandingOnOrder(order: {
  netAmount: Decimal | string;
  shippingAmount: Decimal | string;
  payments: { amount: Decimal | string }[];
}): Decimal {
  const due = dec(order.netAmount).plus(dec(order.shippingAmount));
  const paid = order.payments.reduce((s, p) => s.plus(dec(p.amount)), dec(0));
  return roundMoney(due.minus(paid));
}

/** The total one customer owes across every order. */
export async function outstandingForCustomer(customerId: string): Promise<Decimal> {
  const orders = await db.salesOrder.findMany({
    where: { customerId, status: { not: "CANCELLED" } },
    select: {
      netAmount: true,
      shippingAmount: true,
      payments: { select: { amount: true } },
    },
  });

  return orders.reduce((s, o) => s.plus(outstandingOnOrder(o)), dec(0));
}

/**
 * Everyone who owes something, oldest debt first.
 *
 * Aged against each order's own due date rather than its order date, because
 * a customer on thirty-day terms is not late on day two and should not be
 * chased as though they were.
 */
export async function customerBalances(asOf: Date = new Date()) {
  const orders = await db.salesOrder.findMany({
    where: {
      status: { not: "CANCELLED" },
      customerId: { not: null },
    },
    include: {
      customer: true,
      payments: { select: { amount: true } },
    },
    orderBy: { orderDate: "asc" },
  });

  type Row = {
    customerId: string;
    name: string;
    phone: string | null;
    creditLimit: Decimal;
    creditDays: number;
    outstanding: Decimal;
    notYetDue: Decimal;
    overdue: Decimal;
    oldestDue: Date | null;
    orders: number;
  };

  const rows = new Map<string, Row>();

  for (const order of orders) {
    const owed = outstandingOnOrder(order);
    if (owed.lessThanOrEqualTo(0)) continue;
    if (!order.customer) continue;

    const row = rows.get(order.customer.id) ?? {
      customerId: order.customer.id,
      name: order.customer.name,
      phone: order.customer.phone,
      creditLimit: dec(order.customer.creditLimit),
      creditDays: order.customer.creditDays,
      outstanding: dec(0),
      notYetDue: dec(0),
      overdue: dec(0),
      oldestDue: null,
      orders: 0,
    };

    const due = order.dueDate ?? order.orderDate;
    const isOverdue = due < asOf;

    row.outstanding = row.outstanding.plus(owed);
    if (isOverdue) row.overdue = row.overdue.plus(owed);
    else row.notYetDue = row.notYetDue.plus(owed);
    row.orders += 1;
    if (!row.oldestDue || due < row.oldestDue) row.oldestDue = due;

    rows.set(order.customer.id, row);
  }

  return [...rows.values()]
    .sort((a, b) => {
      // The people who are late come first, and among them the longest wait.
      if (a.overdue.greaterThan(0) !== b.overdue.greaterThan(0)) {
        return a.overdue.greaterThan(0) ? -1 : 1;
      }
      return (a.oldestDue?.getTime() ?? 0) - (b.oldestDue?.getTime() ?? 0);
    })
    .map((r) => ({
      customerId: r.customerId,
      name: r.name,
      phone: r.phone,
      creditLimit: r.creditLimit.toString(),
      creditDays: r.creditDays,
      outstanding: r.outstanding.toString(),
      notYetDue: r.notYetDue.toString(),
      overdue: r.overdue.toString(),
      oldestDue: r.oldestDue,
      orders: r.orders,
      /** How much more they could take on today. */
      headroom: r.creditLimit.minus(r.outstanding).toString(),
    }));
}

/** One customer's account: every order, what was paid, what is left. */
export async function customerStatement(customerId: string) {
  const customer = await db.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw new ReceivableError("Customer not found.");

  const orders = await db.salesOrder.findMany({
    where: { customerId, status: { not: "CANCELLED" } },
    include: {
      payments: { orderBy: { createdAt: "asc" } },
      lines: { include: { variant: true } },
    },
    orderBy: { orderDate: "desc" },
  });

  const lines = orders.map((o) => {
    const due = dec(o.netAmount).plus(dec(o.shippingAmount));
    const paid = o.payments.reduce((s, p) => s.plus(dec(p.amount)), dec(0));
    return {
      orderId: o.id,
      orderNumber: o.orderNumber,
      orderDate: o.orderDate,
      dueDate: o.dueDate,
      total: due.toString(),
      paid: paid.toString(),
      outstanding: roundMoney(due.minus(paid)).toString(),
      units: o.lines.reduce((s, l) => s + l.quantity, 0),
      payments: o.payments.map((p) => ({
        id: p.id,
        method: p.method,
        amount: dec(p.amount).toString(),
        status: p.status,
        collectedAt: p.collectedAt,
        reference: p.reference,
      })),
    };
  });

  const outstanding = lines.reduce((s, l) => s.plus(dec(l.outstanding)), dec(0));

  return {
    customer: {
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      creditLimit: dec(customer.creditLimit).toString(),
      creditDays: customer.creditDays,
    },
    lines,
    totals: {
      outstanding: outstanding.toString(),
      headroom: dec(customer.creditLimit).minus(outstanding).toString(),
      orders: lines.length,
    },
  };
}

/**
 * Somebody comes in and pays off what they owe.
 *
 * Deliberately settles one order at a time rather than "paying the account".
 * When a customer says they are paying for the black coat, the record should
 * say that too — otherwise a dispute six weeks later has nothing to point at.
 */
export async function collectPayment(
  input: {
    salesOrderId: string;
    method: "CASH" | "CARD" | "BANK_TRANSFER" | "INSTAPAY";
    amount: string;
    collectedOn: Date;
    reference?: string | null;
  },
  ctx: AuditContext,
): Promise<{ collected: string; stillOwed: string; orderNumber: string }> {
  const amount = roundMoney(dec(input.amount));
  if (amount.lessThanOrEqualTo(0)) {
    throw new ReceivableError("A collection has to be more than zero.");
  }

  const order = await db.salesOrder.findUnique({
    where: { id: input.salesOrderId },
    include: { payments: { select: { amount: true } }, customer: true },
  });
  if (!order) throw new ReceivableError("Order not found.");
  if (order.status === "CANCELLED") {
    throw new ReceivableError("This order was cancelled; there is nothing to collect.");
  }

  if (!order.customerId) {
    // Every part-paid sale is made in a customer's name, so an order with no
    // customer cannot have a balance to collect. Checked rather than assumed,
    // because the ledger lines below post against the customer.
    throw new ReceivableError("This order is not in anybody's name.");
  }
  const customerId = order.customerId;

  if (!order.entityId) {
    // Which company's books the money lands in. An order without one cannot
    // be posted anywhere, and guessing would put cash in the wrong entity.
    throw new ReceivableError("This order is not attached to a company.");
  }
  const entityId = order.entityId;

  const owed = outstandingOnOrder(order);
  if (owed.lessThanOrEqualTo(0)) {
    throw new ReceivableError(`${order.orderNumber} is already paid in full.`);
  }
  if (amount.greaterThan(owed)) {
    // Taking more than is owed would leave the receivables account negative
    // and the books saying the shop owes the customer.
    throw new ReceivableError(
      `${order.orderNumber} only has ${owed.toFixed(2)} outstanding; ${amount.toFixed(2)} is too much.`,
    );
  }

  const fundsCode = COLLECTION_ACCOUNT[input.method];
  if (!fundsCode) throw new ReceivableError(`Cannot collect by ${input.method}.`);

  return db.$transaction(async (tx) => {
    await tx.salesPayment.create({
      data: {
        salesOrderId: order.id,
        method: input.method,
        amount: amount.toString(),
        fee: "0",
        status: "COLLECTED",
        collectedAt: input.collectedOn,
        reference: input.reference ?? null,
      },
    });

    const stillOwed = roundMoney(owed.minus(amount));

    const [funds, receivable] = await Promise.all([
      tx.account.findUniqueOrThrow({ where: { code: fundsCode }, select: { id: true } }),
      tx.account.findUniqueOrThrow({ where: { code: ACC.RECEIVABLE }, select: { id: true } }),
    ]);

    await postEntry(tx, {
      entityId,
      postingDate: input.collectedOn,
      sourceType: "PAYMENT",
      sourceId: order.id,
      memo: `Collected ${amount.toFixed(2)} against ${order.orderNumber}`,
      ctx,
      lines: [
        {
          accountId: funds.id,
          debit: amount,
          entityId,
          customerId,
          description: `Payment on account ${order.orderNumber}`,
        },
        {
          accountId: receivable.id,
          credit: amount,
          entityId,
          customerId,
          description: `Settles ${order.orderNumber}`,
        },
      ],
    });

    // Cleared in full: the cash-conversion cycle wants to know when the money
    // actually arrived, not when the sale was made.
    if (stillOwed.lessThanOrEqualTo(0)) {
      await tx.salesOrder.update({
        where: { id: order.id },
        data: { collectedDate: input.collectedOn, dueDate: null },
      });
    }

    await writeAudit(tx, {
      action: "PAYMENT_COLLECTED",
      entityName: "SalesOrder",
      entityId: order.id,
      after: {
        orderNumber: order.orderNumber,
        customer: order.customer?.name ?? null,
        method: input.method,
        amount: amount.toString(),
        stillOwed: stillOwed.toString(),
      },
      ctx,
    });

    return {
      collected: amount.toString(),
      stillOwed: stillOwed.toString(),
      orderNumber: order.orderNumber,
    };
  });
}

/** Set how much a customer may owe, and on what terms. */
export async function setCreditTerms(
  input: { customerId: string; creditLimit: string; creditDays: number },
  ctx: AuditContext,
): Promise<void> {
  const limit = dec(input.creditLimit);
  if (limit.lessThan(0)) throw new ReceivableError("A credit limit cannot be negative.");
  if (input.creditDays < 0) throw new ReceivableError("Payment terms cannot be negative.");

  const customer = await db.customer.findUnique({ where: { id: input.customerId } });
  if (!customer) throw new ReceivableError("Customer not found.");

  const owed = await outstandingForCustomer(input.customerId);
  if (limit.lessThan(owed)) {
    // Allowing it would put them instantly over their own limit, and every
    // check downstream would have to special-case that.
    throw new ReceivableError(
      `${customer.name} already owes ${owed.toFixed(2)}; the limit cannot be set below that.`,
    );
  }

  await db.$transaction(async (tx) => {
    await tx.customer.update({
      where: { id: input.customerId },
      data: { creditLimit: limit.toString(), creditDays: input.creditDays },
    });

    await writeAudit(tx, {
      action: "CREDIT_TERMS_SET",
      entityName: "Customer",
      entityId: input.customerId,
      before: {
        creditLimit: dec(customer.creditLimit).toString(),
        creditDays: customer.creditDays,
      },
      after: { creditLimit: limit.toString(), creditDays: input.creditDays },
      ctx,
    });
  });
}

/** Orders with money still on them, for the collection screen. */
export async function openOrdersForCustomer(customerId: string) {
  const orders = await db.salesOrder.findMany({
    where: { customerId, status: { not: "CANCELLED" } },
    include: { payments: { select: { amount: true } } },
    orderBy: { orderDate: "asc" },
  });

  return orders
    .map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      orderDate: o.orderDate,
      dueDate: o.dueDate,
      outstanding: outstandingOnOrder(o).toString(),
    }))
    .filter((o) => dec(o.outstanding).greaterThan(0));
}
