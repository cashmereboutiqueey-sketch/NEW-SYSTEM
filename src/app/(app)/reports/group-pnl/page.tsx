import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber } from "@/lib/money";
import { groupProfitAndLoss } from "@/lib/consolidation";
import { dec } from "@/lib/money";

/**
 * المجموعة — consolidated profit and loss.
 *
 * The workings are shown, not just the answer: each entity's own result, the
 * naive sum, then the eliminations that turn it into what the group actually
 * earned from customers outside itself.
 */
export default async function GroupPnlPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  await requirePermission("report:group");
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const params = await searchParams;

  const periods = await db.fiscalPeriod.findMany({
    orderBy: [{ year: "desc" }, { month: "desc" }],
  });
  const selectedPeriodId = params.period ?? null;
  const g = await groupProfitAndLoss(selectedPeriodId);

  const label = (p: { year: number; month: number }) =>
    `${p.year}-${String(p.month).padStart(2, "0")}`;

  const row = (
    k: string,
    v: React.ReactNode,
    opts: { strong?: boolean; indent?: boolean; tone?: string } = {},
  ) => (
    <div
      key={k}
      className={
        "flex items-baseline justify-between gap-4 py-1.5 " +
        (opts.strong ? "border-t border-ink-300 font-semibold" : "border-b border-ink-100")
      }
    >
      <dt className={opts.indent ? "ps-4 text-ink-500" : "text-ink-600"}>{k}</dt>
      <dd className={`num ${opts.tone ?? "text-ink-900"}`}>{v}</dd>
    </div>
  );

  return (
    <>
      <PageHeader
        title={t("groupPnl", locale)}
        subtitle={
          ar
            ? "ما كسبته المجموعة فعلًا من خارجها — بعد حذف البيع الداخلي والربح غير المحقق"
            : "What the group actually earned from outside itself, after removing the internal sale and unrealised profit"
        }
        actions={
          <form className="flex gap-2">
            <select
              name="period"
              defaultValue={selectedPeriodId ?? ""}
              className="rounded-lg border border-ink-200 px-2 py-1 text-sm"
            >
              <option value="">{ar ? "كل الفترات" : "All periods"}</option>
              {periods.map((p) => (
                <option key={p.id} value={p.id}>{label(p)}</option>
              ))}
            </select>
            <button
              type="submit"
              className="rounded-lg border border-ink-300 px-3 py-1 text-sm text-ink-700"
            >
              {ar ? "عرض" : "View"}
            </button>
          </form>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={ar ? "ربح المصنع" : "Factory profit"}
          value={formatMoney(g.factoryProfit, locale)}
          tone={dec(g.factoryProfit).greaterThan(0) ? "good" : "bad"}
        />
        <StatTile
          label={ar ? "ربح البراند" : "Brand profit"}
          value={formatMoney(g.brandProfit, locale)}
          tone={dec(g.brandProfit).greaterThan(0) ? "good" : "bad"}
        />
        <StatTile
          label={ar ? "ربح غير محقق" : "Unrealised profit"}
          value={formatMoney(g.closingUnrealised, locale)}
          tone={dec(g.closingUnrealised).greaterThan(0) ? "warn" : "neutral"}
          hint={ar ? "مدفون في بضاعة لم تُبع" : "Buried in unsold stock"}
        />
        <StatTile
          label={ar ? "ربح المجموعة" : "Group profit"}
          value={formatMoney(g.groupProfit, locale)}
          tone={dec(g.groupProfit).greaterThan(0) ? "good" : "bad"}
        />
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card
          title={ar ? "من الجمع البسيط إلى ربح المجموعة" : "From the naive sum to group profit"}
          description={
            ar
              ? "جمع الكيانين ببساطة يحسب البيع الداخلي مرتين"
              : "Simply adding the two entities counts the internal sale twice"
          }
        >
          <dl className="text-sm">
            {row(ar ? "ربح المصنع" : "Factory profit", formatMoney(g.factoryProfit, locale))}
            {row(ar ? "ربح البراند" : "Brand profit", formatMoney(g.brandProfit, locale))}
            {row(ar ? "المجموع البسيط" : "Combined", formatMoney(g.combinedProfit, locale), {
              strong: true,
            })}
            {row(
              ar ? "حذف: ربح غير محقق في المخزون" : "Less: unrealised profit in stock",
              formatMoney(dec(g.unrealisedProfitMovement).negated(), locale),
              { indent: true, tone: "text-bad" },
            )}
            {row(ar ? "ربح المجموعة" : "Group profit", formatMoney(g.groupProfit, locale), {
              strong: true,
            })}
          </dl>
          <p className="mt-3 text-xs text-ink-500">
            {ar
              ? "الهامش اللي المجموعة حمّلته على نفسها مش ربح لحد ما البضاعة تخرج برّه المجموعة."
              : "Margin the group charged itself is not profit until the goods leave the group."}
          </p>
        </Card>

        <Card title={ar ? "قائمة دخل المجموعة" : "Group profit and loss"}>
          <dl className="text-sm">
            {row(
              ar ? "إيراد خارجي" : "External revenue",
              formatMoney(g.groupExternalRevenue, locale),
            )}
            {row(
              ar ? "تكلفة المبيعات" : "Cost of goods sold",
              formatMoney(dec(g.groupCogs).negated(), locale),
              { tone: "text-bad" },
            )}
            {row(
              ar ? "مصروفات تشغيلية" : "Operating expenses",
              formatMoney(dec(g.groupOperatingExpenses).negated(), locale),
              { tone: "text-bad" },
            )}
            {row(ar ? "ربح المجموعة" : "Group profit", formatMoney(g.groupProfit, locale), {
              strong: true,
            })}
          </dl>
          <div className="mt-4 space-y-1 border-t border-ink-100 pt-3 text-xs text-ink-500">
            <p>
              {ar ? "محذوف — إيراد داخلي: " : "Eliminated — internal revenue: "}
              <span className="num">{formatMoney(g.intercompanyRevenueEliminated, locale)}</span>
            </p>
            <p>
              {ar ? "محذوف — تكلفة داخلية: " : "Eliminated — internal cost: "}
              <span className="num">{formatMoney(g.intercompanyCogsEliminated, locale)}</span>
            </p>
          </div>
        </Card>
      </div>

      <Card
        className="mb-4"
        title={ar ? "مطابقة الحساب الجاري بين الكيانين" : "Intercompany reconciliation"}
        description={
          ar
            ? "الفرق يظهر كاستثناء ولا يُجبَر على الصفر"
            : "A difference surfaces as an exception rather than being forced to zero"
        }
      >
        <div className="flex flex-wrap items-center gap-6 text-sm">
          <div>
            <span className="text-ink-500">{ar ? "مدين لدى المصنع" : "Factory receivable"}</span>
            <span className="num ms-2 font-medium">
              {formatMoney(g.intercompany.receivable, locale)}
            </span>
          </div>
          <div>
            <span className="text-ink-500">{ar ? "دائن لدى البراند" : "Brand payable"}</span>
            <span className="num ms-2 font-medium">
              {formatMoney(g.intercompany.payable, locale)}
            </span>
          </div>
          <Badge tone={g.intercompany.matched ? "good" : "bad"}>
            {g.intercompany.matched
              ? ar ? "مطابق" : "Matched"
              : `${ar ? "فرق" : "Difference"} ${formatMoney(g.intercompany.difference, locale)}`}
          </Badge>
        </div>
      </Card>

      <Card
        title={ar ? "الربح غير المحقق حسب الدفعة" : "Unrealised profit by lot"}
        description={
          ar
            ? "هامش المصنع المدفون في كل دفعة لم تُبع بعد"
            : "Factory margin embedded in each lot the Brand has not yet sold"
        }
      >
        {g.unrealisedByLot.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-400">
            {ar
              ? "لا يوجد ربح غير محقق — كل البضاعة المحوّلة اتباعت."
              : "No unrealised profit — everything transferred has been sold."}
          </p>
        ) : (
          <DataTable
            headers={[
              ar ? "الدفعة" : "Lot",
              ar ? "الموديل" : "Style",
              "SKU",
              ar ? "المتبقي" : "Remaining",
              ar ? "هامش الوحدة" : "Margin per unit",
              ar ? "المؤجل" : "Deferred",
            ]}
            rows={g.unrealisedByLot.map((l) => [
              <code key={`${l.lotNumber}-n`} dir="ltr" className="text-xs text-ink-500">
                {l.lotNumber}
              </code>,
              <code key={`${l.lotNumber}-s`} dir="ltr" className="text-xs">{l.styleCode}</code>,
              <code key={`${l.lotNumber}-k`} dir="ltr" className="text-xs text-ink-500">
                {l.sku}
              </code>,
              <span key={`${l.lotNumber}-q`} className="num">
                {formatNumber(l.remainingQty, locale)}
              </span>,
              <span key={`${l.lotNumber}-m`} className="num">
                {formatMoney(l.marginPerUnit, locale)}
              </span>,
              <span key={`${l.lotNumber}-d`} className="num font-medium text-warn">
                {formatMoney(l.deferred, locale)}
              </span>,
            ])}
          />
        )}
      </Card>
    </>
  );
}
