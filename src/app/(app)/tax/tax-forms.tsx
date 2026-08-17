"use client";

import { useActionState, useState } from "react";
import { addTaxRateAction, setRegistrationAction } from "./actions";
import type { FormState } from "@/components/entity-form";

const empty: FormState = {};
const field =
  "w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm outline-none focus:border-ink-500";
const label = "mb-1 block text-xs font-medium text-ink-600";

/**
 * Recording a new rate.
 *
 * The rate is a fraction because that is how every rate in this system is
 * stored, and the form says so beside the box rather than after somebody has
 * typed 14 and created a 1,400% tax.
 */
export function RateForm({ ar, codes }: { ar: boolean; codes: string[] }) {
  const [state, action, pending] = useActionState(addTaxRateAction, empty);
  const [open, setOpen] = useState(false);
  const [rate, setRate] = useState("");

  const today = new Date().toISOString().slice(0, 10);
  const typed = rate === "" ? null : Number(rate);
  const looksLikePercent = typed !== null && typed > 1;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-ink-300 px-3 py-1.5 text-sm text-ink-700 hover:border-ink-500"
      >
        {ar ? "نسبة جديدة" : "New rate"}
      </button>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <label className={label} htmlFor="code">
            {ar ? "الكود" : "Code"}
          </label>
          <input
            id="code" name="code" required dir="ltr" className={field}
            list="tax-codes" placeholder="VAT-EG"
          />
          <datalist id="tax-codes">
            {codes.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <p className="mt-1 text-[11px] text-ink-400">
            {ar
              ? "نفس الكود = تغيير النسبة. كود جديد = ضريبة تانية."
              : "The same code changes the rate; a new code is a different tax."}
          </p>
        </div>

        <div>
          <label className={label} htmlFor="nameAr">
            {ar ? "الاسم" : "Name"}
          </label>
          <input id="nameAr" name="nameAr" required className={field} />
        </div>

        <div>
          <label className={label} htmlFor="rate">
            {ar ? "النسبة" : "Rate"}
          </label>
          <input
            id="rate" name="rate" type="number" step="0.001" min="0" max="1" required
            dir="ltr" className={`${field} num`} value={rate}
            onChange={(e) => setRate(e.target.value)}
            placeholder="0.14"
          />
          <p className={looksLikePercent ? "mt-1 text-[11px] text-bad" : "mt-1 text-[11px] text-ink-400"}>
            {looksLikePercent
              ? ar
                ? "دي كسر مش نسبة مئوية — ١٤٪ تتكتب ٠٫١٤."
                : "This is a fraction, not a percentage — 14% is 0.14."
              : ar
                ? "كسر: ٠٫١٤ يعني ١٤٪."
                : "A fraction: 0.14 means 14%."}
          </p>
        </div>

        <div>
          <label className={label} htmlFor="effectiveFrom">
            {ar ? "سارية من" : "In force from"}
          </label>
          <input
            id="effectiveFrom" name="effectiveFrom" type="date" required
            dir="ltr" className={`${field} num`} defaultValue={today}
          />
          <p className="mt-1 text-[11px] text-ink-400">
            {ar
              ? "النسبة القديمة هتتقفل اليوم اللي قبله. القيود القديمة مش هتتغيّر."
              : "The old rate ends the day before. Past postings keep theirs."}
          </p>
        </div>
      </div>

      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      {state.success && <p className="text-sm text-good">{state.success}</p>}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending || looksLikePercent}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {pending ? (ar ? "بتتسجل…" : "Recording…") : ar ? "سجّل النسبة" : "Record the rate"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg border border-ink-200 px-4 py-2 text-sm text-ink-600"
        >
          {ar ? "إلغاء" : "Cancel"}
        </button>
      </div>
    </form>
  );
}

/**
 * The switch.
 *
 * Turning it on is not a preference — it states that the business is now
 * registered and owes VAT on what it sells. The confirmation says exactly what
 * changes, because the consequence lands on every future sale.
 */
export function RegistrationForm({
  ar,
  registered,
  rateLabel,
}: {
  ar: boolean;
  registered: boolean;
  rateLabel: string;
}) {
  const [state, action, pending] = useActionState(setRegistrationAction, empty);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={
            registered
              ? "rounded-lg bg-good/10 px-3 py-1.5 text-sm text-good"
              : "rounded-lg bg-ink-100 px-3 py-1.5 text-sm text-ink-600"
          }
        >
          {registered
            ? ar ? `مسجّل — بيتحسب ${rateLabel}` : `Registered — charging ${rateLabel}`
            : ar ? "مش مسجّل — مفيش ضريبة بتتحسب" : "Not registered — no VAT is charged"}
        </span>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="rounded-lg border border-ink-300 px-3 py-1.5 text-sm text-ink-700 hover:border-ink-500"
        >
          {registered ? (ar ? "أوقف التسجيل" : "Turn off") : ar ? "فعّل التسجيل" : "Turn on"}
        </button>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="registered" value={registered ? "false" : "true"} />

      <div className="rounded-lg border border-warn/30 bg-warn/5 p-3 text-sm">
        {registered
          ? ar
            ? "هتوقف حساب الضريبة. المبيعات الجديدة مش هيتحسب عليها ضريبة، واللي اتسجل قبل كده هيفضل زي ما هو."
            : "VAT will stop being charged. New sales will carry none; everything already posted stays as it is."
          : ar
            ? `هتبدأ تحسب ${rateLabel} على المبيعات الجديدة. القيود القديمة مش هتتغيّر. اليوم ده هيتسجل في سجل التدقيق.`
            : `New sales will start carrying ${rateLabel}. Nothing already posted changes. This date goes into the audit trail.`}
      </div>

      <div>
        <label className={label} htmlFor="reason">
          {ar ? "السبب (اختياري)" : "Reason (optional)"}
        </label>
        <input
          id="reason" name="reason" className={field}
          placeholder={ar ? "التسجيل في مصلحة الضرائب" : "Registered with the tax authority"}
        />
      </div>

      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      {state.success && <p className="text-sm text-good">{state.success}</p>}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {pending
            ? ar ? "بيتغيّر…" : "Changing…"
            : registered
              ? ar ? "أوقف" : "Turn it off"
              : ar ? "فعّل" : "Turn it on"}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="rounded-lg border border-ink-200 px-4 py-2 text-sm text-ink-600"
        >
          {ar ? "إلغاء" : "Cancel"}
        </button>
      </div>
    </form>
  );
}
