"use client";

import { useActionState } from "react";
import { freezeScorecardsAction } from "./actions";
import type { FormState } from "@/components/entity-form";

const empty: FormState = {};

export type ScorablePeriod = {
  id: string;
  label: string;
  status: string;
  scored: number;
};

/**
 * Freezing a period.
 *
 * The live table above answers "how is this supplier". It cannot answer "are
 * they getting better", because it is computed over everything that ever
 * happened — so a supplier who was poor last year and good since looks
 * mediocre forever.
 */
export function FreezeForm({ ar, periods }: { ar: boolean; periods: ScorablePeriod[] }) {
  const [state, action, pending] = useActionState(freezeScorecardsAction, empty);

  if (periods.length === 0) {
    return (
      <p className="text-sm text-ink-500">
        {ar ? "مفيش فترات مالية." : "There are no fiscal periods."}
      </p>
    );
  }

  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <div className="min-w-[12rem]">
        <label className="mb-1 block text-xs font-medium text-ink-600" htmlFor="fiscalPeriodId">
          {ar ? "الفترة" : "Period"}
        </label>
        <select
          id="fiscalPeriodId" name="fiscalPeriodId" required
          className="w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep"
        >
          {periods.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
              {p.scored > 0 ? ` — ${p.scored} ${ar ? "محفوظ" : "saved"}` : ""}
            </option>
          ))}
        </select>
      </div>

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-ink-900 px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {pending ? (ar ? "بيتحفظ…" : "Freezing…") : ar ? "احفظ تقييم الفترة" : "Freeze the period"}
      </button>

      {state.error && <p className="w-full text-sm text-bad">{state.error}</p>}
      {state.success && <p className="w-full text-sm text-good">{state.success}</p>}

      <p className="w-full text-xs text-ink-400">
        {ar
          ? "التقييم المحفوظ بيفضل زي ما هو — مورد اتحسن السنة دي مش المفروض يتعدّل له تقييم السنة اللي فاتت لصالحه، ولا العكس."
          : "A frozen scorecard stays as it was: a supplier who improves should not have last quarter rewritten in their favour, nor one who slips have it rewritten against them."}
      </p>
    </form>
  );
}
