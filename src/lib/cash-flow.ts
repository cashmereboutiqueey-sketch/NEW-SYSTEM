import "server-only";
import { db } from "./db";
import { dec, type Decimal } from "./money";

/**
 * The cash forecast.
 *
 * Four things move money, and all four are already recorded somewhere:
 *
 *   - unpaid expenses, which have a due date
 *   - purchase orders raised and not yet received, which will be invoiced
 *   - payments still pending — chiefly cash on delivery the courier holds
 *   - scheduled items like payroll and rent, which have no invoice yet but
 *     will absolutely need funding
 *
 * Nothing here is a projection of sales. Forecasting revenue would turn this
 * into a wish; every line below is an obligation that already exists or money
 * already earned. The one thing a forecast must not do is make next month look
 * survivable because of orders nobody has placed.
 */

export type CashWeek = {
  weekStart: Date;
  weekEnd: Date;
  inflow: Decimal;
  outflow: Decimal;
  net: Decimal;
  closingBalance: Decimal;
  lines: {
    kind: "EXPENSE" | "PURCHASE_COMMITMENT" | "RECEIVABLE" | "SCHEDULED";
    labelEn: string;
    labelAr: string;
    date: Date;
    amount: Decimal;
    direction: "IN" | "OUT";
  }[];
};

const WEEK = 7 * 86_400_000;

function startOfWeek(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Weeks run Saturday to Friday, which is the working week here.
  const shift = (d.getUTCDay() + 1) % 7;
  d.setUTCDate(d.getUTCDate() - shift);
  return d;
}

/** Cash in the bank right now, from the posted ledger. */
async function currentCash(entityId: string | null): Promise<Decimal> {
  const rows = await db.$queryRaw<{ balance: string }[]>`
    SELECT COALESCE(SUM(l."debit") - SUM(l."credit"), 0)::text AS balance
    FROM "journal_lines" l
    JOIN "journal_entries" e ON e."id" = l."journalEntryId"
    JOIN "accounts" a ON a."id" = l."accountId"
    WHERE a."reportingCategory" = 'CASH'
      AND e."status" = 'POSTED'
      AND (${entityId}::text IS NULL OR l."entityId" = ${entityId})
  `;
  return dec(rows[0]?.balance ?? 0);
}

