import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { markdownAnalysis } from "@/lib/analytics";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatPercent, dec, safeDiv } from "@/lib/money";

/**
 * تحليل الخصومات — what discounting actually cost.
 *
 * Discounts are posted to their own contra-revenue account rather than netted
 * into the sale price. That is the only reason this screen can exist: once a
 * discount is folded into the price, nothing distinguishes a garment sold
 * cheaply from one that was always cheap.
 *
 * The figure that matters is not what was given away but what share of the
 * margin it ate. Ten percent off a style earning forty percent is a promotion;
 * ten percent off one earning twelve is most of the profit.
 */
export default async function MarkdownPage() {
  await requirePermission("sales_order:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });
  const rows = await markdownAnalysis(brand.id);

  const givenAway = rows.reduce((s, r) => s.plus(r.givenAway), dec(0));
  const grossRevenue = rows.reduce((s, r) => s.plus(r.grossRevenue), dec(0));
  const marginAfter = rows.reduce((s, r) => s.plus(r.marginAfter), dec(0));
  const marginBefore = rows.reduce((s, r) => s.plus(r.marginBefore), dec(0));

  const painful = rows.filter((r) => r.marginEaten != null && r.marginEaten.greaterThan(0.4));

  return (
    <>
      <PageHeader
        title={ar ? "تحليل الخصومات" : "Markdown analysis"}
        subtitle={
          ar
            ? "الخصم مش بيتخصم من السعر — بيتسجّل في حساب لوحده، عشان كده نقدر نعرف كلّف كام"
            : "Discounts are posted to their own account rather than netted into the price — which is why this is answerable"
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <StatTile
          label={ar ? "قيمة الخصومات" : "Given away"}
          value={formatMoney(givenAway, locale)}
          tone={givenAway.greaterThan(0) ? "warn" : "neutral"}
        />
        <StatTile
          label={ar ? "من الإيراد قبل الخصم" : "Of pre-discount revenue"}
          value={
            grossRevenue.greaterThan(0)
              ? formatPercent(safeDiv(givenAway, grossRevenue)!, locale)
              : "—"
          }
        />
        <StatTile
          label={ar ? "مجمل الربح بعد الخصم" : "Margin after discounts"}
          value={formatMoney(marginAfter, locale)}
        />
        <StatTile
          label={ar ? "الخصم أكل من الربح" : "Share of margin eaten"}
          value={
            marginBefore.greaterThan(0)
              ? formatPercent(safeDiv(givenAway, marginBefore)!, locale)
              : "—"
          }
          tone={
            marginBefore.greaterThan(0) && givenAway.div(marginBefore).greaterThan(0.3)
              ? "bad"
              : "neutral"
          }
        />
      </div>

      {painful.length > 0 && (
        <Card
          className="mb-4"
          title={ar ? "خصومات بتاكل الربح" : "Discounts eating the profit"}
          description={
            ar
              ? "الخصم هنا أكل أكتر من ٤٠٪ من مجمل ربح الموديل"
              : "The discount consumed more than 40% of the style's gross margin"
          }
        >
          <DataTable
            headers={[
              ar ? "الموديل" : "Style",
              ar ? "اتخصم" : "Given away",
              ar ? "الربح قبل" : "Margin before",
              ar ? "الربح بعد" : "Margin after",
              ar ? "أكل من الربح" : "Margin eaten",
            ]}
            rows={painful.map((r) => [
              <span key={`${r.id}-n`}>
                <code dir="ltr" className="text-xs text-ink-500">{r.code}</code>
                <span className="ms-2">{ar ? r.nameAr : r.nameEn}</span>
              </span>,
              <span key={`${r.id}-g`} className="num text-warn">
                {formatMoney(r.givenAway, locale)}
              </span>,
              <span key={`${r.id}-b`} className="num">{formatMoney(r.marginBefore, locale)}</span>,
              <span
                key={`${r.id}-a`}
                className={r.marginAfter.lessThan(0) ? "num text-bad" : "num"}
              >
                {formatMoney(r.marginAfter, locale)}
              </span>,
              <span key={`${r.id}-e`} className="num text-bad">
                {r.marginEaten ? formatPercent(r.marginEaten, locale) : "—"}
              </span>,
            ])}
          />
        </Card>
      )}

      <Card title={ar ? "كل الموديلات" : "Every style"}>
        {rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-400">
            {ar ? "لسه مفيش مبيعات." : "No sales yet."}
          </p>
        ) : (
          <DataTable
            headers={[
              ar ? "الموديل" : "Style",
              ar ? "قطع" : "Units",
              ar ? "منها بخصم" : "Discounted",
              ar ? "أعمق خصم" : "Deepest",
              ar ? "اتخصم" : "Given away",
              ar ? "صافي الإيراد" : "Net revenue",
              ar ? "الهامش بعد" : "Margin after",
            ]}
            rows={rows.map((r) => [
              <span key={`${r.id}-n`}>
                <code dir="ltr" className="text-xs text-ink-500">{r.code}</code>
                <span className="ms-2">{ar ? r.nameAr : r.nameEn}</span>
              </span>,
              <span key={`${r.id}-u`} className="num">{r.units}</span>,
              r.discountedUnits === 0 ? (
                <Badge key={`${r.id}-d`} tone="good">{ar ? "بدون خصم" : "None"}</Badge>
              ) : (
                <span key={`${r.id}-d`} className="num">
                  {r.discountedUnits} ({formatPercent(r.discountedShare, locale)})
                </span>
              ),
              <span key={`${r.id}-x`} className="num text-ink-500">
                {r.deepestDiscount.isZero() ? "—" : formatPercent(r.deepestDiscount, locale)}
              </span>,
              <span key={`${r.id}-g`} className="num">{formatMoney(r.givenAway, locale)}</span>,
              <span key={`${r.id}-r`} className="num">{formatMoney(r.netRevenue, locale)}</span>,
              <span
                key={`${r.id}-m`}
                className={
                  r.marginPctAfter == null
                    ? "num"
                    : r.marginPctAfter.lessThan(0.2)
                      ? "num text-bad"
                      : "num text-good"
                }
              >
                {r.marginPctAfter ? formatPercent(r.marginPctAfter, locale) : "—"}
              </span>,
            ])}
          />
        )}
      </Card>
    </>
  );
}
