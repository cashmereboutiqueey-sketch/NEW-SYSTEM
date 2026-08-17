"use client";

import { useActionState, useState } from "react";
import { reverseEntryAction } from "./actions";
import type { FormState } from "@/components/entity-form";

const empty: FormState = {};

/**
 * Reversing a posting.
 *
 * The reason is required and is not a dropdown. "Correction" tells whoever
 * reads the books in a year exactly nothing; the sentence somebody had to type
 * is the only part of a reversal that carries any information, and it goes
 * into the audit trail permanently.
 *
 * The button says what will happen rather than asking for confirmation of
 * something vague. Nothing is deleted here — a mirror entry is posted beside
 * the original, and both stay in the books.
 */
export function ReverseForm({
  ar,
  entryId,
  entryNumber,
  amount,
}: {
  ar: boolean;
  entryId: string;
  entryNumber: string;
  amount: string;
}) {
  const [state, action, pending] = useActionState(reverseEntryAction, empty);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  const tooShort = reason.trim().length < 10;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-ink-300 px-2.5 py-1 text-xs font-medium text-ink-700 hover:border-ink-500"
      >
        {ar ? "اعكس" : "Reverse"}
      </button>
    );
  }

  return (
    <form action={action} className="min-w-[20rem] space-y-2">
      <input type="hidden" name="entryId" value={entryId} />

      <p className="text-xs text-ink-600">
        {ar
          ? `هيتعمل قيد عكسي بـ ${amount} قصاد ${entryNumber}. الأصلي مش هيتمسح ولا هيتعدّل — الاتنين هيفضلوا في الدفاتر.`
          : `A mirror entry for ${amount} will be posted against ${entryNumber}. The original is neither deleted nor edited — both stay in the books.`}
      </p>

      <div>
        <label className="mb-1 block text-xs font-medium text-ink-600" htmlFor={`reason-${entryId}`}>
          {ar ? "السبب" : "Why"}
        </label>
        <textarea
          id={`reason-${entryId}`}
          name="reason"
          rows={2}
          required
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={
            ar
              ? "الكمية اتسجلت غلط، الفاتورة كانت ٨٠ متر مش ١٠٠"
              : "The quantity was recorded wrong; the invoice was 80 metres, not 100"
          }
          className="w-full rounded-lg border border-ink-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-ink-500"
        />
        <p className="mt-1 text-[11px] text-ink-400">
          {ar
            ? "بيتسجل في سجل التدقيق للأبد. «تصحيح» مش سبب."
            : "This goes into the audit trail permanently. \"Correction\" is not a reason."}
        </p>
      </div>

      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      {state.success && <p className="text-sm text-good">{state.success}</p>}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending || tooShort}
          className="rounded-lg bg-ink-900 px-3 py-1.5 text-xs text-white disabled:opacity-50"
        >
          {pending ? (ar ? "بيتعكس…" : "Reversing…") : ar ? "اعكس القيد" : "Post the reversal"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg border border-ink-200 px-3 py-1.5 text-xs text-ink-600"
        >
          {ar ? "إلغاء" : "Cancel"}
        </button>
      </div>
    </form>
  );
}
