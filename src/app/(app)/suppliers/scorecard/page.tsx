import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { supplierScorecard } from "@/lib/analytics";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber, formatPercent, dec } from "@/lib/money";

/**
 * تقييم المورد — price, lateness and quality read together.
 *
 * Any one of the three flatters a supplier. The cheapest metre of fabric that
 * arrives a fortnight late and 8% rejected costs more than the dearest one
 * that turns up on the day, and the only way to see that is to put the three
 * columns beside each other.
 */
export default async function SupplierScorecardPage() {
  await requirePermission("purchase_order:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const rows = await supplierScorecard();

  const totalVariance = rows.reduce((s, r) => s.plus(r.priceVariance), dec(0));
  const worstPrice = [...rows].sort((a, b) => Number(b.priceVariance.minus(a.priceVariance)))[0];
  const worstQuality = [...rows]
    .filter((r) => r.rejectRate != null)
    .sort((a, b) => Number((b.rejectRate ?? dec(0)).minus(a.rejectRate ?? dec(0))))[0];

  return (
    <>
      <PageHeader
        title={ar ? "تقييم المورد" : "Supplier scorecard"}
        subtitle={
          ar
            ? "السعر والالتزام والجودة جنب بعض — أرخص متر بيوصل متأخر ومرفوض منه ٨٪ مش أرخص"
            : "Price, lateness and quality together — the cheapest metre that arrives late and 8% rejected is not the cheapest"
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatTile
          label={ar ? "إجمالي فروق الأسعار" : "Total price variance"}
          value={formatMoney(totalVariance, locale)}
          tone={totalVariance.greaterThan(0) ? "bad" : totalVariance.lessThan(0) ? "good" : "neutral"}
          hint={ar ? "الفاتورة مقابل الأمر" : "Invoice against order"}
        />
        <StatTile
          label={ar ? "أعلى فرق سعر" : "Dearest against order"}
          value={worstPrice ? (ar ? worstPrice.nameAr : worstPrice.nameEn) : "—"}
          hint={worstPrice ? formatMoney(worstPrice.priceVariance, locale) : undefined}
        />
        <StatTile
          label={ar ? "أعلى نسبة رفض" : "Highest reject rate"}
          value={worstQuality ? (ar ? worstQuality.nameAr : worstQuality.nameEn) : "—"}
          hint={
            worstQuality?.rejectRate
              ? formatPercent(worstQuality.rejectRate, locale)
              : undefined
          }
          tone={
            worstQuality?.rejectRate && worstQuality.rejectRate.greaterThan(0.05)
              ? "bad"
              : "neutral"
          }
        />
      </div>

      <Card
        title={ar ? "الموردين" : "Suppliers"}
        description={
          ar
            ? "فرق السعر الموجب معناه الفاتورة جت أعلى من الأمر"
            : "A positive price variance means the invoice came in above the order"
        }
      >
        {rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-400">
            {ar ? "لسه مفيش أوامر شراء." : "No purchase orders yet."}
          </p>
        ) : (
          <DataTable
            headers={[
              ar ? "المورد" : "Supplier",
              ar ? "أوامر" : "Orders",
              ar ? "استلامات" : "Receipts",
              ar ? "في الميعاد" : "On time",
              ar ? "متوسط التأخير" : "Avg. late",
              ar ? "نسبة الرفض" : "Rejected",
              ar ? "فرق السعر" : "Price variance",
              ar ? "الائتمان" : "Credit",
            ]}
            rows={rows.map((r) => [
              <span key={`${r.id}-n`}>
                <code dir="ltr" className="text-xs text-ink-500">{r.code}</code>
                <span className="ms-2">{ar ? r.nameAr : r.nameEn}</span>
              </span>,
              <span key={`${r.id}-o`} className="num">{r.orders}</span>,
              <span key={`${r.id}-r`} className="num">{r.receipts}</span>,
              r.onTimeRate == null ? (
                <Badge key={`${r.id}-t`} tone="neutral">—</Badge>
              ) : (
                <span
                  key={`${r.id}-t`}
                  className={
                    r.onTimeRate.greaterThanOrEqualTo(0.9)
                      ? "num text-good"
                      : r.onTimeRate.lessThan(0.6)
                        ? "num text-bad"
                        : "num text-warn"
                  }
                >
                  {formatPercent(r.onTimeRate, locale)}
                </span>
              ),
              <span key={`${r.id}-l`} className="num text-ink-500">
                {r.averageLateDays.isZero()
                  ? "—"
                  : `${formatNumber(r.averageLateDays.toDecimalPlaces(1), locale)} ${ar ? "يوم" : "d"}`}
              </span>,
              r.rejectRate == null ? (
                <Badge key={`${r.id}-q`} tone="neutral">—</Badge>
              ) : (
                <span
                  key={`${r.id}-q`}
                  className={r.rejectRate.greaterThan(0.05) ? "num text-bad" : "num text-good"}
                >
                  {formatPercent(r.rejectRate, locale)}
                </span>
              ),
              <span
                key={`${r.id}-v`}
                className={
                  r.priceVariance.greaterThan(0)
                    ? "num text-bad"
                    : r.priceVariance.lessThan(0)
                      ? "num text-good"
                      : "num text-ink-400"
                }
              >
                {r.priceVariance.isZero() ? "—" : formatMoney(r.priceVariance, locale)}
              </span>,
              <span key={`${r.id}-c`} className="num text-ink-500">
                {r.creditDays} {ar ? "يوم" : "d"}
              </span>,
            ])}
          />
        )}
      </Card>
    </>
  );
}