export async function cashForecast(entityId: string | null, weeks = 13) {
  const today = new Date();
  const horizon = new Date(today.getTime() + weeks * WEEK);

  const [expenses, purchaseOrders, pendingPayments, scheduled, opening] = await Promise.all([
    db.expense.findMany({
      where: {
        status: { in: ["UNPAID", "PARTIALLY_PAID"] },
        ...(entityId ? { entityId } : {}),
      },
      include: { supplier: true },
    }),
    db.purchaseOrder.findMany({
      where: { status: { in: ["CONFIRMED", "PARTIALLY_RECEIVED"] } },
      include: { supplier: true, lines: true },
    }),
    db.salesPayment.findMany({
      where: {
        status: "PENDING",
        ...(entityId ? { salesOrder: { entityId } } : {}),
      },
      include: { salesOrder: { include: { channel: true } } },
    }),
    db.scheduledCashItem.findMany({
      where: { isActive: true, ...(entityId ? { entityId } : {}) },
    }),
    currentCash(entityId),
  ]);

  const lines: CashWeek["lines"] = [];

  // --- obligations with a date on them ----------------------------------
  for (const e of expenses) {
    const outstanding = dec(e.amount).minus(dec(e.paidAmount));
    if (outstanding.lessThanOrEqualTo(0)) continue;
    // Anything already past due is money that has to go out now, not on a
    // date that has been and gone.
    const due = e.dueDate < today ? today : e.dueDate;
    if (due > horizon) continue;
    lines.push({
      kind: "EXPENSE",
      labelEn: e.supplier ? `${e.description} — ${e.supplier.nameEn}` : e.description,
      labelAr: e.supplier ? `${e.description} — ${e.supplier.nameAr}` : e.description,
      date: due,
      amount: outstanding,
      direction: "OUT",
    });
  }

  // --- ordered, not yet invoiced ----------------------------------------
  for (const po of purchaseOrders) {
    const outstanding = po.lines.reduce(
      (s, l) => s.plus(dec(l.effectiveCost).times(dec(l.quantity).minus(dec(l.receivedQty)))),
      dec(0),
    );
    if (outstanding.lessThanOrEqualTo(0)) continue;

    // Payable when the goods land plus the credit agreed, since the invoice
    // follows the delivery rather than the order.
    const expected = po.expectedDate ?? po.orderDate;
    const payable = new Date(expected.getTime() + po.creditDays * 86_400_000);
    if (payable > horizon) continue;

    lines.push({
      kind: "PURCHASE_COMMITMENT",
      labelEn: `${po.poNumber} — ${po.supplier.nameEn}`,
      labelAr: `${po.poNumber} — ${po.supplier.nameAr}`,
      date: payable < today ? today : payable,
      amount: outstanding,
      direction: "OUT",
    });
  }

  // --- money earned and not yet in hand ---------------------------------
  for (const p of pendingPayments) {
    const days = p.salesOrder.channel?.collectionDays ?? 0;
    const arriving = new Date(p.salesOrder.orderDate.getTime() + days * 86_400_000);
    if (arriving > horizon) continue;
    lines.push({
      kind: "RECEIVABLE",
      labelEn: `${p.salesOrder.orderNumber} — ${p.method}`,
      labelAr: `${p.salesOrder.orderNumber} — ${p.method}`,
      date: arriving < today ? today : arriving,
      amount: dec(p.amount).minus(dec(p.fee)),
      direction: "IN",
    });
  }

  // --- payroll, rent, instalments ---------------------------------------
  for (const item of scheduled) {
    if (item.endDate && item.endDate < today) continue;

    const monthStep =
      item.frequency === "QUARTERLY" ? 3 : item.frequency === "ANNUAL" ? 12 : 1;

    // Walk forward to the horizon, placing each occurrence on its day. A
    // one-off is placed once, on its start date, and never repeats.
    if (item.frequency === "ONE_OFF") {
      if (item.startDate >= today && item.startDate <= horizon) {
        lines.push({
          kind: "SCHEDULED",
          labelEn: item.nameEn,
          labelAr: item.nameAr,
          date: item.startDate,
          amount: dec(item.amount),
          direction: item.direction === "INFLOW" ? "IN" : "OUT",
        });
      }
      continue;
    }

    const cursor = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), item.dayOfMonth),
    );
    while (cursor <= horizon) {
      if (cursor >= today && cursor >= item.startDate && (!item.endDate || cursor <= item.endDate)) {
        lines.push({
          kind: "SCHEDULED",
          labelEn: item.nameEn,
          labelAr: item.nameAr,
          date: new Date(cursor),
          amount: dec(item.amount),
          direction: item.direction === "INFLOW" ? "IN" : "OUT",
        });
      }
      cursor.setUTCMonth(cursor.getUTCMonth() + monthStep);
    }
  }

  // --- lay them out week by week ----------------------------------------
  const buckets: CashWeek[] = [];
  let cursor = startOfWeek(today);
  let running = opening;

  for (let i = 0; i < weeks; i++) {
    const weekStart = new Date(cursor);
    const weekEnd = new Date(cursor.getTime() + WEEK - 1);

    const inWeek = lines.filter((l) => l.date >= weekStart && l.date <= weekEnd);
    const inflow = inWeek
      .filter((l) => l.direction === "IN")
      .reduce((s, l) => s.plus(l.amount), dec(0));
    const outflow = inWeek
      .filter((l) => l.direction === "OUT")
      .reduce((s, l) => s.plus(l.amount), dec(0));

    const net = inflow.minus(outflow);
    running = running.plus(net);

    buckets.push({
      weekStart,
      weekEnd,
      inflow,
      outflow,
      net,
      closingBalance: running,
      lines: inWeek.sort((a, b) => a.date.getTime() - b.date.getTime()),
    });

    cursor = new Date(cursor.getTime() + WEEK);
  }

  // The first week the balance goes under is the one that matters; everything
  // after it is a consequence rather than a separate problem.
  const firstShortfall = buckets.find((b) => b.closingBalance.lessThan(0)) ?? null;
  const lowest = buckets.reduce(
    (worst, b) => (b.closingBalance.lessThan(worst.closingBalance) ? b : worst),
    buckets[0],
  );

  return {
    opening,
    weeks: buckets,
    firstShortfall,
    lowest,
    totalIn: buckets.reduce((s, b) => s.plus(b.inflow), dec(0)),
    totalOut: buckets.reduce((s, b) => s.plus(b.outflow), dec(0)),
    closing: buckets.length > 0 ? buckets[buckets.length - 1].closingBalance : opening,
  };
}
