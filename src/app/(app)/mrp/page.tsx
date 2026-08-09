import Link from "next/link";
import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber, formatPercent } from "@/lib/money";
import { materialRequirements, capacityOutlook } from "@/lib/mrp";

/**
 * تخطيط الاحتياجات — MRP.
 *
 * Answers one question honestly: for the production already committed to,
 * what is short and when does it need ordering? Suggestions are never
 * commitments — nothing here raises a purchase order.
 */
export default async function MrpPage({
  searchParams,
}: {
  searchParams: Promise<{ drafts?: string }>;
}) {
  await requirePermission("production:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const params = await searchParams;
  const includeDrafts = params.drafts === "1";

  const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });
  const period = await db.fiscalPeriod.findFirst({
    where: { status: "OPEN" },
    orderBy: { startDate: "asc" },
  });

  const [plan, capacity] = await Promise.all([
    materialRequirements({ includeDrafts }),
    period ? capacityOutlook(factory.id, period.id) : Promise.resolve(null),
  ]);

  const urgencyTone: Record<string, "bad" | "warn" | "neutral"> = {
    OVERDUE: "bad", URGENT: "warn", PLANNED: "neutral",
  };
  const urgencyLabel: Record<string, string> = ar
    ? { OVERDUE: "فات موعده", URGENT: "عاجل", PLANNED: "مخطط" }
    : { OVERDUE: "Overdue", URGENT: "Urgent", PLANNED: "Planned" };

  const overdue = plan.suggestions.filter((s) => s.urgency === "OVERDUE").length;

  return (
    <>
      <PageHeader
        title={ar ? "تخطيط الاحتياجات" : "Material requirements"}
        subtitle={
          ar
            ? "الاقتراح مش التزام — مفيش حاجة هنا بتعمل أمر شراء لوحدها"
            : "A suggestion is not a commitment — nothing here raises a purchase order on its own"
        }
        actions={
          <Link
            href={includeDrafts ? "/mrp" : "/mrp?drafts=1"}
            className="rounded-lg border border-ink-300 px-3 py-1.5 text-sm text-ink-700"
          >
            {includeDrafts
              ? ar ? "المؤكد فقط" : "Committed only"
              : ar ? "أضف المسودات" : "Include drafts"}
          </Link>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <StatTile
          label={ar ? "خامات ناقصة" : "Materials short"}
          value={formatNumber(plan.suggestions.length, locale)}
          tone={plan.suggestions.length > 0 ? "warn" : "good"}
        />
        <StatTile
          label={ar ? "فات موعد طلبها" : "Already overdue"}
          value={formatNumber(overdue, locale)}
          tone={overdue > 0 ? "bad" : "good"}
          hint={ar ? "مدة التوريد أطول من الوقت المتبقي" : "Lead time exceeds the time left"}
        />
        <StatTile
          label={ar ? "الإنفاق المقترح" : "Suggested spend"}
          value={formatMoney(plan.estimatedSpend, locale)}
        />
        <StatTile
          label={ar ? "أوامر إنتاج محسوبة" : "Orders considered"}
          value={formatNumber(plan.ordersConsidered, locale)}
          hint={includeDrafts ? (ar ? "شامل المسودات" : "Drafts included") : (ar ? "المؤكد فقط" : "Committed only")}
        />
      </div>

      {capacity && (
        <Card
          className="mb-4"
          title={ar ? "الطاقة المتاحة" : "Capacity outlook"}
          description={
            ar
              ? "بالدقائق المنتجة، مش دقائق الساعة — المصنع مش فاضي بالكامل"
              : "Measured in productive minutes, not clock minutes — the factory is not fully available"
          }
        >
          <div className="grid gap-3 sm:grid-cols-4">
            <div>
              <div className="text-xs text-ink-500">{ar ? "دقائق منتجة" : "Productive"}</div>
              <div className="num text-lg font-semibold">
                {formatNumber(capacity.minutesAvailable, locale)}
              </div>
              <div className="mt-0.5 text-xs text-ink-400">
                {ar ? "من" : "of"} {formatNumber(capacity.grossAvailableMinutes, locale)}{" "}
                · {formatPercent(capacity.utilisationRate, locale)} ×{" "}
                {formatPercent(capacity.efficiencyRate, locale)}
              </div>
            </div>
            <div>
              <div className="text-xs text-ink-500">{ar ? "محجوز" : "Booked"}</div>
              <div className="num text-lg font-semibold">
                {formatNumber(capacity.minutesBooked, locale)}
              </div>
            </div>
            <div>
              <div className="text-xs text-ink-500">{ar ? "متبقٍ" : "Free"}</div>
              <div
                className={
                  "num text-lg font-semibold " +
                  (capacity.minutesFree.greaterThan(0) ? "text-good" : "text-bad")
                }
              >
                {formatNumber(capacity.minutesFree, locale)}
              </div>
            </div>
            <div>
              <div className="text-xs text-ink-500">
                {ar ? "مطلوب للمسودات" : "Needed by drafts"}
              </div>
              <div className="num text-lg font-semibold">
                {formatNumber(capacity.minutesRequired, locale)}
              </div>
              <div className="mt-0.5 text-xs text-ink-400">
                {capacity.draftOrders} {ar ? "أمر مسودة" : "draft orders"}
              </div>
            </div>
          </div>

          {!capacity.fits && capacity.minutesRequired.greaterThan(0) && (
            <p className="mt-3 rounded-lg bg-bad/10 px-3 py-2 text-sm text-bad">
              {ar
                ? `المسودات محتاجة ${formatNumber(capacity.shortfallMinutes, locale)} دقيقة أكتر من المتاح. إما تأجيل، أو وقت إضافي، أو تقسيم على شهرين.`
                : `The drafts need ${formatNumber(capacity.shortfallMinutes, locale)} more minutes than are free. Either defer, add overtime, or split across two months.`}
            </p>
          )}
        </Card>
      )}

      <Card
        className="mb-4"
        title={ar ? "المقترح شراؤه" : "Suggested purchases"}
        description={
          ar
            ? "النقص = المطلوب + حد الأمان − الموجود − تحت الطلب. لو المطلوب صفر والاقتراح مش صفر، يبقى حد الأمان هو السبب."
            : "Short = required + safety stock, less what is on hand and already on order. A suggestion against zero demand is the safety stock talking."
        }
      >
        {plan.suggestions.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-400">
            {ar
              ? "المخزون يغطي كل الأوامر المؤكدة — مفيش حاجة محتاجة شراء."
              : "Stock covers every committed order — nothing needs buying."}
          </p>
        ) : (
          <DataTable
            headers={[
              ar ? "الخامة" : "Material",
              ar ? "المورد" : "Supplier",
              ar ? "مطلوب" : "Required",
              ar ? "حد الأمان" : "Safety",
              ar ? "موجود" : "On hand",
              ar ? "تحت الطلب" : "On order",
              ar ? "النقص" : "Short",
              ar ? "اشترِ" : "Buy",
              ar ? "التكلفة" : "Cost",
              ar ? "اطلب قبل" : "Order by",
              "",
            ]}
            rows={plan.suggestions.map((s) => [
              <span key={`${s.materialId}-m`}>
                <code dir="ltr" className="text-xs text-ink-500">{s.materialCode}</code>
                <span className="ms-2">{ar ? s.materialNameAr : s.materialNameEn}</span>
              </span>,
              <span key={`${s.materialId}-sup`} className="text-sm text-ink-600">
                {s.supplier ? (ar ? s.supplier.ar : s.supplier.en) : "—"}
              </span>,
              <span key={`${s.materialId}-r`} className="num">
                {formatNumber(s.required, locale)}
              </span>,
              <span key={`${s.materialId}-sf`} className="num text-ink-500">
                {formatNumber(s.safetyStock, locale)}
              </span>,
              <span key={`${s.materialId}-h`} className="num">
                {formatNumber(s.onHand, locale)}
              </span>,
              <span key={`${s.materialId}-o`} className="num text-ink-500">
                {formatNumber(s.onOrder, locale)}
              </span>,
              <span key={`${s.materialId}-sh`} className="num text-bad">
                {formatNumber(s.shortfall, locale)}
              </span>,
              <span key={`${s.materialId}-b`} className="num font-semibold">
                {formatNumber(s.suggestedQty, locale)} {s.uom}
                {s.roundedUpBecause && (
                  <span className="mt-0.5 block text-xs font-normal text-warn">
                    {s.roundedUpBecause === "MOQ"
                      ? ar ? "رُفع للحد الأدنى" : "raised to minimum"
                      : ar ? "قُرِّب لعبوة كاملة" : "rounded to a full pack"}
                  </span>
                )}
              </span>,
              <span key={`${s.materialId}-c`} className="num">
                {formatMoney(s.estimatedCost, locale)}
              </span>,
              <span key={`${s.materialId}-d`} className="num" dir="ltr">
                {s.orderBy?.toISOString().slice(0, 10) ?? "—"}
                <span className="mt-0.5 block text-xs text-ink-400">
                  {s.leadTimeDays} {ar ? "يوم توريد" : "d lead"}
                </span>
              </span>,
              <Badge key={`${s.materialId}-u`} tone={urgencyTone[s.urgency]}>
                {urgencyLabel[s.urgency]}
              </Badge>,
            ])}
          />
        )}

        {plan.suggestions.length > 0 && (
          <p className="mt-3 text-xs text-ink-500">
            {ar
              ? "الأرقام دي مبنية على أوامر الإنتاج المؤكدة وما تم صرفه فعلًا — راجعها وبعدين اعمل أمر الشراء من صفحة المشتريات."
              : "These figures come from confirmed production orders and what has already been issued — review them, then raise the order from the purchasing screen."}
          </p>
        )}
      </Card>

      {plan.lowStock.length > 0 && (
        <Card
          title={ar ? "تحت حد إعادة الطلب" : "Below the reorder point"}
          description={
            ar
              ? "بغض النظر عن أوامر الإنتاج — دي مستويات المخزون نفسها"
              : "Regardless of production orders — this is the stock level itself"
          }
        >
          <DataTable
            headers={[
              ar ? "الخامة" : "Material",
              ar ? "الموجود" : "On hand",
              ar ? "حد إعادة الطلب" : "Reorder point",
            ]}
            rows={plan.lowStock.map((l) => [
              <code key={`${l.materialId}-c`} dir="ltr" className="text-xs">{l.materialCode}</code>,
              <span key={`${l.materialId}-h`} className="num text-bad">
                {formatNumber(l.onHand, locale)}
              </span>,
              <span key={`${l.materialId}-r`} className="num">
                {formatNumber(l.reorderPoint, locale)}
              </span>,
            ])}
          />
        </Card>
      )}
    </>
  );
}
