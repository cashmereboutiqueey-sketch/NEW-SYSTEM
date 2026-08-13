import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { can } from "@/core/permissions";
import { supplierScorecard } from "@/lib/analytics";
import { scorecardHistory, scorablePeriods } from "@/lib/supplier-scorecards";
import { FreezeForm } from "./freeze-form";
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
  const session = await requirePermission("purchase_order:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const [rows, history, periods] = await Promise.all([
    supplierScorecard(),
    scorecardHistory(),
    scorablePeriods(),
  ]);
  const mayFreeze = can(session.role, "settings:manage");

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

      {mayFreeze && (
        <div className="mt-5">
          <Card
            title={ar ? "احفظ تقييم فترة" : "Freeze a period"}
            description={
              ar
                ? "الجدول اللي فوق بيحسب كل حاجة حصلت من الأول — بيقول المورد عامل إزاي، مش بيقول هو بيتحسن ولا بيسوء."
                : "The table above is computed over everything that ever happened. It says how a supplier is, not whether they are getting better."
            }
          >
            <FreezeForm
              ar={ar}
              periods={periods.map((p) => ({
                id: p.id, label: p.label, status: p.status, scored: p.scored,
              }))}
            />
          </Card>
        </div>
      )}

      {history.length > 0 && (
        <div className="mt-5">
          <Card
            title={ar ? "التقييم عبر الفترات" : "Scores over time"}
            description={
              ar
                ? "الدرجة من ١٠. الاتجاه أهم من الرقم: مورد نازل من ٩ لـ ٧ أخطر من واحد ثابت على ٧٫٥."
                : "Out of ten. The direction matters more than the number: 9 falling to 7 is worse than a steady 7.5."
            }
          >
            <DataTable
              headers={[
                ar ? "المورد" : "Supplier",
                ar ? "آخر فترة" : "Latest",
                ar ? "الإجمالي" : "Overall",
                ar ? "الحركة" : "Movement",
                ar ? "المواعيد" : "Delivery",
                ar ? "الجودة" : "Quality",
                ar ? "السعر" : "Price",
                ar ? "فترات محفوظة" : "Periods",
              ]}
              rows={history.map((h) => [
                <span key="n" className="font-medium text-ink-900">
                  {ar ? h.nameAr : h.nameEn}
                  <span className="ms-2 num text-xs text-ink-400" dir="ltr">{h.code}</span>
                </span>,
                <span key="p" className="num text-xs" dir="ltr">{h.latest?.period ?? "—"}</span>,
                h.latest ? (
                  <Badge
                    key="o"
                    tone={
                      Number(h.latest.overallScore) >= 8.5
                        ? "good"
                        : Number(h.latest.overallScore) >= 6.5
                          ? "warn"
                          : "bad"
                    }
                  >
                    {Number(h.latest.overallScore).toFixed(1)}
                  </Badge>
                ) : (
                  <span key="o" className="text-ink-300">—</span>
                ),
                h.movement ? (
                  <span
                    key="m"
                    className={
                      Number(h.movement) > 0 ? "num text-good" : Number(h.movement) < 0 ? "num text-bad" : "num"
                    }
                  >
                    {Number(h.movement) > 0 ? "+" : ""}
                    {Number(h.movement).toFixed(1)}
                  </span>
                ) : (
                  <span key="m" className="text-ink-300">—</span>
                ),
                <span key="d" className="num text-xs">
                  {h.latest ? Number(h.latest.deliveryScore).toFixed(1) : "—"}
                </span>,
                <span key="q" className="num text-xs">
                  {h.latest ? Number(h.latest.qualityScore).toFixed(1) : "—"}
                </span>,
                <span key="pr" className="num text-xs">
                  {h.latest ? Number(h.latest.priceScore).toFixed(1) : "—"}
                </span>,
                <span key="c" className="num text-xs text-ink-500">
                  {formatNumber(h.periods.length)}
                </span>,
              ])}
            />
          </Card>
        </div>
      )}
    </>
  );
}
