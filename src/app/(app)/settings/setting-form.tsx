"use client";

import { useActionState, useState } from "react";
import { updateSettingAction } from "./actions";
import type { FormState } from "@/components/entity-form";
import type { Locale } from "@/lib/i18n";

const initial: FormState = {};
const field =
  "rounded-lg border border-ink-200 bg-panel px-2 py-1.5 text-sm text-ink-900 " +
  "focus:border-rose-deep focus:outline-none focus:ring-1 focus:ring-rose";

/**
 * One row, one value.
 *
 * The save button appears only once the value has actually changed, so a
 * screen of forty settings does not look like forty pending decisions.
 */
export function SettingForm({
  locale,
  settingKey,
  value,
  type,
}: {
  locale: Locale;
  settingKey: string;
  value: string;
  type: string;
}) {
  const [state, formAction, pending] = useActionState(updateSettingAction, initial);
  const [draft, setDraft] = useState(value);
  const ar = locale === "ar";

  const changed = draft !== value;
  const isBoolean = type === "BOOLEAN";

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="key" value={settingKey} />

      {isBoolean ? (
        <select
          name="value"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className={`${field} w-28`}
        >
          <option value="true">{ar ? "مفعّل" : "On"}</option>
          <option value="false">{ar ? "مقفول" : "Off"}</option>
        </select>
      ) : (
        <input
          name="value"
          type={type === "STRING" ? "text" : "number"}
          step="any"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          dir="ltr"
          className={`${field} num w-32`}
        />
      )}

      {changed && (
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-ink-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
        >
          {pending ? (ar ? "…" : "…") : ar ? "احفظ" : "Save"}
        </button>
      )}

      {state.error && <span className="w-full text-xs text-bad">{state.error}</span>}
      {state.success && <span className="w-full text-xs text-good">{state.success}</span>}
    </form>
  );
}
