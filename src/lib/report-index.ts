import "server-only";
import { db } from "./db";
import { dec, safeDiv, type Decimal } from "./money";
import { groupProfitAndLoss } from "./consolidation";

/**
 * The headline figures for the reports index.
 *
 * A page that lists eighteen reports is a menu. A page that answers each of
 * their questions in one line is something worth opening in the morning — so
 * this pulls the number that sits on the front of each report.
 *
 * Deliberately cheap: two aggregate queries and a handful of counts, rather
 * than calling eighteen report functions that each walk the ledger. An index
 * nobody waits for is an index people use.
 */

/** Every account balance in one pass, keyed by code. */
async function balances(): Promise<Map<string, Decimal>> {
  const rows = await db.$queryRaw<{ code: string; total: string }[]>`
    SELECT a."code" AS code,
           (SUM(l."debit") - SUM(l."credit"))::text AS total
    FROM "journal_lines" l
    JOIN "journal_entries" e ON e."id" = l."journalEntryId"
    JOIN "accounts" a ON a."id" = l."accountId"
    WHERE e."status" = 'POSTED'
    GROUP BY a."code"
  `;
  return new Map(rows.map((r) => [r.code, dec(r.total)]));
}

export async function reportHeadlines() {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000);

  /**
   * The period today falls in, because a fiscal period is the unit the books
   * are kept in. Month-to-date would be close and occasionally wrong — a
   * period running to the 25th would report five days into the next one.
   *
   * Chosen by date rather than by taking the latest open one: the demo has
   * every month to December open, and the newest of those reported December's
   * figures in August. An empty report is a convincing way to be wrong.
   */
  const today = new Date();
  const period =
    (await db.fiscalPeriod.findFirst({
      where: { startDate: { lte: today }, endDate: { gte: today } },
    })) ??
    // Nothing covers today — a gap in the calendar, or a period not yet
    // created. The most recent one that has started is the honest fallback.
    (await db.fiscalPeriod.findFirst({
      where: { startDate: { lte: today } },
      orderBy: { startDate: "desc" },
    }));

  const [
    bal,
    trading,
    openAlerts,
    unpricedStyles,
    staleStock,
    openApprovals,
    lateInvoices,
    overdueRows,
  ] = await Promise.all([
    balances(),
    /**
     * The group's own figures rather than the two halves added together.
     *
     * Summing both entities counts one garment twice — the factory sells it to
     * the brand and the brand sells it to a customer. Consolidation already
     * handles that properly, including the profit still sitting in stock the
     * brand has not sold, which no amount of filtering accounts by name can
     * work out. Reimplementing it here badly would give a second answer to a
     * question that already has one.
     */
    period ? groupProfitAndLoss(period.id) : null,

    db.alert.count({ where: { status: { not: "RESOLVED" } } }),

    // A style being sold with no costing behind it: no transfer price, so no
    // honest margin on anything it sells.
    db.style.count({ where: { isActive: true, costSnapshots: { none: {} } } }),

    db.inventoryLot.count({
      where: { remainingQty: { gt: 0 }, receivedDate: { lt: ninetyDaysAgo } },
    }),

    // Over the threshold and not yet signed off. There is no status for it:
    // approval is recorded by a timestamp, so its absence is the queue.
    db.expense.count({ where: { approvedAt: null, rejectedAt: null } }),

    db.expense.count({
      where: { status: { in: ["UNPAID", "PARTIALLY_PAID"] }, dueDate: { lt: new Date() } },
    }),

    // Fell due and still short. What is owed is never stored — it is the
    // order less what has been paid against it — so this asks in SQL rather
    // than trusting a field that could drift.
    db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM (
        SELECT o."id"
        FROM "sales_orders" o
        LEFT JOIN "sales_payments" p ON p."salesOrderId" = o."id"
        WHERE o."dueDate" < NOW() AND o."status" <> 'CANCELLED'
        GROUP BY o."id", o."netAmount", o."shippingAmount"
        HAVING (o."netAmount" + o."shippingAmount") - COALESCE(SUM(p."amount"), 0) > 0.005
      ) late
    `,
  ]);

  const at = (code: string) => bal.get(code) ?? dec(0);

  const cash = at("1110").plus(at("1115")).plus(at("1120"));
  const receivable = at("1210");
  // A liability's normal balance is a credit, which reads negative here.
  const payable = at("2110").negated();
  const stock = at("1310").plus(at("1320")).plus(at("1330")).plus(at("1340"));

  return {
    period: period ? { id: period.id, year: period.year, month: period.month } : null,
    cash,
    receivable,
    payable,
    stock,
    /** What was sold to people outside the business. */
    revenue: trading ? dec(trading.groupExternalRevenue) : dec(0),
    expenses: trading ? dec(trading.groupOperatingExpenses) : dec(0),
    profit: trading ? dec(trading.groupProfit) : dec(0),
    profitMarginPct: trading
      ? safeDiv(dec(trading.groupProfit), dec(trading.groupExternalRevenue))
      : null,
    /**
     * Margin the factory has earned on paper and the group has not, because
     * the garments are still on the brand's shelf. Real money, not yet made.
     */
    unrealisedInStock: trading ? dec(trading.closingUnrealised) : dec(0),

    /** Things that want somebody's attention rather than their curiosity. */
    openAlerts,
    unpricedStyles,
    staleStock,
    openApprovals,
    lateInvoices,
    overdueCustomers: Number(overdueRows[0]?.n ?? 0),
  };
}
