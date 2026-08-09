import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { breakEvenByStyle } from "@/lib/analytics";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber, formatPercent } from "@/lib/money";

/**
 * نقطة التعادل — how many of each garment must sell before the month is paid for.
 *
 * Contribution is what a garment leaves behind after everything that varies
 * with it: the transfer price, packaging, shipping, its share of marketing,
 * and the returns that come back and earn nothing.
 *
 * Fixed costs here are Brand fixed costs only. Factory overhead is already
 * absorbed into the transfer price, so counting it again would charge it twice
 * and make a healthy style look unviable.
 */
export default async function BreakEvenPage() {
  await requirePermission("journal:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });
  const report = await breakEvenByStyle(brand.id);

  const losing = report.rows.filter((r) => !r.result.achievable);

  return (
    <>
      <PageHeader
        title={ar ? "نقطة التعادل" : "Break-even"}
        subtitle={
          ar
            ? "كام قطعة لازم تتباع قبل ما الشهر يدفع تكاليفه — التكاليف الثابتة هنا بتاعة البراند بس"
            : "How many garments must sell before the month pays for itself — Brand fixed costs only"
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <StatTile
          label={ar ? "ثابت شهري (البراند)" : "Monthly fixed (Brand)"}
          value={formatMoney(report.monthlyFixed, locale)}
        />
        <StatTile
          label={ar ? "تسويق للقطعة" : "Marketing per garment"}
          value={formatMoney(report.marketingPerUnit, locale)}
          hint={ar ? "موزّع على المبيعات" : "Spread across units sold"}
        />
        <StatTile
          label={ar ? "تغليف وشحن" : "Packaging and shipping"}
          value={formatMoney(report.packaging.plus(report.shipping), locale)}
          hint={ar ? "من الإعدادات" : "From settings"}
        />
        <StatTile
          label={ar ? "موديلات مش بتغطي" : "Styles that never break even"}
          value={formatNumber(losing.length, locale)}
          tone={losing.length > 0 ? "bad" : "good"}
        />
      </div>

      {losing.length > 0 && (
        <Card
          className="mb-4"
          title={ar ? "بتخسر على كل قطعة" : "Losing money on every garment"}
          description={
            ar
              ? "سعر البيع بعد الخصم والمرتجعات أقل من التكلفة المتغيرة — الكمية مش هتحل ده"
              : "The price after discount and returns is below the variable cost — volume cannot fix this"
          }
        >
          <DataTable
            headers={[
              ar ? "الموديل" : "Style",
              ar ? "سعر البيع" : "Retail",
              ar ? "سعر التحويل" : "Transfer",
              ar ? "متوسط الخصم" : "Avg. discount",
              ar ? "هامش المساهمة" : "Contribution",
            ]}
            rows={losing.map((r) => [
              <span key={`${r.id}-n`}>
                <code dir="ltr" className="text-xs text-ink-500">{r.code}</code>
                <span className="ms-2">{ar ? r.nameAr : r.nameEn}</span>
              </span>,
              <span key={`${r.id}-p`} className="num">{formatMoney(r.retailPrice, locale)}</span>,
              <span key={`${r.id}-t`} className="num">{formatMoney(r.transferPrice, locale)}</span>,
              <span key={`${r.id}-d`} className="num text-warn">
                {formatPercent(r.discountRate, locale)}
              </span>,
              <span key={`${r.id}-c`} className="num text-bad">
                {formatMoney(r.contributionMargin, locale)}
              </span>,
            ])}
          />
        </Card>
      )}

      <Card
        className="mb-4"
        title={ar ? "بالموديل" : "By style"}
        description={
          ar
            ? "الثابت متوزّع بنسبة القطع المباعة من كل موديل"
            : "Fixed costs are allocated by each style's share of units sold"
        }
      >
        {report.rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-400">
            {ar
              ? "محتاج موديلات لها سعر بيع ولقطة تكلفة."
              : "Styles need a retail price and a cost snapshot before this can be worked out."}
          </p>
        ) : (
          <DataTable
            headers={[
              ar ? "الموديل" : "Style",
              ar ? "سعر بعد الخصم" : "Net price",
              ar ? "إيراد فعّال" : "After returns",
              ar ? "تكلفة متغيرة" : "Variable cost",
              ar ? "هامش المساهمة" : "Contribution",
              "%",
              ar ? "اتباع" : "Sold",
              ar ? "التعادل" : "Break-even",
            ]}
            rows={report.rows.map((r) => [
              <span key={`${r.id}-n`}>
                <code dir="ltr" className="text-xs text-ink-500">{r.code}</code>
                <span className="ms-2">{ar ? r.nameAr : r.nameEn}</span>
              </span>,
              <span key={`${r.id}-np`} className="num">{formatMoney(r.netPrice, locale)}</span>,
              <span key={`${r.id}-er`} className="num text-ink-500">
                {formatMoney(r.effectiveRevenue, locale)}
              </span>,
              <span key={`${r.id}-vc`} className="num text-ink-500">
                {formatMoney(r.variableCost, locale)}
              </span>,
              <span
                key={`${r.id}-cm`}
                className={r.contributionMargin.greaterThan(0) ? "num text-good" : "num text-bad"}
              >
                {formatMoney(r.contributionMargin, locale)}
              </span>,
              <span key={`${r.id}-cp`} className="num text-ink-500">
                {r.contributionMarginPct ? formatPercent(r.contributionMarginPct, locale) : "—"}
              </span>,
              <span key={`${r.id}-u`} className="num">{r.unitsSold}</span>,
              r.result.achievable ? (
                <span
                  key={`${r.id}-be`}
                  className={
                    r.unitsSold >= Number(r.result.units) ? "num text-good" : "num text-warn"
                  }
                >
                  {formatNumber(r.result.units.toDecimalPlaces(0), locale)}
                  {ar ? " قطعة" : " units"}
                </span>
              ) : (
                <Badge key={`${r.id}-be`} tone="bad">{ar ? "لا يتعادل" : "Never"}</Badge>
              ),
            ])}
          />
        )}
      </Card>

      <Card title={ar ? "الافتراضات" : "The assumptions"}>
        <ul className="space-y-1 text-sm text-ink-600">
          <li>
            {ar ? "نسبة المرتجعات: " : "Return rate: "}
            <span className="num">{formatPercent(report.returnRate, locale)}</span>
            {ar ? " — من الإعدادات، مش محسوبة من مرتجعات فعلية بعد." : " — from settings, not yet measured from actual returns."}
          </li>
          <li>
            {ar ? "التسويق موزّع بالتساوي على " : "Marketing spread evenly across "}
            <span className="num">{formatNumber(report.totalUnitsSold, locale)}</span>
            {ar ? " قطعة مباعة — الحملة نادرًا بتخص موديل واحد." : " units sold — a campaign rarely names one style."}
          </li>
          <li>
            {ar
              ? "الخصم متوسط مرجّح بالكميات المباعة فعلًا، مش رقم مفترض."
              : "The discount is weighted by units actually sold, not an assumed figure."}
          </li>
        </ul>
      </Card>
    </>
  );
}
