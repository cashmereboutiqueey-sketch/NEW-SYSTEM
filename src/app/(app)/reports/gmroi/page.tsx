import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { gmroiByCollection } from "@/lib/analytics";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber, formatPercent, dec, safeDiv } from "@/lib/money";

/**
 * العائد على المخزون — what each pound tied up in stock earns.
 *
 * Margin alone rewards a collection nobody buys as long as its prices are
 * high. GMROI divides the margin earned by the capital sitting in the
 * warehouse, so a thin-margin collection that turns over beats a fat-margin
 * one that does not — which is the true comparison when cash is the
 * constraint.
 */
export default async function GmroiPage() {
  await requirePermission("inventory:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });
  const rows = await gmroiByCollection(brand.id);

  const totalMargin = rows.reduce((s, r) => s.plus(r.grossMargin), dec(0));
  const totalStock = rows.reduce((s, r) => s.plus(r.stockValue), dec(0));
  const overall = safeDiv(totalMargin, totalStock);

  return (
    <>
      <PageHeader
        title={ar ? "العائد على المخزون" : "Return on inventory"}
        subtitle={
          ar
            ? "مجمل الربح على كل جنيه محبوس في البضاعة — الهامش لوحده بيكافئ كوليكشن محدش بيشتريه"
            : "Gross margin per pound tied up in stock — margin alone rewards a collection nobody buys"
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatTile
          label={ar ? "العائد الإجمالي" : "Overall GMROI"}
          value={overall ? `${formatNumber(overall.toDecimalPlaces(2), locale)}×` : "—"}
          tone={overall && overall.greaterThan(1) ? "good" : "warn"}
          hint={ar ? "أقل من ١ يعني المخزون بيخسر" : "Below 1 means stock is losing"}
        />
        <StatTile
          label={ar ? "مجمل الربح" : "Gross margin"}
          value={formatMoney(totalMargin, locale)}
        />
        <StatTile
          label={ar ? "رأس المال في المخزون" : "Capital in stock"}
          value={formatMoney(totalStock, locale)}
        />
      </div>

      <Card
        title={ar ? "بالكوليكشن" : "By collection"}
        description={
          ar
            ? "العائد فاضي لما مايبقاش فيه مخزون — مفيش رأس مال يجيب عليه عائد"
            : "The return is blank when nothing is left in stock — there is no capital to earn a return on"
        }
      >
        {rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-400">
            {ar ? "لسه مفيش بيع ولا مخزون." : "Nothing sold and nothing in stock yet."}
          </p>
        ) : (
          <DataTable
            headers={[
              ar ? "الكوليكشن" : "Collection",
              ar ? "الإيراد" : "Revenue",
              ar ? "مجمل الربح" : "Gross margin",
              "%",
              ar ? "المخزون" : "Stock",
              ar ? "قطع متبقية" : "Units left",
              ar ? "العائد" : "GMROI",
            ]}
            rows={rows.map((r) => [
              <span key={`${r.id}-n`}>
                {ar ? r.nameAr : r.nameEn}
                {r.season && (
                  <span className="ms-2 text-xs text-ink-400">{r.season}</span>
                )}
              </span>,
              <span key={`${r.id}-r`} className="num">{formatMoney(r.revenue, locale)}</span>,
              <span key={`${r.id}-m`} className="num">{formatMoney(r.grossMargin, locale)}</span>,
              <span key={`${r.id}-p`} className="num text-ink-500">
                {r.marginPct ? formatPercent(r.marginPct, locale) : "—"}
              </span>,
              <span key={`${r.id}-s`} className="num">{formatMoney(r.stockValue, locale)}</span>,
              <span key={`${r.id}-u`} className="num text-ink-500">
                {formatNumber(r.unitsInStock, locale)}
              </span>,
              r.gmroi == null ? (
                <Badge key={`${r.id}-g`} tone="neutral">{ar ? "اتصرّف" : "Cleared"}</Badge>
              ) : (
                <span
                  key={`${r.id}-g`}
                  className={
                    r.gmroi.greaterThan(1) ? "num font-medium text-good" : "num font-medium text-bad"
                  }
                >
                  {formatNumber(r.gmroi.toDecimalPlaces(2), locale)}×
                </span>
              ),
            ])}
          />
        )}
        <p className="mt-3 text-xs text-ink-500">
          {ar
            ? "العائد = مجمل الربح ÷ قيمة المخزون بالتكلفة. أعلى من ١ يعني كل جنيه في المخزون جاب أكتر من جنيه ربح."
            : "GMROI = gross margin ÷ stock at cost. Above 1 means every pound in stock has earned more than a pound of margin."}
        </p>
      </Card>
    </>
  );
}
