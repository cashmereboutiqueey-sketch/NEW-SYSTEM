"use client";

import { useActionState, useState } from "react";
import { payExpenseAction } from "./actions";
import type { FormState } from "@/components/entity-form";

const empty: FormState = {};
const small =
  "w-full rounded-lg border border-ink-200 bg-panel px-2 py-1.5 text-sm outline-none focus:border-rose-deep";

/**
 * Paying an expense.
 *
 * The action existed from the start and nothing on any screen called it, so
 * an expense could be recorded and never settled — which is how a payables
 * report fills up with things that were paid in cash months ago.
 *
 * How it was paid is asked because the account alone does not answer it.
 * InstaPay, a company card and a manual transfer all leave the same bank
 * account, and telling them apart is the difference between a bank statement
 * that reconciles line by line and one that has to be guessed at.
 */
export function PayForm({
  ar,
  expenseId,
  description,
  outstanding,
}: {
  ar: boolean;
  expenseId: string;
  description: string;
  outstanding: number;
}) {
  const [state, action, pending] = useActionState(payExpenseAction, empty);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(outstanding.toFixed(2));

  const today = new Date().toISOString().slice(0, 10);
  const typed = amount === "" ? 0 : Number(amount);
  const tooMuch = typed > outstanding;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-ink-300 px-2.5 py-1 text-xs font-medium text-ink-700"
      >
        {ar ? "ادفع" : "Pay"}
      </button>
    );
  }

  return (
    <form action={action} className="min-w-[15rem] space-y-2">
      <input type="hidden" name="expenseId" value={expenseId} />
      <input type="hidden" name="paidDate" value={today} />

      <p className="text-xs text-ink-600">
        {description}
        <span className="ms-2 num font-medium">{outstanding.toFixed(2)}</span>
      </p>

      <input
        name="amount"
        type="number"
        step="0.01"
        min="0"
        max={outstanding}
        required
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        dir="ltr"
        className={`${small} text-end`}
      />

      <label className="block text-xs">
        <span className="mb-1 block text-ink-500">
          {ar ? "طلعت منين" : "Paid from"}
        </span>
        <select name="method" className={small} defaultValue="INSTAPAY">
          <option value="INSTAPAY">{ar ? "إنستاباي" : "InstaPay"}</option>
          <option value="BANK_TRANSFER">{ar ? "تحويل بنكي" : "Bank transfer"}</option>
          <option value="CARD">{ar ? "فيزا" : "Card"}</option>
          <option value="CASH">{ar ? "كاش" : "Cash"}</option>
        </select>
      </label>

      <input
        name="reference"
        placeholder={ar ? "رقم العملية (اختياري)" : "Reference (optional)"}
        className={small}
      />

      <p className="text-[11px] text-ink-400">
        {ar
          ? "الكاش بيطلع من الخزينة، والباقي كله من البنك — بس الطريقة بتتسجّل عشان تظبط كشف الحساب."
          : "Cash leaves the box, everything else the bank — the method is recorded so a statement reconciles."}
      </p>

      {tooMuch && (
        <p className="text-xs text-bad">
          {ar
            ? `الباقي على المصروف ده ${outstanding.toFixed(2)} بس.`
            : `Only ${outstanding.toFixed(2)} is outstanding.`}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending || tooMuch || typed <= 0}
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
