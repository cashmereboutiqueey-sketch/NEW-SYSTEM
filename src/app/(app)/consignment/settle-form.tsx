"use client";

import { useActionState, useState } from "react";
import { settleConsignorAction, type ConsignmentState } from "./actions";

const empty: ConsignmentState = {};
const small =
  "w-full rounded-lg border border-ink-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-ink-500";

/**
 * Handing a consignor the money the shop has been holding for them.
 *
 * Whole sales only, oldest first. Paying an arbitrary part would leave a sale
 * half-settled with no way to say which half, and the next conversation about
 * what is still owed would have no document behind it.
 */
export function SettleForm({
  ar,
  consignorId,
  name,
  owed,
}: {
  ar: boolean;
  consignorId: string;
  name: string;
  owed: string;
}) {
  const [state, action, pending] = useActionState(settleConsignorAction, empty);
  const [open, setOpen] = useState(false);
  const today = new Date().toISOString().slice(0, 10);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-ink-300 px-2.5 py-1 text-xs font-medium text-ink-700"
      >
        {ar ? "ادفعله" : "Pay them"}
      </button>
    );
  }

  return (
    <form action={action} className="min-w-[14rem] space-y-2">
      <input type="hidden" name="consignorId" value={consignorId} />
      <input type="hidden" name="paidOn" value={today} />

      <p className="text-xs text-ink-600">
        {ar ? `مستحق لـ ${name}: ` : `Owed to ${name}: `}
        <span className="num font-medium">{Number(owed).toFixed(2)}</span>
      </p>

      <input
        name="amount"
        type="number"
        step="0.01"
        min="0"
        max={Number(owed)}
        placeholder={ar ? "سيبها فاضية تدفع الكل" : "Blank pays it all"}
        dir="ltr"
        className={`${small} text-end`}
      />

      <select name="method" className={small}>
        <option value="CASH">{ar ? "كاش" : "Cash"}</option>
        <option value="BANK_TRANSFER">{ar ? "تحويل" : "Transfer"}</option>
        <option value="INSTAPAY">{ar ? "إنستاباي" : "InstaPay"}</option>
      </select>

      <input name="reference" placeholder={ar ? "مرجع" : "Reference"} className={small} />

      <p className="text-[11px] text-ink-400">
        {ar
          ? "الدفع بيغطي بيعات كاملة، الأقدم الأول."
          : "Settles whole sales, oldest first."}
      </p>

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-ink-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {pending ? "…" : ar ? "ادفع" : "Pay"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-ink-500">
          {ar ? "رجوع" : "Back"}
        </button>
      </div>

      {state.error && <p className="text-xs text-bad">{state.error}</p>}
      {state.success && <p className="text-xs text-good">{state.success}</p>}
    </form>
  );
}
