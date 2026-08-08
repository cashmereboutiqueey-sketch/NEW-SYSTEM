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
