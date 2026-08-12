import "server-only";
import { db } from "./db";
import { dec, safeDiv, type Decimal } from "./money";

/**
 * Financial statements read from the posted ledger.
 *
 * Every figure here is a sum of journal lines, so a statement can always be
 * opened up to the entries behind it. Nothing is stored or cached — a report
 * that can drift from the ledger is worse than no report.
 */

export type StatementLine = {
  accountCode: string;
  accountEn: string;
  accountAr: string;
  /// Carried through so reports classify by account *type*, never by parsing
  /// the account number — the numbering is a display convention and must stay
  /// changeable without touching any calculation.
  accountType: string;
  reportingCategory: string | null;
  amount: string;
  entryCount: number;
};

/**
 * Account balances for one entity and period, in natural reading direction:
 * revenue positive when earned, expenses positive when incurred.
 */
async function balancesByAccount(
  entityId: string,
  fiscalPeriodId: string | null,
  types: string[],
): Promise<StatementLine[]> {
  const rows = await db.$queryRaw<
    {
      code: string; nameEn: string; nameAr: string;
      reportingCategory: string | null; type: string;
      balance: string; entryCount: bigint;
    }[]
  >`
    SELECT a."code", a."nameEn", a."nameAr", a."reportingCategory", a."type"::text AS type,
           COALESCE(SUM(l."debit") - SUM(l."credit"), 0)::text AS balance,
           COUNT(*) AS "entryCount"
    FROM "journal_lines" l
    JOIN "journal_entries" e ON e."id" = l."journalEntryId"
    JOIN "accounts" a ON a."id" = l."accountId"
    WHERE e."status" = 'POSTED'
      AND l."entityId" = ${entityId}
      AND a."type"::text = ANY(${types}::text[])
      AND (${fiscalPeriodId}::text IS NULL OR e."fiscalPeriodId" = ${fiscalPeriodId})
    GROUP BY a."code", a."nameEn", a."nameAr", a."reportingCategory", a."type"
    HAVING COALESCE(SUM(l."debit") - SUM(l."credit"), 0) <> 0
    ORDER BY a."code"
  `;

  return rows.map((r) => ({
    accountCode: r.code,
    accountEn: r.nameEn,
    accountAr: r.nameAr,
    accountType: r.type,
    reportingCategory: r.reportingCategory,
    // Revenue and income accounts carry credit balances; flipped so a
    // statement reads the way an accountant expects.
    amount:
      r.type === "REVENUE" || r.type === "OTHER_INCOME"
        ? dec(r.balance).negated().toString()
        : dec(r.balance).toString(),
    entryCount: Number(r.entryCount),
  }));
}

const total = (lines: StatementLine[]): Decimal =>
  lines.reduce((s, l) => s.plus(dec(l.amount)), dec(0));

export async function entityProfitAndLoss(
  entityId: string,
  fiscalPeriodId: string | null = null,
) {
  const [revenue, cogs, expenses, other] = await Promise.all([
    balancesByAccount(entityId, fiscalPeriodId, ["REVENUE"]),
    balancesByAccount(entityId, fiscalPeriodId, ["COGS"]),
    balancesByAccount(entityId, fiscalPeriodId, ["EXPENSE"]),
    balancesByAccount(entityId, fiscalPeriodId, ["OTHER_INCOME", "OTHER_EXPENSE"]),
  ]);

  const revenueTotal = total(revenue);
  const cogsTotal = total(cogs);
  const grossProfit = revenueTotal.minus(cogsTotal);
  const expensesTotal = total(expenses);
  const operatingProfit = grossProfit.minus(expensesTotal);

  const otherIncome = total(other.filter((l) => l.accountType === "OTHER_INCOME"));
  const otherExpense = total(other.filter((l) => l.accountType === "OTHER_EXPENSE"));

  const netProfit = operatingProfit.plus(otherIncome).minus(otherExpense);

  return {
    revenue, cogs, expenses, other,
    revenueTotal, cogsTotal, grossProfit,
    expensesTotal, operatingProfit,
    otherIncome, otherExpense, netProfit,
    grossMarginPct: safeDiv(grossProfit, revenueTotal),
    netMarginPct: safeDiv(netProfit, revenueTotal),
  };
}

