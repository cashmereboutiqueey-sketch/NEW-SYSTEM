"use client";

import { useActionState, useState } from "react";
import { recordCountAction } from "./actions";
import type { FormState } from "@/components/entity-form";
import type { Locale } from "@/lib/i18n";

const initial: FormState = {};
const field =
  "rounded-lg border border-ink-200 bg-white px-2 py-1.5 text-sm text-ink-900 " +
  "focus:border-ink-400 focus:outline-none focus:ring-1 focus:ring-ink-300";

export type CountRow = {
  lotId: string;
  lotNumber: string;
  code: string;
  name: string;
  uom: string;
  onBooks: string;
  unitCost: string;
};

/**
 * Counting one shelf position.
 *
 * The counted figure starts blank rather than pre-filled with what the books
 * say. A box that already reads thirty gets confirmed without being opened,
 * and then the count is worth nothing.
 */
export function CountForm({
  locale,
  row,
  today,
  approvalLimit,
  approvers,
  mayApprove,
}: {
  locale: Locale;
  row: CountRow;
  today: string;
  approvalLimit: number;
  approvers: { id: string; name: string }[];
  mayApprove: boolean;
}) {
  const [state, formAction, pending] = useActionState(recordCountAction, initial);
  const [counted, setCounted] = useState("");
  const ar = locale === "ar";

  const books = Number(row.onBooks);
  const value = counted === "" ? null : Number(counted);
  const difference = value == null ? 0 : value - books;
  const worth = Math.abs(difference) * Number(row.unitCost);
  const needsApproval = worth > approvalLimit;

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="lotId" value={row.lotId} />
      <input type="hidden" name="countDate" value={today} />

      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="mb-1 block text-xs text-ink-500" htmlFor={`c-${row.lotId}`}>
            {ar ? "المعدود" : "Counted"}
          </label>
          <input
            id={`c-${row.lotId}`}
            name="countedQty"
            type="number"
            step="0.01"
            min="0"
            required
            value={counted}
            onChange={(e) => setCounted(e.target.value)}
            placeholder={ar ? "عُدّها" : "count it"}
            dir="ltr"
            className={`${field} num w-24`}
          />
        </div>

        <div className="min-w-40 flex-1">
          <label className="mb-1 block text-xs text-ink-500" htmlFor={`r-${row.lotId}`}>
            {ar ? "السبب" : "Reason"}
          </label>
          <input
            id={`r-${row.lotId}`}
            name="reason"
            required
            placeholder={ar ? "جرد شهري، تلف، سرقة…" : "monthly count, damage, theft…"}
            className={`${field} w-full`}
          />
        </div>

        {needsApproval && (
          <div>
            <label className="mb-1 block text-xs text-warn" htmlFor={`a-${row.lotId}`}>
              {ar ? "اعتماد" : "Approved by"}
            </label>
            <select
              id={`a-${row.lotId}`}
              name="approverUserId"
              required
              className={`${field} min-w-36`}
            >
              <option value="">{ar ? "اختر" : "Choose"}</option>
              {approvers.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
        )}

        <button
          type="submit"
          disabled={pending || counted === ""}
          className="rounded-lg bg-ink-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {pending ? "…" : ar ? "سجّل" : "Record"}
        </button>
      </div>

      {value != null && difference !== 0 && (
        <p className={difference < 0 ? "text-xs text-bad" : "text-xs text-warn"}>
          {ar
            ? `${difference < 0 ? "ناقص" : "زيادة"} ${Math.abs(difference)} ${row.uom} — بقيمة ${worth.toFixed(2)}`
            : `${difference < 0 ? "Short" : "Over"} by ${Math.abs(difference)} ${row.uom} — worth ${worth.toFixed(2)}`}
          {needsApproval &&
            (ar
              ? ` · فوق حد ${approvalLimit} فمحتاج اعتماد شخص تاني`
              : ` · over the ${approvalLimit} limit, so it needs a second person`)}
        </p>
      )}

      {value != null && difference === 0 && (
        <p className="text-xs text-good">
          {ar ? "مطابق للدفاتر." : "Agrees with the books."}
        </p>
      )}

      {needsApproval && !mayApprove && (
        <p className="text-xs text-ink-400">
          {ar
            ? "إنت مش من صلاحياتك تعتمد فرق بالحجم ده — لازم حد تاني."
            : "Approving a difference this size is not yours to do — it needs someone else."}
        </p>
      )}

      {state.error && <p className="text-xs text-bad">{state.error}</p>}
      {state.success && <p className="text-xs text-good">{state.success}</p>}
    </form>
  );
}
