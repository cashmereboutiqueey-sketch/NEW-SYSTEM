"use client";

import { useActionState } from "react";
import { releaseRepairAction, type ReturnState } from "./actions";

const empty: ReturnState = {};

/** "Repaired, fit to sell" for one held return. */
export function ReleaseForm({ ar, lotId }: { ar: boolean; lotId: string }) {
  const [state, action, pending] = useActionState(releaseRepairAction, empty);

  if (state.success) return <span className="text-xs text-good">{state.success}</span>;

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="lotId" value={lotId} />
      <input
        name="note"
        placeholder={ar ? "اتصلّح إزاي (اختياري)" : "What was done (optional)"}
        className="rounded-lg border border-ink-200 px-2 py-1 text-xs outline-none focus:border-rose-deep"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-ink-900 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
      >
        {pending ? "…" : ar ? "اتصلّحت — رجّعها للبيع" : "Repaired — back on sale"}
      </button>
      {state.error && <p className="w-full text-xs text-bad">{state.error}</p>}
    </form>
  );
}