/**
 * Trial balance: every account with a posted balance, for one entity or all.
 *
 * Total debits must equal total credits. If they ever do not, the database
 * triggers have been bypassed and nothing downstream can be trusted.
 */
export async function trialBalance(
  entityId: string | null = null,
  fiscalPeriodId: string | null = null,
) {
  const rows = await db.$queryRaw<
    { code: string; nameEn: string; nameAr: string; type: string; debit: string; credit: string }[]
  >`
    SELECT a."code", a."nameEn", a."nameAr", a."type"::text AS type,
           COALESCE(SUM(l."debit"), 0)::text AS debit,
           COALESCE(SUM(l."credit"), 0)::text AS credit
    FROM "journal_lines" l
    JOIN "journal_entries" e ON e."id" = l."journalEntryId"
    JOIN "accounts" a ON a."id" = l."accountId"
    WHERE e."status" = 'POSTED'
      AND (${entityId}::text IS NULL OR l."entityId" = ${entityId})
      AND (${fiscalPeriodId}::text IS NULL OR e."fiscalPeriodId" = ${fiscalPeriodId})
    GROUP BY a."code", a."nameEn", a."nameAr", a."type"
    ORDER BY a."code"
  `;

  const totalDebit = rows.reduce((s, r) => s.plus(dec(r.debit)), dec(0));
  const totalCredit = rows.reduce((s, r) => s.plus(dec(r.credit)), dec(0));

  return {
    rows,
    totalDebit,
    totalCredit,
    balanced: totalDebit.equals(totalCredit),
  };
}

/**
 * Payables aged by due date, not by when the cost was incurred.
 *
 * A cost incurred in January and due in April is not overdue in February.
 */
export async function apAging(entityId: string | null = null, asOf: Date = new Date()) {
  const expenses = await db.expense.findMany({
    where: {
      status: { in: ["UNPAID", "PARTIALLY_PAID"] },
      ...(entityId ? { entityId } : {}),
    },
    include: { supplier: true, entity: true, costCategory: true },
    orderBy: { dueDate: "asc" },
  });

  const buckets = {
    current: dec(0), d1_30: dec(0), d31_60: dec(0), d61_90: dec(0), d90plus: dec(0),
  };

  const rows = expenses.map((e) => {
    const outstanding = dec(e.amount).minus(dec(e.paidAmount));
    const daysOverdue = Math.floor(
      (asOf.getTime() - e.dueDate.getTime()) / 86_400_000,
    );

    const bucket =
      daysOverdue <= 0 ? "current"
      : daysOverdue <= 30 ? "d1_30"
      : daysOverdue <= 60 ? "d31_60"
      : daysOverdue <= 90 ? "d61_90"
      : "d90plus";

    buckets[bucket] = buckets[bucket].plus(outstanding);

    return {
      id: e.id,
      description: e.description,
      supplierEn: e.supplier?.nameEn ?? null,
      supplierAr: e.supplier?.nameAr ?? null,
      entityEn: e.entity.nameEn,
      entityAr: e.entity.nameAr,
      dueDate: e.dueDate,
      outstanding: outstanding.toString(),
      daysOverdue,
      bucket,
    };
  });

  return {
    rows,
    buckets,
    total: Object.values(buckets).reduce((s, v) => s.plus(v), dec(0)),
  };
}

/**
 * What each supplier is owed, and how late it is.
 *
 * The aging report answers "how much is overdue" across the business. It does
 * not answer the question somebody actually asks on the phone — "what do I owe
 * you" — and building that answer by eye from a list of invoices is how a
 * supplier ends up being told a number that is wrong in their favour.
 *
 * Aged against each expense's own due date, so a supplier on thirty-day terms
 * is not chased on day two.
 */
