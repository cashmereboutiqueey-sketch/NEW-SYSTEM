import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { can } from "@/core/permissions";
import { capacityPicture } from "@/lib/factory-floor";
import { configurablePeriods } from "@/lib/capacity";
import { CapacityForm } from "./capacity-form";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber, formatPercent, dec } from "@/lib/money";

/**
 * الطاقة الإنتاجية — how many minutes the factory has, and what they cost.
 *
 * Utilisation and efficiency are shown apart because they are different
 * diseases. Utilisation is the share of available minutes with work booked
 * against them, and low utilisation is a sales problem. Efficiency is what the
 * line does with the hours it is paid for, and low efficiency is a floor
 * problem. Multiplying them into one "productivity" number hides which.
 */
export default async function CapacityPage() {
  const session = await requirePermission("minute_rate:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const maySet = can(session.role, "minute_rate:calculate");

  const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });
  const [periods, configurable] = await Promise.all([
    capacityPicture(factory.id),
    configurablePeriods(factory.id),
  ]);
  const current = periods[0];

  // What the page shows is a copy taken when the minute rate was last
  // calculated, not the capacity as it stands. Freezing it is right — a rate
  // whose inputs move underneath it explains nothing later — but it means the
  // page where capacity is edited can go on showing figures from weeks ago,
  // saying nothing, while the operator wonders whether the save worked.
  const live = current ? configurable.find((c) => c.label === current.label) : undefined;
  const stale =
    !!live &&
    live.operators !== null &&
    (live.operators !== current.operators ||
      !live.workingDays?.equals(current.workingDays) ||
      !live.hoursPerDay?.equals(current.hoursPerDay) ||
      !live.utilisationRate?.equals(current.utilisationRate) ||
      !live.efficiencyRate?.equals(current.efficiencyRate));

  return (
    <>
      <PageHeader
        title={ar ? "الطاقة الإنتاجية" : "Capacity"}
        subtitle={
          ar
            ? "الدقائق المتاحة والمحجوزة والعاطلة — نسبة التشغيل مشكلة مبيعات، والكفاءة مشكلة صالة"
            : "Minutes available, booked and idle — utilisation is a sales problem, efficiency is a floor problem"
        }
      />

      {maySet && (
        <Card
          className="mb-4"
          title={ar ? "إعداد الطاقة" : "Set the capacity"}
          description={
            ar
              ? "الأرقام دي هي أساس تكلفة الدقيقة، يعني أساس سعر كل قطعة — أي تغيير فيها بيتسجّل"
              : "These five numbers decide the minute rate and therefore every garment's price — each change is recorded"
          }
        >
          <CapacityForm
            locale={locale}
            entityId={factory.id}
            periods={configurable.map((p) => ({
              fiscalPeriodId: p.fiscalPeriodId,
              label: p.label,
              editable: p.editable,
              operators: p.operators,
              workingDays: p.workingDays?.toString() ?? null,
              hoursPerDay: p.hoursPerDay?.toString() ?? null,
              utilisationRate: p.utilisationRate?.toString() ?? null,
              efficiencyRate: p.efficiencyRate?.toString() ?? null,
            }))}
          />
        </Card>
      )}

      {!current ? (
        <Card>
          <p className="py-8 text-center text-sm text-ink-400">
            {ar
              ? "لسه مفيش تكلفة دقيقة محسوبة. احسبها من صفحة تكلفة الدقيقة الأول."
              : "No minute rate has been calculated yet. Work one out from the minute-rate screen first."}
          </p>
        </Card>
      ) : (
        <>
          {stale && live && (
            <Card
              className="mb-4 border-warn"
              title={ar ? "الأرقام تحت قديمة" : "The figures below are out of date"}
              description={
                ar
                  ? "حفظت طاقة جديدة، بس تكلفة الدقيقة لسه محسوبة على القديمة. الصفحة بتوري اللي التكلفة اتبنت عليه."
                  : "You have saved a new capacity, but the minute rate is still calculated on the old one. This page shows what the rate was built on."
              }
            >
              <DataTable
                headers={[
                  ar ? "البند" : "",
                  ar ? "المحفوظ دلوقتي" : "Saved now",
                  ar ? "المحسوب عليه" : "The rate was built on",
                ]}
                rows={[
                  [
                    <span key="o">{ar ? "عمال" : "Operators"}</span>,
                    <span key="on" className="num font-medium">{live.operators}</span>,
                    <span key="oo" className="num text-ink-500">{current.operators}</span>,
                  ],
                  [
                    <span key="d">{ar ? "أيام شغل" : "Working days"}</span>,
                    <span key="dn" className="num font-medium">{formatNumber(live.workingDays!, locale)}</span>,
                    <span key="do" className="num text-ink-500">{formatNumber(current.workingDays, locale)}</span>,
                  ],
                  [
                    <span key="h">{ar ? "ساعات باليوم" : "Hours per day"}</span>,
                    <span key="hn" className="num font-medium">{formatNumber(live.hoursPerDay!, locale)}</span>,
                    <span key="ho" className="num text-ink-500">{formatNumber(current.hoursPerDay, locale)}</span>,
                  ],
                  [
                    <span key="u">{ar ? "نسبة التشغيل" : "Utilisation"}</span>,
                    <span key="un" className="num font-medium">{formatPercent(live.utilisationRate!, locale)}</span>,
                    <span key="uo" className="num text-ink-500">{formatPercent(current.utilisationRate, locale)}</span>,
                  ],
                  [
                    <span key="e">{ar ? "الكفاءة" : "Efficiency"}</span>,
                    <span key="en" className="num font-medium">{formatPercent(live.efficiencyRate!, locale)}</span>,
                    <span key="eo" className="num text-ink-500">{formatPercent(current.efficiencyRate, locale)}</span>,
                  ],
                ]}
              />
              <p className="mt-3 text-sm text-ink-600">
                {ar
                  ? "احسب تكلفة الدقيقة تاني من /minute-rate عشان الأرقام دي تتطبق على التسعير."
                  : "Recalculate the minute rate at /minute-rate for these to reach your pricing."}
              </p>
            </Card>
          )}

          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label={ar ? "دقائق متاحة" : "Available minutes"}
              value={formatNumber(current.grossMinutes, locale)}
              hint={`${current.operators} ${ar ? "عامل" : "operators"} · ${formatNumber(current.workingDays, locale)} ${ar ? "يوم" : "days"}`}
            />
            <StatTile
              label={ar ? "محجوزة بأوامر" : "Booked with work"}
              value={formatNumber(current.bookedMinutes, locale)}
              tone={
                current.bookedShare && current.bookedShare.greaterThan(0.8)
                  ? "good"
                  : "warn"
              }
              hint={
                current.bookedShare
                  ? `${formatPercent(current.bookedShare, locale)} ${ar ? "من الطاقة" : "of capacity"}`
                  : undefined
              }
            />
            <StatTile
              label={ar ? "دقائق عاطلة" : "Idle minutes"}
              value={formatNumber(current.idleMinutes, locale)}
              tone={current.idleMinutes.greaterThan(0) ? "bad" : "good"}
            />
            <StatTile
              label={ar ? "عبء الدقيقة العاطلة" : "Idle penalty"}
              value={`${formatNumber(current.idlePenaltyPerMinute.toDecimalPlaces(4), locale)} ${ar ? "ج/د" : "EGP/min"}`}
              hint={ar ? "الفرق بين الفعلي وكامل الطاقة" : "Actual less full-capacity rate"}
            />
          </div>

          <Card
            className="mb-4"
            title={ar ? "الشهر الحالي" : "This month"}
            description={
              ar
                ? "نسبة التشغيل والكفاءة منفصلين عن قصد — كل واحدة ليها علاج مختلف"
                : "Utilisation and efficiency are kept apart on purpose — each has a different cure"
            }
          >
            <DataTable
              headers={[ar ? "البند" : "Measure", ar ? "القيمة" : "Value", ar ? "يعني إيه" : "Meaning"]}
              rows={[
                [
                  <span key="u">{ar ? "نسبة التشغيل المخططة" : "Utilisation, planned"}</span>,
                  <span key="uv" className="num">{formatPercent(current.utilisationRate, locale)}</span>,
                  <span key="um" className="text-xs text-ink-500">
                    {ar
                      ? "رقم إنت كتبته وبيتقسم عليه المصاريف — مش قياس"
                      : "A number you typed, and what the costs are spread over — not a measurement"}
                  </span>,
                ],
                [
                  <span key="ua">{ar ? "المحجوز فعلاً" : "Utilisation, actual"}</span>,
                  <span
                    key="uav"
                    className={`num ${
                      current.bookedShare && current.bookedShare.lessThan(current.utilisationRate.times("0.5"))
                        ? "font-medium text-bad"
                        : ""
                    }`}
                  >
                    {current.bookedShare ? formatPercent(current.bookedShare, locale) : "—"}
                  </span>,
                  <span key="uam" className="text-xs text-ink-500">
                    {ar
                      ? "الدقائق اللي عليها أوامر بجد. لو أقل بكتير من المخططة، كل قطعة تكلفتها أقل من الحقيقة"
                      : "Minutes with real orders against them. Far below the planned figure means every garment is costed cheaper than it truly is"}
                  </span>,
                ],
                [
                  <span key="e">{ar ? "الكفاءة المخططة" : "Efficiency, planned"}</span>,
                  <span key="ev" className="num">{formatPercent(current.efficiencyRate, locale)}</span>,
                  <span key="em" className="text-xs text-ink-500">
                    {ar
                      ? "كمان رقم مكتوب. الكفاءة الحقيقية بتتحسب من ورديات الصالة في /production"
                      : "Also typed. What the floor really earns is measured from shift logs in /production"}
                  </span>,
                ],
                [
                  <span key="p">{ar ? "دقائق منتجة" : "Productive minutes"}</span>,
                  <span key="pv" className="num">{formatNumber(current.productiveMinutes, locale)}</span>,
                  <span key="pm" className="text-xs text-ink-500">
                    {ar ? "متاحة × تشغيل × كفاءة" : "Available × utilisation × efficiency"}
                  </span>,
                ],
                [
                  <span key="a">{ar ? "تكلفة الدقيقة الفعلية" : "Actual minute rate"}</span>,
                  <span key="av" className="num font-medium">
                    {formatNumber(current.actualMinuteRate.toDecimalPlaces(4), locale)}
                  </span>,
                  <span key="am" className="text-xs text-ink-500">
                    {ar ? "اللي البراند بيدفعه دلوقتي" : "What the Brand pays today"}
                  </span>,
                ],
                [
                  <span key="f">{ar ? "عند كامل الطاقة" : "At full capacity"}</span>,
                  <span key="fv" className="num font-medium text-good">
                    {formatNumber(current.fullCapacityMinuteRate.toDecimalPlaces(4), locale)}
                  </span>,
                  <span key="fm" className="text-xs text-ink-500">
                    {ar ? "الحد الأدنى لتسعير التصنيع للغير" : "The floor for quoting external CMT"}
                  </span>,
                ],
              ]}
            />
          </Card>

          <Card
            className="mb-4"
            title={ar ? "الحجوزات" : "What is booked"}
            description={
              ar
                ? `متبقي ${formatNumber(current.freeMinutes, locale)} دقيقة فاضية`
                : `${formatNumber(current.freeMinutes, locale)} minutes still free`
            }
          >
            {current.bookings.length === 0 ? (
              <p className="py-8 text-center text-sm text-ink-400">
                {ar
                  ? "مفيش أوامر محجوزة على الشهر ده — الطاقة كلها عاطلة."
                  : "Nothing is booked against this month — the whole factory is idle."}
              </p>
            ) : (
              <DataTable
                headers={[ar ? "المصدر" : "Source", ar ? "الأمر" : "Order", ar ? "دقائق" : "Minutes"]}
                rows={current.bookings.map((b) => [
                  <Badge key={`${b.id}-s`} tone={b.source === "CMT_ORDER" ? "info" : "neutral"}>
                    {b.source === "CMT_ORDER"
                      ? ar ? "تصنيع للغير" : "External CMT"
                      : ar ? "إنتاج البراند" : "Brand production"}
                  </Badge>,
                  <span key={`${b.id}-l`}>{ar ? b.labelAr : b.labelEn}</span>,
                  <span key={`${b.id}-m`} className="num">{formatNumber(b.minutes, locale)}</span>,
                ])}
              />
            )}
          </Card>

          <Card title={ar ? "الشهور السابقة" : "Previous months"}>
            <DataTable
              headers={[
                ar ? "الشهر" : "Month",
                ar ? "الحالة" : "Status",
                ar ? "متاح" : "Available",
                ar ? "محجوز" : "Booked",
                ar ? "عاطل" : "Idle",
                ar ? "تكلفة الدقيقة" : "Minute rate",
                ar ? "مجمّع التكلفة" : "Cost pool",
              ]}
              rows={periods.map((p) => [
                <span key={`${p.id}-l`} className="num" dir="ltr">{p.label}</span>,
                <Badge key={`${p.id}-s`} tone={p.status === "LOCKED" ? "good" : "warn"}>
                  {p.status === "LOCKED" ? (ar ? "مقفول" : "Locked") : ar ? "مبدئي" : "Provisional"}
                </Badge>,
                <span key={`${p.id}-a`} className="num">{formatNumber(p.grossMinutes, locale)}</span>,
                <span key={`${p.id}-b`} className="num">{formatNumber(p.bookedMinutes, locale)}</span>,
                <span
                  key={`${p.id}-i`}
                  className={p.idleMinutes.greaterThan(0) ? "num text-bad" : "num"}
                >
                  {formatNumber(p.idleMinutes, locale)}
                </span>,
                <span key={`${p.id}-r`} className="num">
                  {formatNumber(p.actualMinuteRate.toDecimalPlaces(4), locale)}
                </span>,
                <span key={`${p.id}-c`} className="num text-ink-500">
                  {formatMoney(p.costPool, locale)}
                </span>,
              ])}
            />
          </Card>
        </>
      )}
    </>
  );
}
