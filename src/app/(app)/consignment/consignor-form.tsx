"use client";

import { useActionState } from "react";
import { createConsignorAction, type ConsignmentState } from "./actions";

const empty: ConsignmentState = {};
const field =
  "w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep";

export function ConsignorForm({ ar }: { ar: boolean }) {
  const [state, action, pending] = useActionState(createConsignorAction, empty);

  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <label className="text-sm">
        <span className="mb-1 block text-ink-600">{ar ? "الاسم" : "Name"}</span>
        <input name="name" required className={field} />
      </label>

      <label className="text-sm">
        <span className="mb-1 block text-ink-600">{ar ? "كود" : "Code"}</span>
        <input name="code" required dir="ltr" placeholder="MAISON" className={field} />
      </label>

      <label className="text-sm">
        <span className="mb-1 block text-ink-600">{ar ? "نسبتك %" : "Your share %"}</span>
        <input
          name="commissionPct" type="number" min="0" max="100" step="0.5"
          required defaultValue="25" dir="ltr" className={`${field} text-end`}
        />
      </label>

      <label className="text-sm">
        <span className="mb-1 block text-ink-600">{ar ? "تليفون" : "Phone"}</span>
        <input name="phone" dir="ltr" className={field} />
      </label>

      <label className="text-sm">
        <span className="mb-1 block text-ink-600">
          {ar ? "بيستلم فلوسه كل كام يوم" : "Settle every (days)"}
        </span>
        <input
          name="settlementDays" type="number" min="0" step="1"
          defaultValue="14" dir="ltr" className={`${field} text-end`}
        />
      </label>

      <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? (ar ? "…" : "…") : ar ? "ضيفه" : "Add"}
        </button>
        {state.error && <p className="text-sm text-bad">{state.error}</p>}
        {state.success && <p className="text-sm text-good">{state.success}</p>}
      </div>
    </form>
  );
}
