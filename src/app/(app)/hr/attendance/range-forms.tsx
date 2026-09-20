"use client";

import { useActionState } from "react";
import { deriveAction, lockPeriodAction } from "./actions";
import type { FormState } from "@/components/entity-form";

const empty: FormState = {};
const field =
  "rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep";

/** Rebuilds days from the punches on record, leaving settled days alone. */
export function DeriveForm({ ar, from, to }: { ar: boolean; from: string; to: string }) {
  const [state, action, pending] = useActionState(deriveAction, empty);

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="from" value={from} />
      <input type="hidden" name="to" value={to} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-700 disabled:opacity-50"
      >
        {pending
          ? (ar ? "جارٍ…" : "Working…")
          : ar
            ? "أعِد حساب الأيام دي"
            : "Rebuild these days"}
      </button>
      {state.error && <p className="text-xs text-bad">{state.error}</p>}
      {state.success && <p className="text-xs text-good">{state.success}</p>}
    </form>
  );
}

/**
 * Sealing a month.
 *
 * Refused while anything is unresolved, which is the whole point: a lock over
 * days nobody has looked at is a formality, and payroll would then be built on
 * figures still being argued about.
 */
export function LockForm({
  ar,
  entityId,
  month,
  blocked,
}: {
  ar: boolean;
  entityId: string;
  month: string;
  blocked: number;
}) {
  const [state, action, pending] = useActionState(lockPeriodAction, empty);

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="entityId" value={entityId} />
      <div>
        <label className="mb-1 block text-xs text-ink-600" htmlFor="lock-month">
          {ar ? "الشهر" : "Month"}
        </label>
        <input
          id="lock-month"
          name="month"
          type="month"
          defaultValue={month}
          dir="ltr"
          className={`${field} num`}
        />
      </div>
      <button
        type="submit"
        disabled={pending || blocked > 0}
        title={
          blocked > 0
            ? ar
              ? "فيه أيام لسه محتاجة مراجعة"
              : "Days still need review"
            : undefined
        }
        className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? (ar ? "جارٍ…" : "Sealing…") : ar ? "اقفل الشهر" : "Lock the month"}
      </button>
      {blocked > 0 && (
        <p className="text-xs text-warn">
          {ar
            ? `${blocked} يوم لسه محتاج مراجعة قبل القفل.`
            : `${blocked} day(s) still need review before this can be locked.`}
        </p>
      )}
      {state.error && <p className="text-xs text-bad">{state.error}</p>}
      {state.success && <p className="text-xs text-good">{state.success}</p>}
    </form>
  );
}
