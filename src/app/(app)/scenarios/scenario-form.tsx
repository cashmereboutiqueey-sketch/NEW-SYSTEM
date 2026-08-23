"use client";

import { useActionState } from "react";
import { runScenarioAction, deleteScenarioAction } from "./actions";
import type { FormState } from "@/components/entity-form";
import type { Locale } from "@/lib/i18n";

const initial: FormState = {};
const field =
  "rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm text-ink-900 " +
  "focus:border-rose-deep focus:outline-none focus:ring-1 focus:ring-rose";
const label = "mb-1 block text-xs font-medium text-ink-600";

/**
 * Setting up a run.
 *
 * Blank means "leave it as it was" — which is not the same as zero. A blank
 * discount field keeps the discount the month actually gave; a zero one asks
 * what would happen if nothing were discounted at all.
 */
export function ScenarioForm({
  locale,
  baseline,
}: {
  locale: Locale;
  baseline: {
    utilisationRate: string;
    efficiencyRate: string;
    discountRate: string;
    returnRate: string;
    periodLabel: string;
  } | null;
}) {
  const [state, formAction, pending] = useActionState(runScenarioAction, initial);
  const ar = locale === "ar";

  const deltas: [string, string, string][] = [
    ["fabricPriceDeltaPct", "سعر القماش ±%", "Fabric price ±%"],
    ["wageDeltaPct", "الأجور ±%", "Wages ±%"],
    ["marketingDeltaPct", "التسويق ±%", "Marketing ±%"],
    ["retailPriceDeltaPct", "سعر البيع ±%", "Retail price ±%"],
    ["unitsSoldDeltaPct", "الكميات المباعة ±%", "Units sold ±%"],
  ];

  const targets: [string, string, string, string | undefined][] = [
    ["utilisationRate", "نسبة التشغيل %", "Utilisation %", baseline?.utilisationRate],
    ["efficiencyRate", "الكفاءة %", "Efficiency %", baseline?.efficiencyRate],
    ["discountRate", "الخصم %", "Discount %", baseline?.discountRate],
    ["returnRate", "المرتجعات %", "Returns %", baseline?.returnRate],
  ];

  return (
    <form action={formAction} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="sc-name">
            {ar ? "اسم السيناريو" : "Scenario name"}
          </label>
          <input
            id="sc-name"
            name="name"
            required
            placeholder={ar ? "القماش غلي ١٥٪" : "Fabric up 15%"}
            className={`${field} w-full`}
          />
        </div>
        <div>
          <label className={label} htmlFor="sc-desc">
            {ar ? "ملاحظة" : "Note"}
          </label>
          <input id="sc-desc" name="description" className={`${field} w-full`} />
        </div>
      </div>

      <div>
        <p className={label}>{ar ? "تغيير بنسبة" : "Change by"}</p>
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {deltas.map(([name, arLabel, enLabel]) => (
            <div key={name}>
              <label className="mb-1 block text-xs text-ink-500" htmlFor={`sc-${name}`}>
                {ar ? arLabel : enLabel}
              </label>
              <input
                id={`sc-${name}`}
                name={name}
                type="number"
                step="0.1"
                placeholder="0"
                dir="ltr"
                className={`${field} num w-full`}
              />
            </div>
          ))}
        </div>
      </div>

      <div>
        <p className={label}>
          {ar ? "تثبيت على قيمة" : "Set to"}
          <span className="ms-2 font-normal text-ink-400">
            {ar ? "سيبها فاضية عشان تفضل زي ما هي" : "leave blank to keep as it was"}
          </span>
        </p>
        <div className="grid gap-3 sm:grid-cols-4">
          {targets.map(([name, arLabel, enLabel, current]) => (
            <div key={name}>
              <label className="mb-1 block text-xs text-ink-500" htmlFor={`sc-${name}`}>
                {ar ? arLabel : enLabel}
              </label>
              <input
                id={`sc-${name}`}
                name={name}
                type="number"
                step="0.1"
                min="0"
                max="100"
                placeholder={
                  current ? (Number(current) * 100).toFixed(1) : undefined
                }
                dir="ltr"
                className={`${field} num w-full`}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending || !baseline}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {pending ? (ar ? "بيحسب…" : "Working…") : ar ? "شغّل السيناريو" : "Run it"}
        </button>
        {baseline && (
          <span className="text-xs text-ink-400">
            {ar ? "على شهر" : "against"} <span className="num" dir="ltr">{baseline.periodLabel}</span>
          </span>
        )}
      </div>

      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      {state.success && <p className="text-sm text-good">{state.success}</p>}
    </form>
  );
}

export function DeleteScenarioForm({ locale, scenarioId }: { locale: Locale; scenarioId: string }) {
  const [state, formAction, pending] = useActionState(deleteScenarioAction, initial);
  const ar = locale === "ar";

  return (
    <form action={formAction}>
      <input type="hidden" name="scenarioId" value={scenarioId} />
      <button
        type="submit"
        disabled={pending}
        className="text-xs text-ink-400 hover:text-bad disabled:opacity-40"
      >
        {pending ? "…" : ar ? "احذف" : "Delete"}
      </button>
      {state.error && <span className="text-xs text-bad">{state.error}</span>}
    </form>
  );
}