export async function supplierStatements(
  entityId: string | null = null,
  asOf: Date = new Date(),
) {
  const expenses = await db.expense.findMany({
    where: {
      status: { not: "PAID" },
      supplierId: { not: null },
      ...(entityId ? { entityId } : {}),
    },
    include: { supplier: true, entity: true, costCategory: true },
    orderBy: { dueDate: "asc" },
  });

  type Row = {
    supplierId: string;
    code: string;
    nameAr: string;
    nameEn: string;
    phone: string | null;
    creditDays: number;
    outstanding: Decimal;
    overdue: Decimal;
    notYetDue: Decimal;
    oldestDue: Date | null;
    invoices: {
      id: string;
      description: string;
      entity: string;
      category: string;
      amount: string;
      paid: string;
      outstanding: string;
      dueDate: Date;
      daysLate: number;
    }[];
  };

  const rows = new Map<string, Row>();

  for (const e of expenses) {
    if (!e.supplier) continue;

    const owed = dec(e.amount).minus(dec(e.paidAmount));
    if (owed.lessThanOrEqualTo(0)) continue;

    const row =
      rows.get(e.supplier.id) ?? {
        supplierId: e.supplier.id,
        code: e.supplier.code,
        nameAr: e.supplier.nameAr,
        nameEn: e.supplier.nameEn,
        phone: e.supplier.phone,
        creditDays: e.supplier.creditDays,
        outstanding: dec(0),
        overdue: dec(0),
        notYetDue: dec(0),
        oldestDue: null,
        invoices: [],
      };

    const late = e.dueDate < asOf;
    const daysLate = late
      ? Math.floor((asOf.getTime() - e.dueDate.getTime()) / 86_400_000)
      : 0;

    row.outstanding = row.outstanding.plus(owed);
    if (late) row.overdue = row.overdue.plus(owed);
    else row.notYetDue = row.notYetDue.plus(owed);
    if (!row.oldestDue || e.dueDate < row.oldestDue) row.oldestDue = e.dueDate;

    row.invoices.push({
      id: e.id,
      description: e.description,
      entity: e.entity.nameAr || e.entity.nameEn,
      category: e.costCategory.nameAr || e.costCategory.nameEn,
      amount: dec(e.amount).toString(),
      paid: dec(e.paidAmount).toString(),
      outstanding: owed.toString(),
      dueDate: e.dueDate,
      daysLate,
    });

    rows.set(e.supplier.id, row);
  }

  return [...rows.values()]
    .sort((a, b) => {
      // Whoever is owed money late comes first, and among them the longest
      // wait — that is the order somebody works down the list in.
      if (a.overdue.greaterThan(0) !== b.overdue.greaterThan(0)) {
        return a.overdue.greaterThan(0) ? -1 : 1;
      }
      return (a.oldestDue?.getTime() ?? 0) - (b.oldestDue?.getTime() ?? 0);
    })
    .map((r) => ({
      ...r,
      outstanding: r.outstanding.toString(),
      overdue: r.overdue.toString(),
      notYetDue: r.notYetDue.toString(),
    }));
}

/**
 * What has been ordered from a supplier and not yet delivered.
 *
 * Not a debt — a supplier is owed when their goods arrive — but it is the
 * other half of the answer to "what is between us", and leaving it out makes
 * a statement look smaller than the relationship actually is.
 */
export async function supplierCommitments(supplierId?: string | null) {
  const orders = await db.purchaseOrder.findMany({
    where: {
      status: { in: ["CONFIRMED", "PARTIALLY_RECEIVED", "DRAFT"] },
      ...(supplierId ? { supplierId } : {}),
    },
    include: { supplier: true, lines: true },
    orderBy: { orderDate: "asc" },
  });

  return orders
    .map((o) => {
      const outstanding = o.lines.reduce(
        (s, l) =>
          s.plus(dec(l.effectiveCost).times(dec(l.quantity).minus(dec(l.receivedQty)))),
        dec(0),
      );
      return {
        id: o.id,
        poNumber: o.poNumber,
        supplierId: o.supplierId,
        supplierName: o.supplier.nameAr || o.supplier.nameEn,
        status: o.status,
        awaitingApproval: o.status === "DRAFT" && !o.approvedAt,
        orderDate: o.orderDate,
        expectedDate: o.expectedDate,
        outstanding: outstanding.toString(),
      };
    })
    .filter((o) => dec(o.outstanding).greaterThan(0));
}
