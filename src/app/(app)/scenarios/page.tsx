import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { can } from "@/core/permissions";
import { buildBaseline, recentScenarios } from "@/lib/scenarios";
import { PageHeader, Card, DataTable, Badge } from "@/components/ui";
import { formatMoney, formatNumber, formatPercent, dec } from "@/lib/money";
import { ScenarioForm, DeleteScenarioForm } from "./scenario-form";

/**
 * ماذا لو — one month's real figures, with one thing changed.
 *
 * The baseline is measured rather than typed: the conversion pool from posted
 * accounts, the capacity from the minute-rate period, the discount from what
 * was actually given away. Only the assumption is hypothetical, which is what
 * separates this from a spreadsheet somebody can talk into any answer.
 */
const ASSUMPTION_LABELS: Record<string, string> = {
  fabricPriceDeltaPct: "fabric",
  wageDeltaPct: "wages",
  marketingDeltaPct: "marketing",
  retailPriceDeltaPct: "retail price",
  unitsSoldDeltaPct: "units sold",
  utilisationRate: "utilisation",
  efficiencyRate: "efficiency",
  discountRate: "discount",
  returnRate: "returns",
};

/** What was actually changed, for a scenario saved without a note. */
function describeAssumptions(assumptions: unknown): string {
  if (!assumptions || typeof assumptions !== "object") return "";
  return Object.entries(assumptions as Record<string, unknown>)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${ASSUMPTION_LABELS[k] ?? k} ${(Number(v) * 100).toFixed(1)}%`)
    .join(" · ");
}

export default async function ScenariosPage() {
  const session = await requirePermission("scenario:run");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const mayRun = can(session.role, "scenario:run");

  let baseline: Awaited<ReturnType<typeof buildBaseline>> | null = null;
  let baselineError: string | null = null;
  try {
    baseline = await buildBaseline();
  } catch (error) {
    baselineError = error instanceof Error ? error.message : String(error);
  }

  const scenarios = await recentScenarios();

  const formatValue = (value: string, unit: string) => {
    const d = dec(value);
    if (unit === "RATE") return formatNumber(d.toDecimalPlaces(4), locale);
    if (unit === "UNITS") return formatNumber(d.toDecimalPlaces(0), locale);
    if (unit === "PCT") return formatPercent(d, locale);
    return formatMoney(d, locale);
  };

  // Cheaper and more is better; costlier and fewer is worse. Which way round
  // depends on the metric, so it is stated rather than guessed from the sign.
  const LOWER_IS_BETTER = new Set([
    "minuteRate",
    "idlePenaltyPerMinute",
    "factoryCostPerUnit",
    "breakEvenUnits",
  ]);

  return (
    <>
      <PageHeader
        title={ar ? "ماذا لو" : "What if"}
        subtitle={
          ar
            ? "شهر حقيقي، بتغيير حاجة واحدة — الأساس متقاس من الدفاتر، الافتراض بس هو اللي مفترض"
            : "A real month with one thing changed — the baseline is measured, only the assumption is hypothetical"
        }
      />

      {baselineError ? (
        <Card className="mb-4">
          <p className="py-6 text-center text-sm text-ink-500">{baselineError}</p>
        </Card>
      ) : (
        baseline && (
          <Card
            className="mb-4"
            title={ar ? "الشهر الأساس" : "The month it runs against"}
            description={`${baseline.periodLabel}`}
          >
            <DataTable
              headers={[ar ? "البند" : "Measure", ar ? "القيمة" : "Value"]}
              rows={[
                [
                  <span key="c">{ar ? "مجمّع تكاليف التشغيل" : "Conversion pool"}</span>,
                  <span key="cv" className="num">
                    {formatMoney(baseline.baseline.conversionCost, locale)}
                  </span>,
                ],
                [
                  <span key="u">{ar ? "نسبة التشغيل" : "Utilisation"}</span>,
                  <span key="uv" className="num">
                    {formatPercent(baseline.baseline.utilisationRate, locale)}
                  </span>,
                ],
                [
                  <span key="e">{ar ? "الكفاءة" : "Efficiency"}</span>,
                  <span key="ev" className="num">
                    {formatPercent(baseline.baseline.efficiencyRate, locale)}
                  </span>,
                ],
                [
                  <span key="s">{ar ? "قطع مباعة" : "Units sold"}</span>,
                  <span key="sv" className="num">
                    {formatNumber(baseline.baseline.unitsSold, locale)}
                  </span>,
                ],
                [
                  <span key="d">{ar ? "متوسط الخصم" : "Average discount"}</span>,
                  <span key="dv" className="num">
                    {formatPercent(baseline.baseline.discountRate, locale)}
                  </span>,
                ],
              ]}
            />
          </Card>
        )
      )}

      {mayRun && (
        <Card className="mb-4" title={ar ? "سيناريو جديد" : "New scenario"}>
          <ScenarioForm
            locale={locale}
            baseline={
              baseline
                ? {
                    utilisationRate: baseline.baseline.utilisationRate.toString(),
                    efficiencyRate: baseline.baseline.efficiencyRate.toString(),
                    discountRate: baseline.baseline.discountRate.toString(),
                    returnRate: baseline.baseline.returnRate.toString(),
                    periodLabel: baseline.periodLabel,
                  }
                : null
            }
          />
        </Card>
      )}

      {scenarios.length === 0 ? (
        <Card>
          <p className="py-8 text-center text-sm text-ink-400">
            {ar ? "لسه مفيش سيناريوهات." : "No scenarios have been run yet."}
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          {scenarios.map((s) => (
            <Card
              key={s.id}
              title={s.name}
              description={s.descriptionAr ?? describeAssumptions(s.assumptions)}
            >
              <DataTable
                headers={[
                  ar ? "المؤشر" : "Metric",
                  ar ? "قبل" : "Before",
                  ar ? "بعد" : "After",
                  ar ? "الفرق" : "Change",
                ]}
                rows={s.results.map((r) => {
                  const delta = dec(r.delta);
                  const better = LOWER_IS_BETTER.has(r.metricKey)
                    ? delta.lessThan(0)
                    : delta.greaterThan(0);
                  const tone = delta.isZero()
                    ? "num text-ink-400"
                    : better
                      ? "num text-good"
                      : "num text-bad";

                  return [
                    <span key={`${r.id}-l`}>{ar ? r.labelAr : r.labelEn}</span>,
                    <span key={`${r.id}-b`} className="num text-ink-500">
                      {formatValue(r.baseline.toString(), r.unit)}
                    </span>,
                    <span key={`${r.id}-s`} className="num font-medium">
                      {formatValue(r.simulated.toString(), r.unit)}
                    </span>,
                    <span key={`${r.id}-d`} className={tone}>
                      {delta.greaterThan(0) ? "+" : ""}
                      {formatValue(r.delta.toString(), r.unit)}
                      {r.deltaPct && (
                        <span className="ms-2 text-xs">
                          ({dec(r.deltaPct).greaterThan(0) ? "+" : ""}
                          {formatPercent(r.deltaPct, locale)})
                        </span>
                      )}
                    </span>,
                  ];
                })}
              />
              <div className="mt-3 flex items-center justify-between">
                <Badge tone="neutral">
                  {s.createdBy?.name ?? "—"} · {s.createdAt.toISOString().slice(0, 10)}
                </Badge>
                {mayRun && <DeleteScenarioForm locale={locale} scenarioId={s.id} />}
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
