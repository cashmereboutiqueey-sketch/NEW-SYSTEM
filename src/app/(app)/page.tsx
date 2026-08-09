import Link from "next/link";
import { getPrefs } from "@/lib/session";
import { requireUser } from "@/lib/auth";
import { can } from "@/core/permissions";
import { PageHeader, Card, StatTile, DataTable, Badge } from "@/components/ui";
import { formatMoney, formatNumber, formatRate, formatPercent } from "@/lib/money";
import { ownerDashboard } from "@/lib/dashboard";
import { AGE_BUCKETS } from "@/core/fifo";
import { dec } from "@/lib/money";

/**
 * The owner's cockpit.
 *
 * Every tile is derived from the ledger or the stock records and links to the
 * screen that owns it, so no number here is something the owner has to take
 * on trust. Where a figure cannot be computed yet, the tile says so instead of
 * showing a zero that reads like an answer.
 */
export default async function DashboardPage() {
  const session = await requireUser();
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const d = await ownerDashboard();
  const seeGroup = can(session.role, "report:group");

  const tile = (href: string, node: React.ReactNode) => (
    <Link href={href} className="block transition-opacity hover:opacity-80">
      {node}
    </Link>
  );

  return (
    <>
      <PageHeader
        title={ar ? "لوحة المالك" : "Owner dashboard"}
        subtitle={
          ar
            ? "كل رقم هنا محسوب من الدفاتر، ويفتح على الشاشة اللي جايّ منها"
            : "Every figure is computed from the books and opens on the screen it comes from"
        }
      />

      {/* --- money --- */}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tile("/reports/entity-pnl", (
          <StatTile
            label={ar ? "النقدية والبنك" : "Cash and bank"}
            value={formatMoney(d.cash, locale)}
            tone={d.cash.greaterThan(0) ? "good" : "bad"}
            hint={ar ? "شامل تحصيلات لم تصل بعد" : "Includes money not yet settled"}
          />
        ))}
        {tile("/expenses", (
          <StatTile
            label={ar ? "مستحق للموردين" : "Owed to suppliers"}
            value={formatMoney(d.payables, locale)}
            tone={d.payables.greaterThan(0) ? "warn" : "good"}
          />
        ))}
        {tile("/expenses", (
          <StatTile
            label={ar ? "متأخر عن السداد" : "Overdue"}
            value={formatMoney(d.overduePayables, locale)}
            tone={d.overduePayables.greaterThan(0) ? "bad" : "good"}
          />
        ))}
        {tile("/inventory", (
          <StatTile
            label={ar ? "رأس المال في المخزون" : "Capital in stock"}
            value={formatMoney(d.stock.total, locale)}
            tone={d.stock.total.greaterThan(0) ? "warn" : "neutral"}
            hint={`${formatMoney(d.stock.raw, locale)} ${ar ? "خامات" : "raw"}`}
          />
        ))}
      </div>

      {/* --- the factory's central number --- */}
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card
          title={ar ? "الطاقة العاطلة" : "Idle capacity"}
          description={
            ar
              ? "الفرق بين تكلفة الدقيقة الفعلية وتكلفتها بكامل الطاقة"
              : "The gap between the actual minute rate and the full-capacity rate"
          }
        >
          {d.minuteRate ? (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <div className="text-xs text-ink-500">{ar ? "الفعلي" : "Actual"}</div>
                  <div className="num text-lg font-semibold">
                    {formatRate(d.minuteRate.actual, locale)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-ink-500">{ar ? "كامل الطاقة" : "Full capacity"}</div>
                  <div className="num text-lg font-semibold text-info">
                    {formatRate(d.minuteRate.fullCapacity, locale)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-ink-500">{ar ? "العبء" : "Idle penalty"}</div>
                  <div className="num text-lg font-semibold text-bad">
                    {formatRate(d.minuteRate.idlePenalty, locale)}
                  </div>
                </div>
              </div>
              <p className="mt-3 text-xs text-ink-500">
                {ar
                  ? `${formatNumber(d.minuteRate.idleMinutes, locale)} دقيقة عاطلة في ${d.minuteRate.period}. كل دقيقة تُباع فوق سعر كامل الطاقة بتقلّل تكلفة الدقيقة على البراند.`
                  : `${formatNumber(d.minuteRate.idleMinutes, locale)} idle minutes in ${d.minuteRate.period}. Every minute sold above the full-capacity rate lowers the rate the brand pays.`}
              </p>
              <Link href="/minute-rate" className="mt-2 inline-block text-xs underline">
                {ar ? "افتح تكلفة الدقيقة" : "Open the minute rate"}
              </Link>
            </>
          ) : (
            <p className="py-4 text-sm text-ink-400">
              {ar
                ? "لم تُحسب تكلفة الدقيقة بعد — سجّل مصروفات التشغيل ثم احسب الشهر."
                : "No minute rate calculated yet — post conversion costs, then calculate the period."}
            </p>
          )}
        </Card>

        <Card
          title={ar ? "دورة الكاش" : "Cash conversion cycle"}
          description={
            ar
              ? "الأيام من دفع ثمن القماش حتى تحصيل ثمن القطعة"
              : "Days from paying for fabric to collecting for the garment"
          }
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <div className="text-xs text-ink-500">{ar ? "طول الدورة" : "Cycle length"}</div>
              <div className="num text-2xl font-semibold">
                {formatNumber(d.ccc.cashConversionDays, locale)}{" "}
                <span className="text-sm font-normal text-ink-500">{ar ? "يوم" : "days"}</span>
              </div>
            </div>
            <div>
              <div className="text-xs text-ink-500">{ar ? "رأس مال محبوس" : "Capital locked"}</div>
              <div className="num text-2xl font-semibold text-warn">
                {formatMoney(d.ccc.workingCapitalLocked, locale)}
              </div>
            </div>
          </div>
          <p className="mt-3 text-xs text-ink-500">
            {d.ccc.cashConversionDays.greaterThan(0)
              ? ar
                ? "الدورة موجبة، يعني كل نمو في المبيعات بيستهلك كاش قبل ما يجيب."
                : "A positive cycle means every unit of growth consumes cash before it returns any."
              : ar
                ? "الدورة سالبة — الموردون بيموّلوا التشغيل."
                : "A negative cycle — suppliers are funding operations."}
          </p>
          <Link href="/settings" className="mt-2 inline-block text-xs underline">
            {ar ? "الأيام المفترضة قابلة للتعديل" : "The assumed days are configurable"}
          </Link>
        </Card>
      </div>

      {/* --- trading --- */}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tile("/sales", (
          <StatTile
            label={ar ? "إيراد المبيعات" : "Sales revenue"}
            value={formatMoney(d.sales.revenue, locale)}
            hint={`${formatNumber(d.sales.unitsSold, locale)} ${ar ? "قطعة" : "units"}`}
          />
        ))}
        {tile("/sales", (
          <StatTile
            label={ar ? "مجمل الربح" : "Gross margin"}
            value={formatMoney(d.sales.grossMargin, locale)}
            tone={d.sales.grossMargin.greaterThan(0) ? "good" : "bad"}
            hint={d.sales.grossMarginPct ? formatPercent(d.sales.grossMarginPct, locale) : undefined}
          />
        ))}
        {tile("/sales", (
          <StatTile
            label={ar ? "الربح بعد التسويق" : "Profit after marketing"}
            value={formatMoney(d.marketing.profitAfterMarketing, locale)}
            tone={d.marketing.profitAfterMarketing.greaterThan(0) ? "good" : "bad"}
            hint={
              d.marketing.contributionRoas
                ? `${ar ? "عائد على الإنفاق" : "Contribution ROAS"} ${d.marketing.contributionRoas.toFixed(2)}×`
                : ar ? "لا يوجد إنفاق تسويقي" : "No marketing spend"
            }
          />
        ))}
        {tile("/inventory", (
          <StatTile
            label={ar ? "المخزون الراكد" : "Dead stock"}
            value={formatMoney(d.deadStock, locale)}
            tone={d.deadStock.greaterThan(0) ? "bad" : "good"}
            hint={ar ? "أكثر من ٩٠ يومًا" : "Older than 90 days"}
          />
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {seeGroup && (
          <Card
            title={ar ? "المجموعة" : "The group"}
            description={
              ar
                ? "بعد حذف البيع الداخلي والربح غير المحقق"
                : "After removing the internal sale and unrealised profit"
            }
          >
            <dl className="space-y-2 text-sm">
              {[
                [ar ? "ربح المصنع" : "Factory profit", d.group.factoryProfit],
                [ar ? "ربح البراند" : "Brand profit", d.group.brandProfit],
                [ar ? "ربح غير محقق في المخزون" : "Unrealised in stock", d.group.unrealised],
              ].map(([label, v]) => (
                <div
                  key={String(label)}
                  className="flex items-baseline justify-between border-b border-ink-100 pb-1.5"
                >
                  <dt className="text-ink-600">{String(label)}</dt>
                  <dd className="num">{formatMoney(v as never, locale)}</dd>
                </div>
              ))}
              <div className="flex items-baseline justify-between border-t border-ink-300 pt-2 font-semibold">
                <dt>{ar ? "ربح المجموعة" : "Group profit"}</dt>
                <dd
                  className={
                    dec(d.group.groupProfit).greaterThan(0)
                      ? "num text-good"
                      : "num text-bad"
                  }
                >
                  {formatMoney(d.group.groupProfit, locale)}
                </dd>
              </div>
            </dl>
            <div className="mt-3 flex items-center gap-3">
              <Badge tone={d.group.intercompanyMatched ? "good" : "bad"}>
                {d.group.intercompanyMatched
                  ? ar ? "الحساب الجاري مطابق" : "Intercompany matched"
                  : ar ? "فرق في الحساب الجاري" : "Intercompany difference"}
              </Badge>
              <Link href="/reports/group-pnl" className="text-xs underline">
                {ar ? "افتح قائمة المجموعة" : "Open the group statement"}
              </Link>
            </div>
          </Card>
        )}

        <Card
          title={ar ? "أعمار البضاعة الجاهزة" : "Finished goods ageing"}
          description={
            ar
              ? "رأس المال المحبوس حسب مدة بقاء البضاعة"
              : "Capital locked by how long the goods have been sitting"
          }
        >
          <DataTable
            headers={[
              ar ? "العمر" : "Age",
              ar ? "الكمية" : "Quantity",
              ar ? "القيمة" : "Value",
            ]}
            rows={AGE_BUCKETS.map((b) => [
              <span key={`${b}-l`} className={b === "90+" ? "text-bad" : undefined}>
                {b === "90+" ? (ar ? "أكثر من ٩٠ يوم" : "90+ days") : `${b} ${ar ? "يوم" : "days"}`}
              </span>,
              <span key={`${b}-q`} className="num">{formatNumber(d.aging[b].quantity, locale)}</span>,
              <span
                key={`${b}-v`}
                className={b === "90+" && d.aging[b].value.greaterThan(0) ? "num text-bad" : "num"}
              >
                {formatMoney(d.aging[b].value, locale)}
              </span>,
            ])}
          />
          {d.gmroi && (
            <p className="mt-3 text-xs text-ink-500">
              {ar
                ? `كل جنيه في البضاعة الجاهزة بيجيب ${d.gmroi.toFixed(2)} جنيه مجمل ربح.`
                : `Each pound in finished goods returns ${d.gmroi.toFixed(2)} of gross margin.`}
            </p>
          )}
        </Card>
      </div>
    </>
  );
}
