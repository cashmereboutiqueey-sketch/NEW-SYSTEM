import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { capacityPicture } from "@/lib/factory-floor";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber, formatPercent, dec } from "@/lib/money";

/**
 * تخطيط الطاقة — what is committed against what exists, month by month.
 *
 * The useful reading is the free minutes at the bottom of each month, priced
 * at the idle penalty. That figure is what idle capacity costs whether or not
 * anybody sells it, and it is the number that makes external CMT strategic
 * rather than a sideline: every minute sold above the full-capacity floor
 * lowers the rate the Brand itself pays.
 */
export default async function CapacityPlanningPage() {
  await requirePermission("minute_rate:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });
  const periods = await capacityPicture(factory.id);

  const open = periods.filter((p) => p.status !== "LOCKED");
  const freeMinutes = open.reduce((s, p) => s.plus(p.freeMinutes), dec(0));
  const costOfIdle = open.reduce(
    (s, p) => s.plus(p.freeMinutes.times(p.idlePenaltyPerMinute)),
    dec(0),
  );

  return (
    <>
      <PageHeader
        title={ar ? "تخطيط الطاقة" : "Capacity planning"}
        subtitle={
          ar
            ? "المحجوز مقابل المتاح — الدقائق الفاضية بتتكلّف سواء اتباعت أو لأ"
            : "Committed against available — free minutes cost money whether or not they are sold"
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatTile
          label={ar ? "دقائق فاضية في الشهور المفتوحة" : "Free minutes, open months"}
          value={formatNumber(freeMinutes, locale)}
          tone={freeMinutes.greaterThan(0) ? "warn" : "good"}
        />
        <StatTile
          label={ar ? "تكلفتها لو فضلت فاضية" : "What that idleness costs"}
          value={formatMoney(costOfIdle, locale)}
          tone={costOfIdle.greaterThan(0) ? "bad" : "good"}
          hint={ar ? "بعبء الطاقة العاطلة" : "At the idle penalty"}
        />
        <StatTile
          label={ar ? "شهور مفتوحة" : "Open months"}
          value={formatNumber(open.length, locale)}
        />
      </div>

      <Card
        className="mb-4"
        title={ar ? "شهر بشهر" : "Month by month"}
        description={
          ar
            ? "الحجز محسوب على الدقائق المتاحة، مش على المنتجة — السؤال هنا: الأوامر مالية قد إيه من المصنع"
            : "Booked against available, not productive — the question is how full the order book actually makes the factory"
        }
      >
        {periods.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-400">
            {ar ? "لسه مفيش شهور محسوبة." : "No periods calculated yet."}
          </p>
        ) : (
          <DataTable
            headers={[
              ar ? "الشهر" : "Month",
              ar ? "الحالة" : "Status",
              ar ? "متاح" : "Available",
              ar ? "محجوز" : "Booked",
              ar ? "نسبة الامتلاء" : "Fill",
              ar ? "فاضي" : "Free",
              ar ? "تكلفة الفاضي" : "Cost of free",
            ]}
            rows={periods.map((p) => [
              <span key={`${p.id}-l`} className="num" dir="ltr">{p.label}</span>,
              <Badge key={`${p.id}-s`} tone={p.status === "LOCKED" ? "neutral" : "info"}>
                {p.status === "LOCKED" ? (ar ? "مقفول" : "Locked") : ar ? "مفتوح" : "Open"}
              </Badge>,
              <span key={`${p.id}-a`} className="num">{formatNumber(p.grossMinutes, locale)}</span>,
              <span key={`${p.id}-b`} className="num">{formatNumber(p.bookedMinutes, locale)}</span>,
              p.bookedShare == null ? (
                <span key={`${p.id}-f`} className="num text-ink-400">—</span>
              ) : (
                <span
                  key={`${p.id}-f`}
                  className={
                    p.bookedShare.greaterThan(0.85)
                      ? "num text-good"
                      : p.bookedShare.lessThan(0.5)
                        ? "num text-bad"
                        : "num text-warn"
                  }
                >
                  {formatPercent(p.bookedShare, locale)}
                </span>
              ),
              <span key={`${p.id}-r`} className="num">{formatNumber(p.freeMinutes, locale)}</span>,
              <span key={`${p.id}-c`} className="num text-ink-500">
                {formatMoney(p.freeMinutes.times(p.idlePenaltyPerMinute), locale)}
              </span>,
            ])}
          />
        )}
      </Card>

      <Card title={ar ? "ليه ده مهم" : "Why this matters"}>
        <p className="text-sm text-ink-600">
          {ar ? (
            <>
              الدقيقة الفاضية بتتكلّف سواء اتشتغلت أو لأ — الإيجار والرواتب والإهلاك بيمشوا زي ما هم.
              وعشان إيراد التصنيع للغير بيتخصم من مجمّع تكلفة المصنع، كل دقيقة تتباع فوق سعر كامل
              الطاقة بتنزّل تكلفة الدقيقة اللي البراند نفسه بيدفعها. يعني التصنيع للغير مش شغل جانبي —
              ده أقوى أداة عندك على هامش البراند.
            </>
          ) : (
            <>
              An idle minute costs the same as a busy one — rent, wages and
              depreciation carry on regardless. And because external CMT revenue
              is credited against the factory cost pool, every minute sold above
              the full-capacity floor directly lowers the rate the Brand itself
              pays. External work is not a sideline; it is the strongest lever
              you have on the Brand&apos;s own margin.
            </>
          )}
        </p>
      </Card>
    </>
  );
}
