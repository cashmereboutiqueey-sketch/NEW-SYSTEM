import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { cashCycle } from "@/lib/analytics";
import { PageHeader, Card, DataTable, StatTile } from "@/components/ui";
import { formatMoney, formatNumber, dec } from "@/lib/money";

/**
 * دورة الكاش — the days between paying for fabric and being paid for the garment.
 *
 * This is the number that explains "profitable on paper, no cash in hand". A
 * business can grow its way into insolvency on a long positive cycle, because
 * every extra sale consumes cash months before it returns any.
 *
 * Every leg here is measured, not assumed: stock days from what is on hand
 * against the cost running through it, collection days from payments still
 * pending, supplier credit weighted by what is actually owed to each supplier.
 */
export default async function CashCyclePage({
  searchParams,
}: {
  searchParams: Promise<{ entity?: string }>;
}) {
  await requirePermission("journal:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const query = await searchParams;

  const kind = query.entity === "FACTORY" ? "FACTORY" : "BRAND";
  const entity = await db.entity.findFirstOrThrow({ where: { kind } });
  const cycle = await cashCycle(entity.id);

  const days = cycle.cashConversionDays;
  const positive = days.greaterThan(0);

  const legs = [
    {
      key: "raw",
      labelAr: "الخامات في المخزن",
      labelEn: "Fabric in the store",
      days: cycle.legs.rawMaterialDays,
      value: cycle.values.raw,
      sign: 1,
    },
    {
      key: "wip",
      labelAr: "تحت التشغيل",
      labelEn: "Work in progress",
      days: cycle.legs.productionLeadDays,
      value: cycle.values.wip,
      sign: 1,
    },
    {
      key: "fg",
      labelAr: "بضاعة تامة على الرف",
      labelEn: "Finished goods on the shelf",
      days: cycle.legs.finishedGoodsDays,
      value: cycle.values.finished,
      sign: 1,
    },
    {
      key: "collect",
      labelAr: "تحصيل من العملاء",
      labelEn: "Waiting to be paid",
      days: cycle.legs.collectionDays,
      value: cycle.values.uncollected,
      sign: 1,
    },
    {
      key: "credit",
      labelAr: "ائتمان الموردين",
      labelEn: "Supplier credit",
      days: cycle.legs.supplierCreditDays,
      value: cycle.values.owedToSuppliers,
      sign: -1,
    },
  ];

  return (
    <>
      <PageHeader
        title={ar ? "دورة الكاش" : "Cash conversion cycle"}
        subtitle={
          ar
            ? `${ar ? cycle.entityName.ar : cycle.entityName.en} — الأيام من دفع ثمن القماش لحد تحصيل ثمن القطعة`
            : `${cycle.entityName.en} — days from paying for fabric to being paid for the garment`
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatTile
          label={ar ? "طول الدورة" : "Cycle length"}
          value={`${formatNumber(days.toDecimalPlaces(0), locale)} ${ar ? "يوم" : "days"}`}
          tone={positive ? (days.greaterThan(90) ? "bad" : "warn") : "good"}
        />
        <StatTile
          label={ar ? "رأس مال محبوس" : "Working capital locked"}
          value={formatMoney(cycle.workingCapitalLocked, locale)}
          hint={ar ? "بتكلفة البضاعة" : "At cost of goods"}
        />
        <StatTile
          label={ar ? "الموردين بيموّلوا" : "Funded by suppliers"}
          value={formatMoney(cycle.supplierFunded, locale)}
          tone="good"
        />
      </div>

      <Card
        className="mb-4"
        title={ar ? "من فين جت الأيام" : "Where the days come from"}
        description={
          ar
            ? "كل رقم محسوب من السجلات نفسها، مش مفترض"
            : "Each leg is measured from the records, not assumed"
        }
      >
        <DataTable
          headers={[
            ar ? "المرحلة" : "Stage",
            ar ? "الأيام" : "Days",
            ar ? "القيمة" : "Value",
          ]}
          rows={[
            ...legs.map((leg) => [
              <span key={`${leg.key}-l`}>
                {leg.sign < 0 && <span className="text-good">− </span>}
                {ar ? leg.labelAr : leg.labelEn}
              </span>,
              <span
                key={`${leg.key}-d`}
                className={leg.sign < 0 ? "num text-good" : "num"}
              >
                {leg.sign < 0 ? "−" : ""}
                {formatNumber(leg.days.toDecimalPlaces(1), locale)}
              </span>,
              <span key={`${leg.key}-v`} className="num text-ink-500">
                {formatMoney(leg.value, locale)}
              </span>,
            ]),
            [
              <span key="t-l" className="font-semibold">
                {ar ? "الإجمالي" : "Cycle"}
              </span>,
              <span key="t-d" className="num font-semibold">
                {formatNumber(days.toDecimalPlaces(1), locale)}
              </span>,
              <span key="t-v" className="num font-semibold">
                {formatMoney(cycle.workingCapitalLocked, locale)}
              </span>,
            ],
          ]}
        />
      </Card>

      <Card title={ar ? "يعني إيه" : "What it means"}>
        <p className="text-sm text-ink-600">
          {positive ? (
            ar ? (
              <>
                الدورة موجبة بـ{" "}
                <span className="num">{formatNumber(days.toDecimalPlaces(0), locale)}</span> يوم،
                يعني كل جنيه مبيعات إضافي بياكل كاش قبل ما يرجّع. النمو هنا محتاج تمويل،
                مش بس طلبات. أقصر طريق لتقليل الرقم: تفاوض على ائتمان أطول من الموردين، أو
                قلّل البضاعة الراكدة على الرف.
              </>
            ) : (
              <>
                The cycle is <span className="num">{formatNumber(days.toDecimalPlaces(0), locale)}</span>{" "}
                days long, so every extra pound of sales consumes cash before it
                returns any. Growth here needs funding, not just orders. The
                shortest levers are longer supplier terms and less stock sitting
                on the shelf.
              </>
            )
          ) : ar ? (
            "الدورة سالبة — الموردين بيموّلوا الشغل بالكامل، وكل مبيعات إضافية بتجيب كاش قبل ما تدفع تكلفتها."
          ) : (
            "The cycle is negative — suppliers fund the business outright, and every extra sale brings cash in before its cost goes out."
          )}
        </p>
        <p className="mt-3 text-xs text-ink-400">
          {ar
            ? `الحساب على متوسط تكلفة مبيعات شهرية ${formatMoney(cycle.monthlyCogs, locale)}، من ${cycle.monthsOfTrading} شهر بيع فعلي.`
            : `Worked out on ${formatMoney(cycle.monthlyCogs, locale)} of monthly cost of sales, from ${cycle.monthsOfTrading} month(s) of actual trading.`}
        </p>
        {cycle.legs.finishedGoodsDays.greaterThan(180) && (
          <p className="mt-2 text-xs text-warn">
            {ar
              ? "أيام البضاعة التامة عالية جدًا — الإنتاج أكبر بكتير من البيع، فالرقم ده بيعكس مخزون مكدّس أكتر من دورة تشغيل."
              : "Finished-goods days are very high — far more has been made than sold, so this figure reflects a stock pile more than a trading cycle."}
          </p>
        )}
      </Card>
    </>
  );
}
