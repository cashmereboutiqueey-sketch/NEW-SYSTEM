import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { sellThroughByStyle } from "@/lib/analytics";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber, formatPercent, dec, safeDiv } from "@/lib/money";

/**
 * معدل التصريف — what share of each run has actually sold.
 *
 * Measured against what was produced, not against what reached the shop: a run
 * that lost three garments on the road still cost the money to make them, and
 * hiding that would flatter the style.
 *
 * Rate of sale sits beside it because share alone is unfair to a style that
 * has only been out a fortnight.
 */
export default async function SellThroughPage() {
  await requirePermission("sales_order:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });
  const rows = await sellThroughByStyle(brand.id);

  const produced = rows.reduce((s, r) => s + r.produced, 0);
  const sold = rows.reduce((s, r) => s + r.sold, 0);
  const stuck = rows.filter(
    (r) => r.sellThrough != null && r.sellThrough.lessThan(0.3) && (r.daysOnSale ?? 0) > 60,
  );
  const stuckValue = stuck.reduce((s, r) => s.plus(r.onHandValue), dec(0));

  return (
    <>
      <PageHeader
        title={ar ? "معدل التصريف" : "Sell-through"}
        subtitle={
          ar
            ? "نسبة اللي اتباع من كل تشغيلة — بالمقارنة باللي اتصنع، مش باللي وصل المعرض"
            : "The share of each run that has sold — against what was made, not what reached the shop"
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <StatTile
          label={ar ? "اتصنع" : "Produced"}
          value={formatNumber(produced, locale)}
        />
        <StatTile
          label={ar ? "اتباع" : "Sold"}
          value={formatNumber(sold, locale)}
        />
        <StatTile
          label={ar ? "معدل التصريف" : "Sell-through"}
          value={
            produced > 0 ? formatPercent(safeDiv(dec(sold), dec(produced))!, locale) : "—"
          }
          tone={produced > 0 && sold / produced > 0.6 ? "good" : "warn"}
        />
        <StatTile
          label={ar ? "موديلات واقفة" : "Styles stalling"}
          value={formatNumber(stuck.length, locale)}
          tone={stuck.length > 0 ? "bad" : "good"}
          hint={
            stuck.length > 0
              ? `${formatMoney(stuckValue, locale)} ${ar ? "محبوسة" : "locked"}`
              : ar ? "مفيش" : "None"
          }
        />
      </div>

      {stuck.length > 0 && (
        <Card
          className="mb-4"
          title={ar ? "محتاجة قرار" : "Needs a decision"}
          description={
            ar
              ? "أكتر من شهرين في المعرض وأقل من ٣٠٪ اتصرّف"
              : "Out for more than two months and under 30% sold"
          }
        >
          <DataTable
            headers={[
              ar ? "الموديل" : "Style",
              ar ? "اتصنع" : "Made",
              ar ? "اتباع" : "Sold",
              ar ? "النسبة" : "Share",
              ar ? "في المعرض من" : "Out for",
              ar ? "محبوس" : "Locked up",
            ]}
            rows={stuck.map((r) => [
              <span key={`${r.id}-n`}>
                <code dir="ltr" className="text-xs text-ink-500">{r.code}</code>
                <span className="ms-2">{ar ? r.nameAr : r.nameEn}</span>
              </span>,
              <span key={`${r.id}-p`} className="num">{r.produced}</span>,
              <span key={`${r.id}-s`} className="num">{r.sold}</span>,
              <span key={`${r.id}-t`} className="num text-bad">
                {r.sellThrough ? formatPercent(r.sellThrough, locale) : "—"}
              </span>,
              <span key={`${r.id}-d`} className="num">
                {r.daysOnSale} {ar ? "يوم" : "d"}
              </span>,
              <span key={`${r.id}-v`} className="num">{formatMoney(r.onHandValue, locale)}</span>,
            ])}
          />
        </Card>
      )}

      <Card title={ar ? "كل الموديلات" : "Every style"}>
        {rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-400">
            {ar ? "لسه مفيش تشغيلات مكتملة." : "No completed runs yet."}
          </p>
        ) : (
          <DataTable
            headers={[
              ar ? "الموديل" : "Style",
              ar ? "الكوليكشن" : "Collection",
              ar ? "اتصنع" : "Made",
              ar ? "اتباع" : "Sold",
              ar ? "على الرف" : "On hand",
              ar ? "النسبة" : "Share",
              ar ? "قطعة/يوم" : "Units/day",
              ar ? "مجمل الربح" : "Gross margin",
            ]}
            rows={rows.map((r) => [
              <span key={`${r.id}-n`}>
                <code dir="ltr" className="text-xs text-ink-500">{r.code}</code>
                <span className="ms-2">{ar ? r.nameAr : r.nameEn}</span>
              </span>,
              <span key={`${r.id}-c`} className="text-ink-500">
                {(ar ? r.collectionAr : r.collectionEn) ?? "—"}
              </span>,
              <span key={`${r.id}-p`} className="num">{r.produced}</span>,
              <span key={`${r.id}-s`} className="num">{r.sold}</span>,
              <span key={`${r.id}-h`} className="num">{formatNumber(r.onHand, locale)}</span>,
              r.sellThrough == null ? (
                <Badge key={`${r.id}-t`} tone="neutral">—</Badge>
              ) : (
                <span
                  key={`${r.id}-t`}
                  className={
                    r.sellThrough.greaterThan(0.6)
                      ? "num text-good"
                      : r.sellThrough.lessThan(0.3)
                        ? "num text-bad"
                        : "num text-warn"
                  }
                >
                  {formatPercent(r.sellThrough, locale)}
                </span>
              ),
              <span key={`${r.id}-r`} className="num text-ink-500">
                {r.rateOfSale ? formatNumber(r.rateOfSale.toDecimalPlaces(2), locale) : "—"}
              </span>,
              <span key={`${r.id}-m`} className="num">{formatMoney(r.grossMargin, locale)}</span>,
            ])}
          />
        )}
      </Card>
    </>
  );
}
