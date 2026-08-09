import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requireUser } from "@/lib/auth";
import { can } from "@/core/permissions";
import { t } from "@/lib/i18n";
import { plannedMaterials } from "@/lib/production";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber, formatPercent } from "@/lib/money";
import { variance } from "@/core/production";
import { dec } from "@/lib/money";
import {
  NewOrderForm,
  ConfirmOrderForm,
  IssueMaterialForm,
  CompleteOrderForm,
} from "./production-forms";

/**
 * Production orders.
 *
 * The columns that matter are planned against actual. A single "cost" figure
 * says the run was expensive; the split says whether that was the cutting
 * table or the sewing line.
 */
export default async function ProductionPage() {
  const session = await requireUser();
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const mayCreate = can(session.role, "production:create");
  const mayConfirm = can(session.role, "production:confirm_cost");
  const mayRecord = can(session.role, "production:record");

  const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });

  const [orders, styles, periods, locations] = await Promise.all([
    db.productionOrder.findMany({
      include: {
        style: {
          include: {
            variants: {
              where: { isActive: true },
              include: { colorCode: true, sizeCode: true },
              orderBy: { sku: "asc" },
            },
          },
        },
        costSnapshot: true,
        minuteRatePeriod: { include: { fiscalPeriod: true } },
        materialIssues: { include: { material: { include: { uom: true } } } },
      },
      orderBy: [{ orderDate: "desc" }, { createdAt: "desc" }],
      take: 50,
    }),
    db.style.findMany({
      where: { isActive: true },
      include: { _count: { select: { bomLines: true, operations: true } } },
      orderBy: { code: "asc" },
    }),
    db.minuteRatePeriod.findMany({
      where: { entityId: factory.id },
      include: { fiscalPeriod: true },
      orderBy: { calculatedAt: "desc" },
      take: 12,
    }),
    db.location.findMany({
      where: { isActive: true, entityId: factory.id },
      orderBy: { sortOrder: "asc" },
    }),
  ]);

  const draft = orders.filter((o) => o.status === "DRAFT");
  const inFlight = orders.filter(
    (o) => o.status === "CONFIRMED" || o.status === "IN_PRODUCTION",
  );
  const completed = orders.filter((o) => o.status === "COMPLETED");

  // What each open order still needs, against what the warehouse holds.
  const openWork = await Promise.all(
    inFlight.map(async (o) => {
      const planned = await plannedMaterials(o.id);
      const stock = await db.inventoryLot.groupBy({
        by: ["materialId"],
        where: {
          materialId: { in: planned.map((p) => p.materialId) },
          entityId: factory.id,
          state: "RAW_MATERIAL",
          remainingQty: { gt: 0 },
        },
        _sum: { remainingQty: true },
      });

      const materials = await db.material.findMany({
        where: { id: { in: planned.map((p) => p.materialId) } },
        include: { uom: true },
      });

      return {
        order: o,
        materials: planned.map((p) => {
          const m = materials.find((x) => x.id === p.materialId);
          const issued = o.materialIssues
            .filter((i) => i.materialId === p.materialId)
            .reduce((s, i) => s.plus(dec(i.actualQty)), dec(0));
          return {
            id: p.materialId,
            code: p.materialCode,
            name: m ? (ar ? m.nameAr : m.nameEn) : p.materialCode,
            uom: m?.uom.code ?? "",
            planned: p.requiredQty.toFixed(2),
            issued: issued.toFixed(2),
            onHand: dec(
              stock.find((s) => s.materialId === p.materialId)?._sum.remainingQty ?? 0,
            ).toFixed(2),
          };
        }),
      };
    }),
  );

  const plannedInFlight = inFlight.reduce(
    (s, o) => s.plus(dec(o.plannedTotalCost ?? 0)), dec(0),
  );
  const unitsCompleted = completed.reduce((s, o) => s + (o.actualQty ?? 0), 0);

  const name = (e: { nameAr: string; nameEn: string }) => (ar ? e.nameAr : e.nameEn);
  const today = new Date().toISOString().slice(0, 10);

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

      {/* ------------------------------------------------------- raise one */}
      {mayCreate && (
        <Card className="mb-4" title={ar ? "أمر إنتاج جديد" : "New production order"}>
          {styles.length === 0 ? (
            <p className="py-4 text-sm text-ink-500">
              {ar
                ? "محتاج تعمل موديل الأول من صفحة الموديلات."
                : "Create a style first, from the styles page."}
            </p>
          ) : (
            <NewOrderForm
              locale={locale}
              today={today}
              styles={styles.map((s) => ({
                id: s.id,
                code: s.code,
                name: name(s),
                smv: s.totalSmvMinutes?.toString() ?? "0",
                hasBom: s._count.bomLines > 0 && s._count.operations > 0,
              }))}
            />
          )}
        </Card>
      )}

      {/* --------------------------------------- drafts waiting on a costing */}
      {mayConfirm &&
        draft.map((o) => (
          <Card
            key={o.id}
            className="mb-4"
            title={`${ar ? "أكّد" : "Confirm"} ${o.orderNumber}`}
            description={`${name(o.style)} · ${formatNumber(o.plannedQty, locale)} ${ar ? "قطعة" : "units"}`}
          >
            <ConfirmOrderForm
              locale={locale}
              productionOrderId={o.id}
              periods={periods.map((p) => ({
                id: p.id,
                label: `${p.fiscalPeriod.year}-${String(p.fiscalPeriod.month).padStart(2, "0")}`,
                rate: `${Number(p.actualMinuteRate).toFixed(4)} ${ar ? "ج/دقيقة" : "EGP/min"}`,
              }))}
            />
          </Card>
        ))}

      {/* ------------------------------- open runs: issue fabric, then close */}
      {mayRecord &&
        openWork.map(({ order: o, materials }) => (
          <Card
            key={o.id}
            className="mb-4"
            title={`${o.orderNumber} · ${name(o.style)}`}
            description={
              ar
                ? `${formatNumber(o.plannedQty, locale)} قطعة · تكلفة الوحدة المجمّدة ${formatMoney(o.costSnapshot?.factoryTotalCost ?? 0, locale)}`
                : `${formatNumber(o.plannedQty, locale)} units · frozen unit cost ${formatMoney(o.costSnapshot?.factoryTotalCost ?? 0, locale)}`
            }
          >
            <div className="space-y-5">
              <div>
                <p className="mb-2 text-xs font-medium text-ink-600">
                  {ar ? "صرف خامات" : "Issue material"}
                </p>
                {materials.length === 0 ? (
                  <p className="text-sm text-ink-400">
                    {ar ? "لا توجد خامات في المكونات." : "No materials on the bill."}
                  </p>
                ) : (
                  <IssueMaterialForm
                    locale={locale}
                    productionOrderId={o.id}
                    entityId={factory.id}
                    today={today}
                    locations={locations.map((l) => ({ id: l.id, label: name(l) }))}
                    materials={materials}
                  />
                )}
              </div>

              <div className="border-t border-ink-100 pt-4">
                <p className="mb-2 text-xs font-medium text-ink-600">
                  {ar ? "قفل الأمر" : "Close the run"}
                </p>
                {o.style.variants.length === 0 ? (
                  <p className="text-sm text-bad">
                    {ar
                      ? "الموديل ده مالوش أكواد مقاسات وألوان. ولّدها من صفحة الموديلات الأول."
                      : "This style has no SKUs. Generate them from the styles page first."}
                  </p>
                ) : (
                  <CompleteOrderForm
                    locale={locale}
                    productionOrderId={o.id}
                    entityId={factory.id}
                    plannedQty={o.plannedQty}
                    today={today}
                    locations={locations.map((l) => ({ id: l.id, label: name(l) }))}
                    variants={o.style.variants.map((v) => ({
                      id: v.id,
                      sku: v.sku,
                      label: `${ar ? v.colorCode.nameAr : v.colorCode.nameEn} · ${v.sizeCode.code}`,
                    }))}
                  />
                )}
              </div>
            </div>
          </Card>
        ))}

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
