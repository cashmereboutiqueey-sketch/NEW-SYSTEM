"use client";

import { useActionState, useState } from "react";
import { cairoDateKey } from "@/lib/cairo-date";
import { RequestIdField } from "@/components/request-id";
import { createSupplierOpeningAction } from "./actions";

const field = "w-full rounded-lg border border-ink-200 bg-panel px-2 py-1.5 text-sm outline-none focus:border-rose-deep";

export function SupplierOpeningBalanceForm({
  ar, suppliers, entities,
}: {
  ar: boolean;
  suppliers: { id: string; name: string }[];
  entities: { id: string; name: string }[];
}) {
  const [state, action, pending] = useActionState(createSupplierOpeningAction, {});
  const [asOfDate, setAsOfDate] = useState(cairoDateKey());
  const [dueDate, setDueDate] = useState(cairoDateKey());

  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <RequestIdField state={state} />
      <label className="text-xs text-ink-600">
        {ar ? "المورد" : "Supplier"}
        <select name="supplierId" required className={`${field} mt-1`}>
          <option value="">{ar ? "اختار المورد" : "Choose supplier"}</option>
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      <label className="text-xs text-ink-600">
        {ar ? "الشركة اللي عليها المبلغ" : "Company owing the amount"}
        <select name="entityId" required className={`${field} mt-1`}>
          <option value="">{ar ? "اختار الشركة" : "Choose company"}</option>
          {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      </label>
      <label className="text-xs text-ink-600">
        {ar ? "المبلغ المستحق حاليًا" : "Amount owed now"}
        <input name="amount" type="number" min="0.01" step="0.01" required
          dir="ltr" className={`${field} mt-1 text-end`} />
      </label>
      <label className="text-xs text-ink-600">
        {ar ? "تاريخ تسجيل الرصيد" : "Balance date"}
        <input name="asOfDate" type="date" required value={asOfDate}
          onChange={(e) => setAsOfDate(e.target.value)} className={`${field} mt-1`} />
      </label>
      <label className="text-xs text-ink-600">
        {ar ? "تاريخ الاستحقاق" : "Due date"}
        <input name="dueDate" type="date" required value={dueDate}
          onChange={(e) => setDueDate(e.target.value)} className={`${field} mt-1`} />
      </label>
      <label className="text-xs text-ink-600">
        {ar ? "ملاحظة (اختياري)" : "Note (optional)"}
        <input name="note" className={`${field} mt-1`} />
      </label>
      <div className="sm:col-span-2 lg:col-span-3">
        <p className="mb-2 text-xs text-ink-500">
          {ar
            ? "سجّل الدين القديم غير المسجل في فواتير أو استلامات النظام مرة واحدة لكل مورد وشركة. الرصيد ده مش بيضيف قماش ولا مصروف جديد."
            : "Record old debt that has no invoice or receipt in this system, once per supplier and company. This adds neither stock nor a new expense."}
        </p>
        <button type="submit" disabled={pending || !suppliers.length}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
          {pending ? "…" : ar ? "سجّل الرصيد الافتتاحي" : "Record opening balance"}
        </button>
        {state.error && <p className="mt-2 text-xs text-bad">{state.error}</p>}
        {state.success && <p className="mt-2 text-xs text-good">{state.success}</p>}
      </div>
    </form>
  );
}
