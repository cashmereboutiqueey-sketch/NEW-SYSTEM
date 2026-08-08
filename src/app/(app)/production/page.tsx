import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requireUser } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber, formatPercent } from "@/lib/money";
import { variance } from "@/core/production";
import { dec } from "@/lib/money";

/**
 * Production orders.
 *
 * The columns that matter are planned against actual. A single "cost" figure
 * says the run was expensive; the split says whether that was the cutting
 * table or the sewing line.
 */
export default async function ProductionPage() {
  await requireUser();
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const orders = await db.productionOrder.findMany({
    include: {
      style: true,
      costSnapshot: true,
      minuteRatePeriod: { include: { fiscalPeriod: true } },
      materialIssues: { include: { material: true } },
    },
    orderBy: [{ orderDate: "desc" }, { createdAt: "desc" }],
    take: 50,
  });

  const inFlight = orders.filter(
    (o) => o.status === "CONFIRMED" || o.status === "IN_PRODUCTION",
  );
  const completed = orders.filter((o) => o.status === "COMPLETED");

  const plannedInFlight = inFlight.reduce(
    (s, o) => s.plus(dec(o.plannedTotalCost ?? 0)), dec(0),
  );
  const unitsCompleted = completed.reduce((s, o) => s + (o.actualQty ?? 0), 0);

  const name = (e: { nameAr: string; nameEn: string }) => (ar ? e.nameAr : e.nameEn);

  const statusTone: Record<string, "neutral" | "info" | "good" | "warn" | "bad"> = {
    DRAFT: "neutral", CONFIRMED: "info", IN_PRODUCTION: "warn",
    COMPLETED: "good", CANCELLED: "bad",
  };
  const statusLabel: Record<string, string> = ar
    ? {
        DRAFT: "مسودة", CONFIRMED: "مؤكد", IN_PRODUCTION: "تحت التنفيذ",
        COMPLETED: "مكتمل", CANCELLED: "ملغي",
      }
    : {
        DRAFT: "Draft", CONFIRMED: "Confirmed", IN_PRODUCTION: "In production",
        COMPLETED: "Completed", CANCELLED: "Cancelled",
      };

  return (
    <>
      <PageHeader
        title={t("productionOrder", locale)}
        subtitle={
          ar
            ? "المخطط مقابل الفعلي — عشان نعرف ليه التكلفة طلعت كده، مش بس كام"
            : "Planned against actual — so the run explains why it cost what it did, not merely what it cost"
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatTile
          label={ar ? "أوامر تحت التنفيذ" : "Orders in flight"}
          value={String(inFlight.length)}
          hint={formatMoney(plannedInFlight, locale)}
          tone={inFlight.length > 0 ? "info" : "neutral"}
        />
        <StatTile
          label={ar ? "أوامر مكتملة" : "Completed orders"}
          value={String(completed.length)}
        />
        <StatTile
          label={ar ? "قطع منتجة" : "Garments produced"}
          value={formatNumber(unitsCompleted, locale)}
        />
      </div>

      {orders.length === 0 ? (
        <Card>
          <p className="py-8 text-center text-sm text-ink-400">
            {ar
              ? "لا توجد أوامر إنتاج بعد. أمر الإنتاج بيجمّد تكلفته عند التأكيد، فيفضل متسعّر بنفس السعر للأبد."
              : "No production orders yet. An order freezes its cost basis when confirmed, so it stays priced at that basis forever."}
          </p>
        </Card>
      ) : (
        <>
          <Card
            className="mb-4"
            title={ar ? "الأوامر" : "Orders"}
            description={
              ar
                ? "التكلفة المجمّدة تتبع شهر تكلفة الدقيقة وقت التأكيد"
                : "The frozen cost follows the minute-rate period it was confirmed against"
            }
          >
            <DataTable
              headers={[
                ar ? "الأمر" : "Order",
                ar ? "الموديل" : "Style",
                ar ? "الحالة" : "Status",
                ar ? "مخطط" : "Planned",
                ar ? "فعلي" : "Actual",
                ar ? "شهر التكلفة" : "Rate period",
                ar ? "تكلفة الوحدة" : "Unit cost",
                ar ? "إجمالي مخطط" : "Planned total",
              ]}
              rows={orders.map((o) => [
                <code key={`${o.id}-n`} dir="ltr" className="text-xs text-ink-500">
                  {o.orderNumber}
                </code>,
                <span key={`${o.id}-s`}>
                  <code dir="ltr" className="text-xs text-ink-500">{o.style.code}</code>
                  <span className="ms-2">{name(o.style)}</span>
                </span>,
                <Badge key={`${o.id}-st`} tone={statusTone[o.status]}>
                  {statusLabel[o.status]}
                </Badge>,
                <span key={`${o.id}-p`} className="num">{formatNumber(o.plannedQty, locale)}</span>,
                <span key={`${o.id}-a`} className="num">
                  {o.actualQty == null ? "—" : formatNumber(o.actualQty, locale)}
                  {o.rejectedQty > 0 && (
                    <span className="ms-1 text-xs text-bad">
                      (−{o.rejectedQty})
                    </span>
                  )}
                </span>,
                <span key={`${o.id}-r`} className="num" dir="ltr">
                  {o.minuteRatePeriod
                    ? `${o.minuteRatePeriod.fiscalPeriod.year}-${String(o.minuteRatePeriod.fiscalPeriod.month).padStart(2, "0")}`
                    : "—"}
                </span>,
                <span key={`${o.id}-u`} className="num">
                  {o.costSnapshot ? formatMoney(o.costSnapshot.factoryTotalCost, locale) : "—"}
                </span>,
                <span key={`${o.id}-t`} className="num font-medium">
                  {o.plannedTotalCost ? formatMoney(o.plannedTotalCost, locale) : "—"}
                </span>,
              ])}
            />
          </Card>

          {completed.length > 0 && (
            <Card
              title={ar ? "تحليل الفروق" : "Variance analysis"}
              description={
                ar
                  ? "الفرق السالب يعني استهلاك أقل من المخطط"
                  : "A negative variance means less was used than planned"
              }
            >
              <DataTable
                headers={[
                  ar ? "الأمر" : "Order",
                  ar ? "قماش مخطط" : "Fabric planned",
                  ar ? "قماش فعلي" : "Fabric actual",
                  ar ? "فرق القماش" : "Fabric variance",
                  ar ? "دقائق مخططة" : "Minutes planned",
                  ar ? "دقائق فعلية" : "Minutes actual",
                  ar ? "هدر فعلي" : "Actual waste",
                ]}
                rows={completed.map((o) => {
                  const fabricVar = variance(o.plannedFabricQty ?? 0, o.actualFabricQty ?? 0);
                  const minuteVar = variance(o.plannedTotalMinutes ?? 0, o.actualTotalMinutes ?? 0);
                  // Weighted across every issue on the order, so a small
                  // offcut does not distort a large run.
                  const issues = o.materialIssues;
                  const totalActual = issues.reduce((s, i) => s.plus(dec(i.actualQty)), dec(0));
                  const totalStandard = issues.reduce((s, i) => s.plus(dec(i.standardQty)), dec(0));
                  const realisedWaste = totalStandard.isZero()
                    ? null
                    : totalActual.div(totalStandard).minus(1);

                  return [
                    <code key={`${o.id}-n`} dir="ltr" className="text-xs text-ink-500">
                      {o.orderNumber}
                    </code>,
                    <span key={`${o.id}-fp`} className="num">{formatNumber(fabricVar.planned, locale)}</span>,
                    <span key={`${o.id}-fa`} className="num">{formatNumber(fabricVar.actual, locale)}</span>,
                    <span
                      key={`${o.id}-fv`}
                      className={fabricVar.favourable ? "num text-good" : "num text-bad"}
                    >
                      {fabricVar.variance.greaterThan(0) ? "+" : ""}
                      {formatNumber(fabricVar.variance, locale)}
                    </span>,
                    <span key={`${o.id}-mp`} className="num">{formatNumber(minuteVar.planned, locale)}</span>,
                    <span key={`${o.id}-ma`} className="num">{formatNumber(minuteVar.actual, locale)}</span>,
                    <span
                      key={`${o.id}-w`}
                      className={
                        realisedWaste && realisedWaste.greaterThan(dec(o.costSnapshot?.wasteRate ?? 0))
                          ? "num text-bad"
                          : "num"
                      }
                    >
                      {realisedWaste ? formatPercent(realisedWaste, locale) : "—"}
                    </span>,
                  ];
                })}
              />
              <p className="mt-3 text-xs text-ink-500">
                {ar
                  ? "الهدر الفعلي بيقارن بالمخطط للتنبيه فقط — التكلفة التاريخية لا تُعاد كتابتها أبدًا."
                  : "Actual waste is compared with plan for alerting only — historical costs are never rewritten."}
              </p>
            </Card>
          )}
        </>
      )}
    </>
  );
}
