"use client";

import { useActionState } from "react";
import {
  calculateMinuteRateAction,
  lockMinuteRateAction,
  type ActionState,
} from "./actions";
import type { Locale } from "@/lib/i18n";

const initial: ActionState = {};

const field =
  "w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm text-ink-900 " +
  "focus:border-rose-deep focus:outline-none focus:ring-1 focus:ring-rose";
const label = "mb-1 block text-xs font-medium text-ink-600";

export function CalculateForm({
  locale,
  entityId,
  periods,
}: {
  locale: Locale;
  entityId: string;
  periods: { id: string; label: string }[];
}) {
  const [state, formAction, pending] = useActionState(calculateMinuteRateAction, initial);
  const ar = locale === "ar";

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="entityId" value={entityId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="fiscalPeriodId">
            {ar ? "الشهر" : "Period"}
          </label>
          <select id="fiscalPeriodId" name="fiscalPeriodId" required className={field}>
            {periods.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="cmtRevenueCredit">
            {ar ? "إيراد تصنيع للغير (خصم من التكلفة)" : "External CMT revenue credit"}
          </label>
          <input
            id="cmtRevenueCredit" name="cmtRevenueCredit" type="number" step="0.01" min="0"
            defaultValue="0" dir="ltr" className={`${field} num`}
          />
        </div>
      </div>

      <p className="text-xs text-ink-500">
        {ar
          ? "يُقرأ مجمع التكلفة من دفتر الأستاذ — الحسابات المعلّمة بأنها من تكلفة التشغيل فقط. الخامات والفوائد مستبعدة."
          : "The cost pool is read from the ledger — only accounts flagged as conversion cost. Materials and finance costs are excluded."}
      </p>

      {state.error && (
        <p role="alert" className="rounded-lg bg-bad/10 px-3 py-2 text-sm text-bad">{state.error}</p>
      )}
      {state.success && (
        <p role="status" className="rounded-lg bg-good/10 px-3 py-2 text-sm text-good">{state.success}</p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? (ar ? "جارٍ الحساب…" : "Calculating…") : (ar ? "احسب تكلفة الدقيقة" : "Calculate minute rate")}
      </button>
    </form>
  );
}

export function LockForm({
  locale,
  minuteRatePeriodId,
}: {
  locale: Locale;
  minuteRatePeriodId: string;
}) {
  const [state, formAction, pending] = useActionState(lockMinuteRateAction, initial);
  const ar = locale === "ar";

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="minuteRatePeriodId" value={minuteRatePeriodId} />
      {state.error && (
        <p role="alert" className="rounded-lg bg-bad/10 px-3 py-2 text-sm text-bad">{state.error}</p>
      )}
      {state.success && (
        <p role="status" className="rounded-lg bg-good/10 px-3 py-2 text-sm text-good">{state.success}</p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg border border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-700 disabled:opacity-50"
      >
        {pending
          ? (ar ? "جارٍ القفل…" : "Locking…")
          : (ar ? "إقفال الشهر نهائيًا" : "Lock this period permanently")}
      </button>
    </form>
  );
}
