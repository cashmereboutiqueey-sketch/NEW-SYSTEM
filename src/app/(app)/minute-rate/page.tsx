import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requireUser } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { can } from "@/core/permissions";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatRate, formatNumber, formatPercent } from "@/lib/money";
import { CalculateForm, LockForm } from "./minute-rate-form";

/**
 * تكلفة الدقيقة — the minute rate.
 *
 * Every number on this page opens up: the rate comes from the pool, the pool
 * comes from named ledger accounts, and each account states how many postings
 * it represents. Nothing here is asserted without its inputs beside it.
 */
export default async function MinuteRatePage() {
  const session = await requireUser();
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });

  const [periods, rates] = await Promise.all([
    db.fiscalPeriod.findMany({ orderBy: [{ year: "desc" }, { month: "desc" }] }),
    db.minuteRatePeriod.findMany({
      where: { entityId: factory.id },
      include: { fiscalPeriod: true, components: { orderBy: { costCategoryCode: "asc" } } },
      orderBy: [{ fiscalPeriod: { year: "desc" } }, { fiscalPeriod: { month: "desc" } }],
    }),
  ]);

  const latest = rates[0];
  const periodLabel = (p: { year: number; month: number }) =>
    `${p.year}-${String(p.month).padStart(2, "0")}`;

  return (
    <>
      <PageHeader
        title={t("minuteRate", locale)}
        subtitle={
          ar
            ? "الطاقة العاطلة تظهر كرقم صريح، لا كضريبة صامتة على كل قطعة"
            : "Idle capacity shown as an explicit number, not a silent tax on every garment"
        }
      />

      {latest ? (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label={ar ? "تكلفة الدقيقة الفعلية" : "Actual minute rate"}
              value={formatRate(latest.actualMinuteRate, locale)}
              hint={ar ? "ما يدفعه البراند اليوم" : "What the brand pays today"}
            />
            <StatTile
              label={ar ? "تكلفة الدقيقة بكامل الطاقة" : "Full-capacity rate"}
              value={formatRate(latest.fullCapacityMinuteRate, locale)}
              tone="info"
              hint={ar ? "الحد الأدنى لتسعير التصنيع للغير" : "Floor for external CMT quotes"}
            />
            <StatTile
              label={ar ? "عبء الطاقة العاطلة" : "Idle penalty"}
              value={formatRate(latest.idlePenaltyPerMinute, locale)}
              tone={Number(latest.idlePenaltyPerMinute) > 0 ? "bad" : "good"}
              hint={ar ? "للدقيقة الواحدة" : "Per minute"}
            />
            <StatTile
              label={ar ? "الدقائق العاطلة" : "Idle minutes"}
              value={formatNumber(latest.idleMinutes, locale)}
              tone="warn"
              hint={`${formatNumber(latest.grossAvailableMinutes, locale)} ${ar ? "متاحة" : "available"}`}
            />
          </div>

          <div className="mb-4 grid gap-4 lg:grid-cols-2">
            <Card
              title={ar ? "كيف وصلنا للرقم" : "How the rate was derived"}
              description={periodLabel(latest.fiscalPeriod)}
            >
              <dl className="space-y-2 text-sm">
                {[
                  [ar ? "عدد العمال" : "Operators", formatNumber(latest.operators, locale)],
                  [ar ? "أيام العمل" : "Working days", formatNumber(latest.workingDays, locale)],
                  [ar ? "ساعات اليوم" : "Hours per day", formatNumber(latest.hoursPerDay, locale)],
                  [ar ? "إجمالي الدقائق المتاحة" : "Gross available minutes", formatNumber(latest.grossAvailableMinutes, locale)],
                  [ar ? "نسبة التشغيل (مشكلة مبيعات)" : "Utilisation (a sales problem)", formatPercent(latest.utilisationRate, locale)],
                  [ar ? "الكفاءة (مشكلة إنتاج)" : "Efficiency (a shop-floor problem)", formatPercent(latest.efficiencyRate, locale)],
                  [ar ? "الدقائق المنتجة" : "Productive minutes", formatNumber(latest.productiveMinutes, locale)],
                  [ar ? "مجمع التكلفة" : "Gross cost pool", formatMoney(latest.totalConversionCost, locale)],
                  [ar ? "خصم إيراد التصنيع للغير" : "Less CMT revenue credit", formatMoney(latest.cmtRevenueCredit, locale)],
                  [ar ? "صافي المجمع" : "Net cost pool", formatMoney(latest.netCostPool, locale)],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-baseline justify-between gap-4 border-b border-ink-100 pb-1.5">
                    <dt className="text-ink-600">{k}</dt>
                    <dd className="num font-medium text-ink-900">{v}</dd>
                  </div>
                ))}
              </dl>
            </Card>

            <Card
              title={ar ? "مكونات المجمع" : "What is in the pool"}
              description={
                ar
                  ? "حسابات تكلفة التشغيل فقط — الخامات والفوائد مستبعدة عمدًا"
                  : "Conversion accounts only — materials and finance costs are deliberately excluded"
              }
            >
              {latest.components.length === 0 ? (
                <p className="py-4 text-center text-sm text-ink-400">
                  {ar
                    ? "لا توجد مصروفات مرحّلة في هذا الشهر بعد."
                    : "No conversion costs posted in this period yet."}
                </p>
              ) : (
                <DataTable
                  headers={[
                    ar ? "الحساب" : "Account",
                    ar ? "المبلغ" : "Amount",
                    ar ? "عدد القيود" : "Postings",
                  ]}
                  rows={latest.components.map((c) => [
                    <span key={`${c.id}-n`}>
                      <code dir="ltr" className="text-xs text-ink-500">{c.costCategoryCode}</code>
                      <span className="ms-2">{c.costCategoryName}</span>
                    </span>,
                    <span key={`${c.id}-a`} className="num">{formatMoney(c.amount, locale)}</span>,
                    <span key={`${c.id}-c`} className="num text-ink-500">{c.expenseCount}</span>,
                  ])}
                />
              )}
            </Card>
          </div>
        </>
      ) : (
        <Card className="mb-4">
          <p className="py-6 text-center text-sm text-ink-400">
            {ar
              ? "لم تُحسب تكلفة الدقيقة بعد. سجّل مصروفات التشغيل أولًا ثم احسب الشهر."
              : "No minute rate calculated yet. Post conversion costs first, then calculate the period."}
          </p>
        </Card>
      )}

      {can(session.role, "minute_rate:calculate") && (
        <Card
          className="mb-4"
          title={ar ? "حساب تكلفة الدقيقة" : "Calculate the minute rate"}
          description={
            ar
              ? "الشهر المقفول لا يُعاد حسابه — أوامر الإنتاج المسعّرة عليه تحتفظ بسعره للأبد"
              : "A locked period is never recalculated — production orders costed against it keep its rate permanently"
          }
        >
          <CalculateForm
            locale={locale}
            entityId={factory.id}
            periods={periods.map((p) => ({
              id: p.id,
              label: `${periodLabel(p)}${p.status === "CLOSED" ? (ar ? " (مقفل)" : " (closed)") : ""}`,
            }))}
          />
        </Card>
      )}

      <Card title={ar ? "السجل الشهري" : "Period history"}>
        {rates.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-400">
            {ar ? "لا توجد فترات محسوبة." : "No periods calculated."}
          </p>
        ) : (
          <DataTable
            headers={[
              ar ? "الشهر" : "Period",
              ar ? "صافي المجمع" : "Net pool",
              ar ? "دقائق منتجة" : "Productive min",
              ar ? "الفعلي" : "Actual",
              ar ? "كامل الطاقة" : "Full capacity",
              ar ? "العبء" : "Idle penalty",
              ar ? "الحالة" : "Status",
              "",
            ]}
            rows={rates.map((r) => [
              <span key={`${r.id}-p`} className="num" dir="ltr">{periodLabel(r.fiscalPeriod)}</span>,
              <span key={`${r.id}-n`} className="num">{formatMoney(r.netCostPool, locale)}</span>,
              <span key={`${r.id}-m`} className="num">{formatNumber(r.productiveMinutes, locale)}</span>,
              <span key={`${r.id}-a`} className="num font-medium">{formatRate(r.actualMinuteRate, locale)}</span>,
              <span key={`${r.id}-f`} className="num text-info">{formatRate(r.fullCapacityMinuteRate, locale)}</span>,
              <span key={`${r.id}-i`} className="num text-bad">{formatRate(r.idlePenaltyPerMinute, locale)}</span>,
              <Badge key={`${r.id}-s`} tone={r.status === "LOCKED" ? "neutral" : "warn"}>
                {r.status === "LOCKED"
                  ? (ar ? "مقفل" : "Locked")
                  : (ar ? "مبدئي" : "Provisional")}
              </Badge>,
              r.status === "PROVISIONAL" && can(session.role, "period:close") ? (
                <LockForm key={`${r.id}-l`} locale={locale} minuteRatePeriodId={r.id} />
              ) : (
                <span key={`${r.id}-l`} />
              ),
            ])}
          />
        )}
      </Card>
    </>
  );
}
