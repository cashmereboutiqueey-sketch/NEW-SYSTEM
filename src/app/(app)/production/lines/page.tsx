import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { lineEfficiencyReport } from "@/lib/factory-floor";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatNumber, formatPercent, dec, safeDiv } from "@/lib/money";

/**
 * كفاءة الخط — earned minutes over minutes paid for.
 *
 * Naming the stage is the whole point. "The order ran late" is not actionable;
 * "the sewing line ran at 62% and lost eleven pieces between cutting and
 * finishing" tells somebody where to stand tomorrow morning.
 */
export default async function LineEfficiencyPage() {
  await requirePermission("production:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const report = await lineEfficiencyReport();
  const overall = safeDiv(report.totals.earned, report.totals.clocked);

  const stageLabel: Record<string, string> = ar
    ? {
        CUTTING: "قص",
        SEWING: "خياطة",
        FINISHING: "تشطيب",
        PRESSING: "مكوى",
        PACKING: "تعبئة",
        QC: "جودة",
      }
    : {
        CUTTING: "Cutting",
        SEWING: "Sewing",
        FINISHING: "Finishing",
        PRESSING: "Pressing",
        PACKING: "Packing",
        QC: "QC",
      };

  const tone = (e: ReturnType<typeof safeDiv>) =>
    e == null
      ? "num text-ink-400"
      : e.greaterThanOrEqualTo(0.85)
        ? "num text-good"
        : e.lessThan(0.65)
          ? "num text-bad"
          : "num text-warn";

  return (
    <>
      <PageHeader
        title={ar ? "كفاءة الخط" : "Line efficiency"}
        subtitle={
          ar
            ? "الدقائق المكتسبة على الدقائق المدفوعة — آخر ٩٠ يوم"
            : "Earned minutes over minutes paid for — the last 90 days"
        }
      />

      {report.recent.length === 0 ? (
        <Card>
          <p className="py-8 text-center text-sm text-ink-400">
            {ar
              ? "لسه مفيش تسجيل لمراحل الإنتاج. الشاشة دي بتشتغل لما الصالة تسجّل الدقائق المدفوعة والخارج من كل مرحلة."
              : "No production stages have been logged yet. This screen fills once the floor records clocked minutes and output per stage."}
          </p>
        </Card>
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <StatTile
              label={ar ? "الكفاءة الإجمالية" : "Overall efficiency"}
              value={overall ? formatPercent(overall, locale) : "—"}
              tone={overall && overall.greaterThanOrEqualTo(0.8) ? "good" : "warn"}
            />
            <StatTile
              label={ar ? "دقائق مكتسبة" : "Earned minutes"}
              value={formatNumber(report.totals.earned, locale)}
            />
            <StatTile
              label={ar ? "دقائق مدفوعة" : "Clocked minutes"}
              value={formatNumber(report.totals.clocked, locale)}
              hint={
                ar
                  ? `${formatNumber(report.totals.clocked.minus(report.totals.earned), locale)} دقيقة اتدفعت ومااتكسبتش`
                  : `${formatNumber(report.totals.clocked.minus(report.totals.earned), locale)} paid for and not earned`
              }
            />
          </div>

          <Card
            className="mb-4"
            title={ar ? "بالخط" : "By line"}
            description={ar ? "الأضعف الأول" : "Weakest first"}
          >
            <DataTable
              headers={[
                ar ? "الخط" : "Line",
                ar ? "مكتسب" : "Earned",
                ar ? "مدفوع" : "Clocked",
                ar ? "الكفاءة" : "Efficiency",
                ar ? "داخل" : "In",
                ar ? "خارج" : "Out",
                ar ? "فاقد" : "Drop-out",
              ]}
              rows={report.lines.map((l) => [
                <span key={`${l.id}-n`}>{ar ? l.nameAr : l.nameEn}</span>,
                <span key={`${l.id}-e`} className="num">{formatNumber(l.earned, locale)}</span>,
                <span key={`${l.id}-c`} className="num">{formatNumber(l.clocked, locale)}</span>,
                <span key={`${l.id}-f`} className={tone(l.efficiency)}>
                  {l.efficiency ? formatPercent(l.efficiency, locale) : "—"}
                </span>,
                <span key={`${l.id}-i`} className="num">{l.qtyIn}</span>,
                <span key={`${l.id}-o`} className="num">{l.qtyOut}</span>,
                l.dropOut > 0 ? (
                  <span key={`${l.id}-d`} className="num text-bad">−{l.dropOut}</span>
                ) : (
                  <Badge key={`${l.id}-d`} tone="good">{ar ? "مفيش" : "None"}</Badge>
                ),
              ])}
            />
          </Card>

          <Card className="mb-4" title={ar ? "بالمرحلة" : "By stage"}>
            <DataTable
              headers={[
                ar ? "المرحلة" : "Stage",
                ar ? "مكتسب" : "Earned",
                ar ? "مدفوع" : "Clocked",
                ar ? "الكفاءة" : "Efficiency",
                ar ? "فاقد" : "Drop-out",
              ]}
              rows={report.stages.map((s) => [
                <span key={`${s.stage}-n`}>{stageLabel[s.stage] ?? s.stage}</span>,
                <span key={`${s.stage}-e`} className="num">{formatNumber(s.earned, locale)}</span>,
                <span key={`${s.stage}-c`} className="num">{formatNumber(s.clocked, locale)}</span>,
                <span key={`${s.stage}-f`} className={tone(s.efficiency)}>
                  {s.efficiency ? formatPercent(s.efficiency, locale) : "—"}
                </span>,
                <span key={`${s.stage}-d`} className={s.dropOut > 0 ? "num text-bad" : "num"}>
                  {s.dropOut > 0 ? `−${s.dropOut}` : "—"}
                </span>,
              ])}
            />
          </Card>

          <Card title={ar ? "آخر التسجيلات" : "Recent entries"}>
            <DataTable
              headers={[
                ar ? "التاريخ" : "Date",
                ar ? "الأمر" : "Order",
                ar ? "المرحلة" : "Stage",
                ar ? "الخط" : "Line",
                ar ? "داخل" : "In",
                ar ? "خارج" : "Out",
                ar ? "عمال" : "Ops",
                ar ? "الكفاءة" : "Efficiency",
              ]}
              rows={report.recent.map((r) => [
                <span key={`${r.id}-d`} className="num" dir="ltr">
                  {r.date.toISOString().slice(0, 10)}
                </span>,
                <span key={`${r.id}-o`}>
                  <code dir="ltr" className="text-xs text-ink-500">{r.orderNumber}</code>
                  <span className="ms-2">{ar ? r.styleAr : r.styleEn}</span>
                </span>,
                <span key={`${r.id}-s`}>{stageLabel[r.stage] ?? r.stage}</span>,
                <span key={`${r.id}-l`} className="text-ink-500">{ar ? r.lineAr : r.lineEn}</span>,
                <span key={`${r.id}-i`} className="num">{r.qtyIn}</span>,
                <span key={`${r.id}-q`} className="num">{r.qtyOut}</span>,
                <span key={`${r.id}-p`} className="num text-ink-500">{r.operators ?? "—"}</span>,
                <span key={`${r.id}-e`} className={tone(r.efficiency)}>
                  {formatPercent(r.efficiency, locale)}
                </span>,
              ])}
            />
          </Card>
        </>
      )}
    </>
  );
}
