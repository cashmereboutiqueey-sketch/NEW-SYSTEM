import Link from "next/link";
import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requireUser } from "@/lib/auth";
import { can } from "@/core/permissions";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatPercent } from "@/lib/money";
import { entityProfitAndLoss, trialBalance } from "@/lib/reports";
import { dec } from "@/lib/money";

/**
 * Factory or Brand profit and loss, plus the trial balance behind it.
 *
 * Every line names the account it came from and how many postings it
 * represents, so a figure can always be traced back to the entries that made
 * it. The trial balance is shown alongside because a statement is only worth
 * reading if the books balance.
 */
export default async function EntityPnlPage({
  searchParams,
}: {
  searchParams: Promise<{ entity?: string; period?: string }>;
}) {
  const session = await requireUser();
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const params = await searchParams;

  const entities = await db.entity.findMany({ orderBy: { kind: "asc" } });
  const requested = entities.find((e) => e.kind === params.entity);
  const entity = requested ?? entities[0];

  // A brand manager has no business reading the factory's books.
  const allowed =
    entity.kind === "FACTORY" ? can(session.role, "report:factory") : can(session.role, "report:brand");

  const periods = await db.fiscalPeriod.findMany({
    orderBy: [{ year: "desc" }, { month: "desc" }],
  });
  const periodId = params.period ?? null;

  const [pnl, tb] = allowed
    ? await Promise.all([
        entityProfitAndLoss(entity.id, periodId),
        trialBalance(entity.id, periodId),
      ])
    : [null, null];

  const name = (e: { nameAr: string; nameEn: string }) => (ar ? e.nameAr : e.nameEn);
  const label = (p: { year: number; month: number }) =>
    `${p.year}-${String(p.month).padStart(2, "0")}`;

  const section = (title: string, lines: NonNullable<typeof pnl>["revenue"], totalValue: unknown) => (
    <>
      <tr className="border-t border-ink-200">
        <td colSpan={3} className="pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
          {title}
        </td>
      </tr>
      {lines.length === 0 ? (
        <tr>
          <td colSpan={3} className="py-1.5 ps-4 text-sm text-ink-400">
            {ar ? "لا شيء" : "Nothing posted"}
          </td>
        </tr>
      ) : (
        lines.map((l) => (
          <tr key={l.accountCode} className="border-b border-ink-100">
            <td className="py-1.5 ps-4 text-sm">
              <code dir="ltr" className="text-xs text-ink-400">{l.accountCode}</code>
              <span className="ms-2">{ar ? l.accountAr : l.accountEn}</span>
            </td>
            <td className="num py-1.5 text-end text-xs text-ink-400">{l.entryCount}</td>
            <td className="num py-1.5 text-end text-sm">{formatMoney(l.amount, locale)}</td>
          </tr>
        ))
      )}
      <tr>
        <td className="py-1.5 text-sm font-medium">{ar ? "الإجمالي" : "Total"}</td>
        <td />
        <td className="num py-1.5 text-end text-sm font-semibold">
          {formatMoney(totalValue as string, locale)}
        </td>
      </tr>
    </>
  );

  return (
    <>
      <PageHeader
        title={`${ar ? "قائمة الدخل" : "Profit and loss"} — ${name(entity)}`}
        subtitle={
          ar
            ? "كل سطر مربوط بحسابه وعدد قيوده"
            : "Every line names its account and how many postings it represents"
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {entities.map((e) => (
              <Link
                key={e.id}
                href={`/reports/entity-pnl?entity=${e.kind}${periodId ? `&period=${periodId}` : ""}`}
                className={
                  "rounded-lg border px-3 py-1 text-sm " +
                  (entity.id === e.id
                    ? "border-ink-900 bg-ink-900 text-white"
                    : "border-ink-200 text-ink-700")
                }
              >
                {name(e)}
              </Link>
            ))}
            <form className="flex gap-2">
              <input type="hidden" name="entity" value={entity.kind} />
              <select
                name="period"
                defaultValue={periodId ?? ""}
                className="rounded-lg border border-ink-200 px-2 py-1 text-sm"
              >
                <option value="">{ar ? "كل الفترات" : "All periods"}</option>
                {periods.map((p) => (
                  <option key={p.id} value={p.id}>{label(p)}</option>
                ))}
              </select>
              <button type="submit" className="rounded-lg border border-ink-300 px-3 py-1 text-sm">
                {ar ? "عرض" : "View"}
              </button>
            </form>
          </div>
        }
      />

      {!allowed || !pnl || !tb ? (
        <Card>
          <p className="py-8 text-center text-sm text-ink-500">
            {ar
              ? "ليس لديك صلاحية لعرض دفاتر هذا الكيان."
              : "You do not have permission to view this entity's books."}
          </p>
        </Card>
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label={ar ? "الإيرادات" : "Revenue"}
              value={formatMoney(pnl.revenueTotal, locale)}
            />
            <StatTile
              label={ar ? "مجمل الربح" : "Gross profit"}
              value={formatMoney(pnl.grossProfit, locale)}
              tone={pnl.grossProfit.greaterThan(0) ? "good" : "bad"}
              hint={pnl.grossMarginPct ? formatPercent(pnl.grossMarginPct, locale) : undefined}
            />
            <StatTile
              label={ar ? "المصروفات التشغيلية" : "Operating expenses"}
              value={formatMoney(pnl.expensesTotal, locale)}
            />
            <StatTile
              label={ar ? "صافي الربح" : "Net profit"}
              value={formatMoney(pnl.netProfit, locale)}
              tone={pnl.netProfit.greaterThan(0) ? "good" : "bad"}
              hint={pnl.netMarginPct ? formatPercent(pnl.netMarginPct, locale) : undefined}
            />
          </div>

          <Card className="mb-4" title={ar ? "قائمة الدخل" : "Profit and loss"}>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-ink-400">
                    <th className="pb-2 text-start font-medium">{ar ? "الحساب" : "Account"}</th>
                    <th className="pb-2 text-end font-medium">{ar ? "قيود" : "Entries"}</th>
                    <th className="pb-2 text-end font-medium">{ar ? "المبلغ" : "Amount"}</th>
                  </tr>
                </thead>
                <tbody>
                  {section(ar ? "الإيرادات" : "Revenue", pnl.revenue, pnl.revenueTotal)}
                  {section(ar ? "تكلفة المبيعات" : "Cost of goods sold", pnl.cogs, pnl.cogsTotal)}
                  <tr className="border-t-2 border-ink-300">
                    <td className="py-2 text-sm font-semibold">
                      {ar ? "مجمل الربح" : "Gross profit"}
                    </td>
                    <td />
                    <td className="num py-2 text-end text-sm font-semibold">
                      {formatMoney(pnl.grossProfit, locale)}
                    </td>
                  </tr>
                  {section(
                    ar ? "المصروفات التشغيلية" : "Operating expenses",
                    pnl.expenses,
                    pnl.expensesTotal,
                  )}
                  <tr className="border-t-2 border-ink-300">
                    <td className="py-2 text-sm font-semibold">
                      {ar ? "صافي الربح" : "Net profit"}
                    </td>
                    <td />
                    <td
                      className={
                        "num py-2 text-end text-sm font-semibold " +
                        (pnl.netProfit.greaterThan(0) ? "text-good" : "text-bad")
                      }
                    >
                      {formatMoney(pnl.netProfit, locale)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-ink-500">
              {ar
                ? "«تكلفة التشغيل المحمّلة» تظهر بالسالب داخل المصروفات: هي الجزء اللي دخل المخزون، والباقي هو تكلفة الطاقة العاطلة."
                : "Conversion absorbed appears negative within expenses: it is the part that entered inventory, and what remains is the cost of idle capacity."}
            </p>
          </Card>

          <Card
            title={ar ? "ميزان المراجعة" : "Trial balance"}
            description={
              ar
                ? "لو المدين لا يساوي الدائن، فالدفاتر لا يُعتمد عليها"
                : "If debits do not equal credits, nothing downstream can be trusted"
            }
          >
            <div className="mb-3">
              <Badge tone={tb.balanced ? "good" : "bad"}>
                {tb.balanced
                  ? ar ? "متزن" : "Balanced"
                  : ar ? "غير متزن" : "Out of balance"}
              </Badge>
              <span className="num ms-3 text-sm text-ink-600">
                {formatMoney(tb.totalDebit, locale)} / {formatMoney(tb.totalCredit, locale)}
              </span>
            </div>
            {tb.rows.length === 0 ? (
              <p className="py-4 text-center text-sm text-ink-400">
                {ar ? "لا توجد قيود مرحّلة." : "Nothing posted yet."}
              </p>
            ) : (
              <DataTable
                headers={[
                  ar ? "الحساب" : "Account",
                  ar ? "مدين" : "Debit",
                  ar ? "دائن" : "Credit",
                ]}
                rows={tb.rows.map((r) => [
                  <span key={`${r.code}-n`}>
                    <code dir="ltr" className="text-xs text-ink-400">{r.code}</code>
                    <span className="ms-2">{ar ? r.nameAr : r.nameEn}</span>
                  </span>,
                  <span key={`${r.code}-d`} className="num">
                    {dec(r.debit).isZero() ? "—" : formatMoney(r.debit, locale)}
                  </span>,
                  <span key={`${r.code}-c`} className="num">
                    {dec(r.credit).isZero() ? "—" : formatMoney(r.credit, locale)}
                  </span>,
                ])}
              />
            )}
          </Card>
        </>
      )}
    </>
  );
}
