"use client";

import { useActionState } from "react";
import { createSnapshotAction, type ActionState } from "./actions";
import type { Locale } from "@/lib/i18n";

const initial: ActionState = {};

const field =
  "w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 " +
  "focus:border-ink-400 focus:outline-none focus:ring-1 focus:ring-ink-300";
const label = "mb-1 block text-xs font-medium text-ink-600";

export function SnapshotForm({
  locale,
  styleId,
  minuteRatePeriodId,
  defaultMarginPct,
  canOverrideMargin,
}: {
  locale: Locale;
  styleId: string;
  minuteRatePeriodId: string;
  defaultMarginPct: string;
  canOverrideMargin: boolean;
}) {
  const [state, formAction, pending] = useActionState(createSnapshotAction, initial);
  const ar = locale === "ar";

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="styleId" value={styleId} />
      <input type="hidden" name="minuteRatePeriodId" value={minuteRatePeriodId} />

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="reason">
            {ar ? "سبب التسعير" : "Reason"}
          </label>
          <input
            id="reason" name="reason" className={field}
            placeholder={ar ? "تسعير أمر إنتاج أغسطس" : "Costing for the August run"}
          />
        </div>
        {canOverrideMargin && (
          <div>
            <label className={label} htmlFor="factoryMarginPct">
              {ar ? "هامش مختلف (اختياري)" : "Override margin (optional)"}
            </label>
            <input
              id="factoryMarginPct" name="factoryMarginPct" type="number"
              step="0.01" min="0" max="1" dir="ltr" className={`${field} num`}
              placeholder={defaultMarginPct}
            />
          </div>
        )}
      </div>

      {canOverrideMargin && (
        <div>
          <label className={label} htmlFor="approvalNote">
            {ar
              ? "مبرر الاعتماد (مطلوب إذا كان الهامش تحت الحد الأدنى)"
              : "Approval note (required if the margin is below the floor)"}
          </label>
          <input id="approvalNote" name="approvalNote" className={field} />
        </div>
      )}

      <p className="text-xs text-ink-500">
        {ar
          ? "التجميد يحفظ كل الأسعار وتكلفة الدقيقة والهدر وقت التسعير. تغيير سعر خامة لاحقًا ينشئ لقطة جديدة ولا يمس القديمة."
          : "Freezing stores every price, the minute rate and the waste rate as they are now. A later price change creates a new snapshot and never touches this one."}
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
        {pending
          ? (ar ? "جارٍ التجميد…" : "Freezing…")
          : (ar ? "تجميد التكلفة وسعر التحويل" : "Freeze cost and transfer price")}
      </button>
    </form>
  );
}
