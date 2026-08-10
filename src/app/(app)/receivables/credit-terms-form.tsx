"use client";

import { useActionState, useState } from "react";
import { setCreditTermsAction, type ReceivableState } from "./actions";

const empty: ReceivableState = {};

export function CreditTermsForm({
  customerId,
  customerName,
  creditLimit,
  creditDays,
  ar,
}: {
  customerId: string;
  customerName: string;
  creditLimit: string;
  creditDays: number;
  ar: boolean;
}) {
  const [state, action, pending] = useActionState(setCreditTermsAction, empty);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-ink-500 underline"
      >
        {ar ? "الحد" : "Limit"}
      </button>
    );
  }

  return (
    <form action={action} className="min-w-[16rem] rounded-lg border border-ink-200 bg-white p-3">
      <p className="mb-2 text-xs font-medium text-ink-700">
        {ar ? `حد ${customerName}` : `${customerName}'s limit`}
      </p>

      <input type="hidden" name="customerId" value={customerId} />

      <div className="mb-2 grid grid-cols-2 gap-2">
        <label className="block text-xs">
          <span className="mb-1 block text-ink-500">{ar ? "أقصى دين" : "Credit limit"}</span>
          <input
            name="creditLimit"
            type="number"
            step="0.01"
            min="0"
            defaultValue={Number(creditLimit).toFixed(2)}
            dir="ltr"
            className="w-full rounded-lg border border-ink-200 px-2 py-1.5 text-end text-sm outline-none focus:border-ink-500"
          />
        </label>

        <label className="block text-xs">
          <span className="mb-1 block text-ink-500">{ar ? "أجل (يوم)" : "Terms (days)"}</span>
          <input
            name="creditDays"
            type="number"
            step="1"
            min="0"
            defaultValue={creditDays}
            dir="ltr"
            className="w-full rounded-lg border border-ink-200 px-2 py-1.5 text-end text-sm outline-none focus:border-ink-500"
          />
        </label>
      </div>

      <p className="mb-2 text-[11px] text-ink-400">
        {ar
          ? "صفر معناه مفيش آجل خالص."
          : "Zero means no credit at all."}
      </p>

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-ink-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {ar ? "احفظ" : "Save"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-ink-500">
          {ar ? "إلغاء" : "Cancel"}
        </button>
      </div>

      {state.error && <p className="mt-2 text-xs text-bad">{state.error}</p>}
      {state.success && <p className="mt-2 text-xs text-good">{state.success}</p>}
    </form>
  );
}
