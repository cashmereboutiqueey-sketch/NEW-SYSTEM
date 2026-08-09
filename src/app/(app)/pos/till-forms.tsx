"use client";

import { useActionState } from "react";
import { openTillAction, closeTillAction, type PosState } from "./actions";
import type { Locale } from "@/lib/i18n";

const initial: PosState = {};
const field =
  "rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 " +
  "focus:border-ink-400 focus:outline-none focus:ring-1 focus:ring-ink-300";

export function OpenTillForm({
  locale,
  locations,
}: {
  locale: Locale;
  locations: { id: string; label: string }[];
}) {
  const [state, formAction, pending] = useActionState(openTillAction, initial);
  const ar = locale === "ar";

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <div>
        <label className="mb-1 block text-xs font-medium text-ink-600" htmlFor="locationId">
          {ar ? "الفرع" : "Location"}
        </label>
        <select id="locationId" name="locationId" required className={field}>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>{l.label}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-ink-600" htmlFor="openingFloat">
          {ar ? "الرصيد الافتتاحي للدرج" : "Opening float"}
        </label>
        <input
          id="openingFloat" name="openingFloat" type="number" step="0.01" min="0"
          defaultValue="0" dir="ltr" className={`${field} num w-32`}
        />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? (ar ? "جارٍ الفتح…" : "Opening…") : (ar ? "افتح الوردية" : "Open the till")}
      </button>

      {state.error && (
        <p role="alert" className="w-full rounded-lg bg-bad/10 px-3 py-2 text-sm text-bad">
          {state.error}
        </p>
      )}
    </form>
  );
}

export function CloseTillForm({
  locale,
  posSessionId,
  expected,
}: {
  locale: Locale;
  posSessionId: string;
  expected: string;
}) {
  const [state, formAction, pending] = useActionState(closeTillAction, initial);
  const ar = locale === "ar";

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="posSessionId" value={posSessionId} />
      <div>
        <label className="mb-1 block text-xs font-medium text-ink-600" htmlFor="countedCash">
          {ar ? "النقدية المعدودة في الدرج" : "Cash counted in the drawer"}
        </label>
        <input
          id="countedCash" name="countedCash" type="number" step="0.01" min="0" required
          dir="ltr" className={`${field} num w-36`}
        />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-ink-600" htmlFor="note">
          {ar ? "ملاحظة (لو فيه فرق)" : "Note (if there is a difference)"}
        </label>
        <input id="note" name="note" className={`${field} w-56`} />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg border border-ink-300 px-4 py-2 text-sm font-medium text-ink-700 disabled:opacity-50"
      >
        {pending ? (ar ? "جارٍ القفل…" : "Closing…") : (ar ? "قفل الوردية" : "Close the till")}
      </button>

      <p className="w-full text-xs text-ink-500">
        {ar
          ? `المتوقع في الدرج ${expected}. الفرق بيتسجّل ومابيتجبرش على الصفر.`
          : `Expected in the drawer: ${expected}. A difference is recorded, never forced to zero.`}
      </p>

      {state.error && (
        <p role="alert" className="w-full rounded-lg bg-bad/10 px-3 py-2 text-sm text-bad">
          {state.error}
        </p>
      )}
      {state.success && (
        <p role="status" className="w-full rounded-lg bg-good/10 px-3 py-2 text-sm text-good">
          {state.success}
        </p>
      )}
    </form>
  );
}
