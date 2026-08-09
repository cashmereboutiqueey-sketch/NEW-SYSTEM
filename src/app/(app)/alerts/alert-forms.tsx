"use client";

import { useActionState } from "react";
import { runAlertsAction, acknowledgeAlertAction } from "./actions";
import type { FormState } from "@/components/entity-form";
import type { Locale } from "@/lib/i18n";

const initial: FormState = {};

export function RunAlertsForm({ locale }: { locale: Locale }) {
  const [state, formAction, pending] = useActionState(runAlertsAction, initial);
  const ar = locale === "ar";

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-3">
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
      >
        {pending ? (ar ? "بيفحص…" : "Checking…") : ar ? "افحص دلوقتي" : "Check now"}
      </button>
      {state.error && <span className="text-sm text-bad">{state.error}</span>}
      {state.success && <span className="text-sm text-good">{state.success}</span>}
    </form>
  );
}

/**
 * Acknowledging, or putting it aside for a while.
 *
 * Snoozing does not close the condition — it comes back if it is still true
 * when the time is up. An alert that could be dismissed permanently while the
 * problem continues would be worse than no alert.
 */
export function AcknowledgeForm({
  locale,
  alertId,
  status,
}: {
  locale: Locale;
  alertId: string;
  status: string;
}) {
  const [state, formAction, pending] = useActionState(acknowledgeAlertAction, initial);
  const ar = locale === "ar";

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="alertId" value={alertId} />
      <select
        name="snoozeDays"
        defaultValue="0"
        className="rounded-lg border border-ink-200 bg-white px-2 py-1 text-xs text-ink-700"
      >
        <option value="0">{ar ? "شفتها" : "Acknowledge"}</option>
        <option value="7">{ar ? "أجّلها أسبوع" : "Snooze a week"}</option>
        <option value="30">{ar ? "أجّلها شهر" : "Snooze a month"}</option>
      </select>
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg border border-ink-300 px-3 py-1 text-xs text-ink-700 disabled:opacity-40"
      >
        {pending ? "…" : status === "OPEN" ? (ar ? "تم" : "Done") : ar ? "حدّث" : "Update"}
      </button>
      {state.error && <span className="w-full text-xs text-bad">{state.error}</span>}
      {state.success && <span className="w-full text-xs text-good">{state.success}</span>}
    </form>
  );
}
