import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { can } from "@/core/permissions";
import { operatorProductivity, loggableOperators } from "@/lib/operators";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatNumber, formatPercent, formatMinutes } from "@/lib/money";
import { ProductivityForm } from "./productivity-form";

/**
 * إنتاجية العامل — what one person produced against the time they were paid for.
 *
 * Deliberately not derived from the line's shift log. A shift records a line, a
 * stage and a headcount; splitting its minutes across the people on the line
 * would hand every one of them the same efficiency, which is exactly the thing
 * this exists to tell apart.
 *
 * Half of it is measured: clocked minutes come from the biometric attendance
 * already recorded, so nobody decides afterwards how long somebody was on the
 * floor. What is entered is what they made, because only the supervisor
 * counting the bundles knows that.
 */
export default async function OperatorsPage() {
  const session = await requirePermission("production:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const [report, operators] = await Promise.all([
    operatorProductivity(),
    loggableOperators(),
  ]);
  const mayRecord = can(session.role, "production:create");

  const tone = (rate: { toString(): string } | null) => {
    if (!rate) return "neutral" as const;
    const v = Number(rate);
    return v >= 0.85 ? ("good" as const) : v >= 0.6 ? ("warn" as const) : ("bad" as const);
  };

  const day = (d: Date) => new Date(d).toISOString().slice(0, 10);
  const unlinked = operators.filter((o) => !o.hasEmployee).length;

  return (
    <>
      <PageHeader
        title={ar ? "إنتاجية العامل" : "Operator productivity"}
        subtitle={
          ar
            ? "الدقايق اللي أنتجها على الدقايق اللي اتدفعت له — آخر ٩٠ يوم"
            : "Standard minutes produced over minutes paid for — the last 90 days"
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <StatTile
          label={ar ? "متوسط الكفاءة" : "Average efficiency"}
          value={report.totals.efficiency ? formatPercent(report.totals.efficiency.toString()) : "—"}
          hint={ar ? "موزون بالدقايق مش بالأيام" : "weighted by minutes, not by days"}
          tone={tone(report.totals.efficiency)}
        />
        <StatTile
          label={ar ? "عمّال متسجّلين" : "Operators logged"}
          value={formatNumber(report.totals.operators)}
          hint={`${formatNumber(report.totals.days)} ${ar ? "يوم شغل" : "operator-days"}`}
        />
        <StatTile
          label={ar ? "دقايق أنتجوها" : "Minutes produced"}
          value={formatMinutes(report.totals.smvProduced.toString())}
        />
        <StatTile
          label={ar ? "دقايق اتدفعت" : "Minutes paid for"}
          value={formatMinutes(report.totals.clockedMinutes.toString())}
        />
      </div>

      {mayRecord && (
        <div className="mb-5">
          <Card
            title={ar ? "سجّل يوم" : "Record a day"}
            description={
              ar
                ? "الدقايق المدفوعة بتيجي من البصمة، فمحدش بيقرر بعدين العامل قعد قد إيه."
                : "Clocked minutes come from the biometric attendance, so nobody decides afterwards how long somebody was there."
            }
          >
            <ProductivityForm ar={ar} operators={operators} />
            {unlinked > 0 && (
              <p className="mt-3 text-xs text-ink-400">
                {ar
                  ? `${unlinked} عامل لسه مش مربوطين بملفات موظفين، فدقايقهم بتتكتب بإيد.`
                  : `${unlinked} operator(s) have no HR record, so their minutes have to be typed.`}
              </p>
            )}
          </Card>
        </div>
      )}

      {report.operators.length === 0 ? (
        <Card>
          <p className="py-8 text-center text-sm text-ink-400">
            {ar
              ? "لسه مفيش إنتاجية مسجّلة."
              : "No productivity has been recorded yet."}
          </p>
        </Card>
      ) : (
        <>
          <div className="mb-5">
            <Card
              title={ar ? "بالعامل" : "By operator"}
              description={
                ar
                  ? "«أحسن» و«أسوأ» يوم جنب المتوسط: اللي عدّى ٩٥٪ يومين مش زي اللي حافظ عليها عشرين."
                  : "Best and worst day beside the average: 95% for two days is not the same claim as holding it for twenty."
              }
            >
              <DataTable
                headers={[
                  ar ? "العامل" : "Operator",
                  ar ? "الخط" : "Line",
                  ar ? "أيام" : "Days",
                  ar ? "أنتج" : "Produced",
                  ar ? "اتدفع" : "Paid for",
                  ar ? "الكفاءة" : "Efficiency",
                  ar ? "أحسن يوم" : "Best day",
                  ar ? "أسوأ يوم" : "Worst day",
                ]}
                rows={report.operators.map((o) => [
                  <span key="n" className="font-medium text-ink-900">
                    {o.name}
                    <span className="ms-2 num text-xs text-ink-400" dir="ltr">{o.code}</span>
                    {!o.isActive && (
                      <span className="ms-2 text-xs text-ink-400">
                        {ar ? "(مش على رأس العمل)" : "(inactive)"}
                      </span>
                    )}
                  </span>,
                  <span key="l" className="text-xs text-ink-500">
                    {o.lineAr ? (ar ? o.lineAr : o.lineEn) : "—"}
                  </span>,
                  <span key="d" className="num">{formatNumber(o.days)}</span>,
                  <span key="p" className="num text-xs">{formatMinutes(o.smvProduced.toString())}</span>,
                  <span key="c" className="num text-xs text-ink-500">
                    {formatMinutes(o.clockedMinutes.toString())}
                  </span>,
                  o.efficiency ? (
                    <Badge key="e" tone={tone(o.efficiency)}>
                      {formatPercent(o.efficiency.toString())}
                    </Badge>
                  ) : (
                    <span key="e" className="text-ink-300">—</span>
                  ),
                  <span key="b" className="num text-xs text-good">
                    {o.best ? formatPercent(o.best.toString()) : "—"}
                  </span>,
                  <span key="w" className="num text-xs text-ink-500">
                    {o.worst ? formatPercent(o.worst.toString()) : "—"}
                  </span>,
                ])}
              />
            </Card>
          </div>

          <Card title={ar ? "آخر التسجيلات" : "Recent entries"}>
            <DataTable
              headers={[
                ar ? "اليوم" : "Day",
                ar ? "العامل" : "Operator",
                ar ? "أنتج" : "Produced",
                ar ? "اتدفع" : "Paid for",
                ar ? "الكفاءة" : "Efficiency",
                ar ? "ملاحظات" : "Notes",
              ]}
              empty={ar ? "مفيش" : "None"}
              rows={report.recent.map((r) => [
                <span key="d" className="num text-xs" dir="ltr">{day(r.date)}</span>,
                <span key="o">
                  {r.operatorName}
                  <span className="ms-2 num text-xs text-ink-400" dir="ltr">{r.operatorCode}</span>
                </span>,
                <span key="p" className="num text-xs">{formatMinutes(r.smvProduced)}</span>,
                <span key="c" className="num text-xs text-ink-500">{formatMinutes(r.clockedMinutes)}</span>,
                <span key="e" className="num">{formatPercent(r.efficiencyRate)}</span>,
                <span key="n" className="text-xs text-ink-500">{r.notes ?? "—"}</span>,
              ])}
            />
          </Card>
        </>
      )}
    </>
  );
}
