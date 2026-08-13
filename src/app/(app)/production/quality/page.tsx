import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { can } from "@/core/permissions";
import { qualityReport, inspectableRuns } from "@/lib/quality";
import { activeLines } from "@/lib/stage-logs";
import { scrappableMaterials } from "@/lib/scrap";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber, formatPercent, formatMinutes } from "@/lib/money";
import { InspectionForm, ReworkForm } from "./quality-forms";

/**
 * الجودة وإعادة التشغيل — what the inspection found and what fixing it cost.
 *
 * Rework is the most expensive thing a factory does not measure. The minutes
 * are paid twice and earn once: the garment was already costed at its standard
 * minutes, and every minute spent fixing it is a minute the line did not spend
 * making the next one.
 *
 * The defect rate and the cost of the fixing are shown together on purpose. A
 * 3% defect rate on a style that takes forty minutes to put right is worse
 * than 8% on one that takes four, and a rate on its own cannot say that.
 */
export default async function QualityPage() {
  const session = await requirePermission("production:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });
  const [report, runs, lines, materials] = await Promise.all([
    qualityReport(),
    inspectableRuns(),
    activeLines(),
    // The same piles the scrap screen offers: material on a shelf, with what
    // is left of it. Rework consumes from them the same way.
    scrappableMaterials(factory.id),
  ]);

  const mayRecord = can(session.role, "production:create");

  // The rate rework will be costed at today, so the form can do the
  // arithmetic in front of the person rather than after them.
  const today = new Date();
  const period = await db.minuteRatePeriod.findFirst({
    where: {
      entityId: factory.id,
      fiscalPeriod: { startDate: { lte: today }, endDate: { gte: today } },
    },
    orderBy: { calculatedAt: "desc" },
    select: { actualMinuteRate: true },
  });

  const typeLabel: Record<string, string> = ar
    ? {
        RESEWING: "إعادة خياطة",
        REPRESSING: "إعادة مكوى",
        REPACKING: "إعادة تعبئة",
        RECUTTING: "إعادة قص",
        WASHING: "غسيل",
      }
    : {
        RESEWING: "Resewing",
        REPRESSING: "Repressing",
        REPACKING: "Repacking",
        RECUTTING: "Recutting",
        WASHING: "Washing",
      };

  const stageLabel: Record<string, string> = ar
    ? { CUTTING: "قص", SEWING: "خياطة", FINISHING: "تشطيب", QC: "جودة", PACKING: "تعبئة" }
    : { CUTTING: "Cutting", SEWING: "Sewing", FINISHING: "Finishing", QC: "QC", PACKING: "Packing" };

  const rateTone = (rate: { toString(): string } | null) => {
    if (!rate) return "neutral" as const;
    const v = Number(rate);
    return v <= 0.03 ? ("good" as const) : v <= 0.08 ? ("warn" as const) : ("bad" as const);
  };

  const day = (d: Date) => new Date(d).toISOString().slice(0, 10);

  return (
    <>
      <PageHeader
        title={ar ? "الجودة وإعادة التشغيل" : "Quality and rework"}
        subtitle={
          ar
            ? "الفحص لقى إيه، والإصلاح كلّف كام — آخر ٦ شهور"
            : "What inspection found and what fixing it cost — the last six months"
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <StatTile
          label={ar ? "نسبة العيوب" : "Defect rate"}
          value={report.totals.defectRate ? formatPercent(report.totals.defectRate.toString()) : "—"}
          hint={`${formatNumber(report.totals.defective)} ${ar ? "من" : "of"} ${formatNumber(report.totals.inspected)}`}
          tone={rateTone(report.totals.defectRate)}
        />
        <StatTile
          label={ar ? "تكلفة الإصلاح" : "Cost of rework"}
          value={formatMoney(report.totals.cost.toString())}
          hint={ar ? "على حساب ٥٥٠٠" : "charged to 5500"}
          tone={report.totals.cost.greaterThan(0) ? "bad" : "good"}
        />
        <StatTile
          label={ar ? "دقايق اتصرفت مرتين" : "Minutes paid twice"}
          value={formatMinutes(report.totals.minutes.toString())}
          hint={ar ? "شغل مجابش عائد" : "work that earned nothing"}
          tone={report.totals.minutes.greaterThan(0) ? "warn" : "neutral"}
        />
        <StatTile
          label={ar ? "قطع اتصلحت" : "Pieces reworked"}
          value={formatNumber(report.totals.reworked)}
        />
      </div>

      {mayRecord && (
        <div className="mb-5 grid gap-4 lg:grid-cols-2">
          <Card
            title={ar ? "سجّل فحص" : "Record an inspection"}
            description={
              ar
                ? "نسبة العيوب مش بتتكتب — بتطلع من عدّى + رجع + اترفض."
                : "The defect rate is never typed: it falls out of passed, sent back and rejected."
            }
          >
            <InspectionForm ar={ar} runs={runs} />
          </Card>

          <Card
            title={ar ? "سجّل إصلاح" : "Record rework"}
            description={
              ar
                ? "التكلفة = دقايق × سعر الدقيقة وقتها، والسعر بيتجمّد على السجل."
                : "Cost is minutes × the rate in force that day, frozen onto the record."
            }
          >
            <ReworkForm
              ar={ar}
              entityId={factory.id}
              runs={runs}
              lines={lines}
              minuteRate={period ? period.actualMinuteRate.toString() : null}
              materials={materials.map((m) => ({
                materialId: m.materialId,
                locationId: m.locationId,
                code: m.code,
                nameAr: m.nameAr,
                nameEn: m.nameEn,
                uom: m.uom,
                onHand: m.onHand.toString(),
              }))}
            />
          </Card>
        </div>
      )}

      {report.runs.length === 0 ? (
        <Card>
          <p className="py-8 text-center text-sm text-ink-400">
            {ar
              ? "لسه مفيش فحص ولا إصلاح مسجّل."
              : "No inspections or rework have been recorded yet."}
          </p>
        </Card>
      ) : (
        <>
          <div className="mb-5">
            <Card
              title={ar ? "بالأمر" : "By run"}
              description={
                ar
                  ? "الأغلى الأول. «فاضل» يعني اتلاقى في الفحص ولسه ماتصلحش."
                  : "The dearest first. \"Outstanding\" is what inspection found and nobody has fixed."
              }
            >
              <DataTable
                headers={[
                  ar ? "الأمر" : "Run",
                  ar ? "الموديل" : "Style",
                  ar ? "اتفحص" : "Inspected",
                  ar ? "نسبة العيوب" : "Defect rate",
                  ar ? "اتصلح" : "Reworked",
                  ar ? "فاضل" : "Outstanding",
                  ar ? "دقايق" : "Minutes",
                  ar ? "التكلفة" : "Cost",
                  ar ? "للقطعة" : "Per piece",
                ]}
                rows={report.runs.map((r) => [
                  <span key="o" className="num text-xs" dir="ltr">{r.orderNumber}</span>,
                  <span key="s" className="font-medium text-ink-900">
                    {ar ? r.styleAr : r.styleEn}
                    <span className="ms-2 num text-xs text-ink-400" dir="ltr">{r.styleCode}</span>
                  </span>,
                  <span key="i" className="num">{formatNumber(r.inspected)}</span>,
                  r.defectRate ? (
                    <Badge key="d" tone={rateTone(r.defectRate)}>
                      {formatPercent(r.defectRate.toString())}
                    </Badge>
                  ) : (
                    <span key="d" className="text-ink-300">—</span>
                  ),
                  <span key="rw" className="num">{formatNumber(r.reworkDone)}</span>,
                  r.outstanding > 0 ? (
                    <Badge key="out" tone="warn">{formatNumber(r.outstanding)}</Badge>
                  ) : (
                    <span key="out" className="text-ink-300">—</span>
                  ),
                  <span key="m" className="num text-xs">{formatMinutes(r.minutes.toString())}</span>,
                  <span key="c" className="num font-medium">{formatMoney(r.cost.toString())}</span>,
                  <span key="pp" className="num text-xs text-ink-500">
                    {r.costPerReworked ? formatMoney(r.costPerReworked.toString()) : "—"}
                  </span>,
                ])}
              />
            </Card>
          </div>

          {report.byType.length > 0 && (
            <div className="mb-5">
              <Card title={ar ? "بنوع الإصلاح" : "By kind of fixing"}>
                <DataTable
                  headers={[
                    ar ? "النوع" : "Kind",
                    ar ? "قطع" : "Pieces",
                    ar ? "دقايق" : "Minutes",
                    ar ? "التكلفة" : "Cost",
                  ]}
                  rows={report.byType.map((t) => [
                    typeLabel[t.type] ?? t.type,
                    <span key="q" className="num">{formatNumber(t.quantity)}</span>,
                    <span key="m" className="num">{formatMinutes(t.minutes.toString())}</span>,
                    <span key="c" className="num font-medium">{formatMoney(t.cost.toString())}</span>,
                  ])}
                />
              </Card>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title={ar ? "آخر الفحوصات" : "Recent inspections"}>
              <DataTable
                headers={[
                  ar ? "التاريخ" : "Date",
                  ar ? "الأمر" : "Run",
                  ar ? "المرحلة" : "Stage",
                  ar ? "فحص" : "Insp.",
                  ar ? "عدّى" : "Passed",
                  ar ? "رجع" : "Back",
                  ar ? "اترفض" : "Rej.",
                ]}
                empty={ar ? "مفيش" : "None"}
                rows={report.recentInspections.map((i) => [
                  <span key="d" className="num text-xs" dir="ltr">{day(i.date)}</span>,
                  <span key="o" className="num text-xs" dir="ltr">{i.orderNumber}</span>,
                  stageLabel[i.stage] ?? i.stage,
                  <span key="i" className="num">{formatNumber(i.inspectedQty)}</span>,
                  <span key="p" className="num text-good">{formatNumber(i.passedQty)}</span>,
                  <span key="r" className="num text-warn">{formatNumber(i.reworkQty)}</span>,
                  <span key="x" className="num text-bad">{formatNumber(i.rejectedQty)}</span>,
                ])}
              />
            </Card>

            <Card title={ar ? "آخر الإصلاحات" : "Recent rework"}>
              <DataTable
                headers={[
                  ar ? "التاريخ" : "Date",
                  ar ? "الأمر" : "Run",
                  ar ? "النوع" : "Kind",
                  ar ? "قطع" : "Pieces",
                  ar ? "دقايق" : "Minutes",
                  ar ? "التكلفة" : "Cost",
                ]}
                empty={ar ? "مفيش" : "None"}
                rows={report.recentReworks.map((r) => [
                  <span key="d" className="num text-xs" dir="ltr">{day(r.date)}</span>,
                  <span key="o" className="num text-xs" dir="ltr">{r.orderNumber}</span>,
                  typeLabel[r.type] ?? r.type,
                  <span key="q" className="num">{formatNumber(r.quantity)}</span>,
                  <span key="m" className="num text-xs">{formatMinutes(r.totalMinutes)}</span>,
                  <span key="c" className="num font-medium">{formatMoney(r.totalCost)}</span>,
                ])}
              />
            </Card>
          </div>
        </>
      )}
    </>
  );
}
