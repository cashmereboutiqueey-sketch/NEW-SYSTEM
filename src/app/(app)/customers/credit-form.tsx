"use client";

import { useActionState, useState } from "react";
import { setCustomerCreditAction } from "./actions";
import type { FormState } from "@/components/entity-form";
import type { Locale } from "@/lib/i18n";

const empty: FormState = {};

/**
 * What a customer may owe, and for how long.
 *
 * The rule that a part-paid sale needs a limit behind it was already enforced
 * at the till; the limit itself could be set nowhere, so every customer stood
 * at zero and every deposit was refused. This is the missing half.
 *
 * The customer's current figures load with the choice, so raising a limit
 * starts from what it is rather than from a blank box that silently means nil.
 */
export function CreditForm({
  locale,
  customers,
}: {
  locale: Locale;
  customers: { id: string; label: string; creditLimit: string; creditDays: number }[];
}) {
  const [state, action, pending] = useActionState(setCustomerCreditAction, empty);
  const [customerId, setCustomerId] = useState(customers[0]?.id ?? "");
  const ar = locale === "ar";

  const chosen = customers.find((c) => c.id === customerId);
  const field =
    "rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-ink-900";

  return (
    <form action={action} className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-xs text-ink-600" htmlFor="credit-customer">
            {ar ? "العميل" : "Customer"}
          </label>
          <select
            id="credit-customer"
            name="customerId"
            required
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            className={`${field} min-w-64`}
          >
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-xs text-ink-600" htmlFor="credit-limit">
            {ar ? "أقصى مبلغ عليه" : "Most they may owe"}
          </label>
          <input
            id="credit-limit"
            name="creditLimit"
            type="number"
            step="0.01"
            min="0"
            required
            // Keyed on the customer, so choosing another loads theirs instead
            // of leaving the last one's figure in the box.
            key={`l-${customerId}`}
            defaultValue={chosen?.creditLimit ?? "0"}
            dir="ltr"
            className={`${field} num w-36`}
          />
        </div>

        <div>
          <label className="mb-1 block text-xs text-ink-600" htmlFor="credit-days">
            {ar ? "مدة السداد (يوم)" : "Days to pay"}
          </label>
          <input
            id="credit-days"
            name="creditDays"
            type="number"
            step="1"
            min="0"
            required
            key={`d-${customerId}`}
            defaultValue={String(chosen?.creditDays ?? 0)}
            dir="ltr"
            className={`${field} num w-28`}
          />
        </div>

        <button
          type="submit"
          disabled={pending || !customerId}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? (ar ? "جارٍ…" : "Saving…") : ar ? "احفظ الحد" : "Save the limit"}
        </button>
      </div>

      <p className="text-xs text-ink-500">
        {ar
          ? "صفر معناه كاش بالكامل — أي مبلغ ناقص هيترفض. المدة دي اللي بيتحسب عليها التأخير في تقرير الذمم."
          : "Zero means cash in full — any short payment is refused. The days decide when the receivables report calls it late."}
      </p>

      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      {state.success && <p className="text-sm text-good">{state.success}</p>}
    </form>
  );
}
