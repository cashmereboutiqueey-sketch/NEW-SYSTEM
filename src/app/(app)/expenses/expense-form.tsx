"use client";

import { useActionState } from "react";
import { createExpenseAction, type ActionState } from "./actions";
import type { Locale } from "@/lib/i18n";

type Option = { id: string; label: string };

const initial: ActionState = {};

const field =
  "w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm text-ink-900 " +
  "focus:border-rose-deep focus:outline-none focus:ring-1 focus:ring-rose";
const label = "mb-1 block text-xs font-medium text-ink-600";

export function ExpenseForm({
  locale,
  entities,
  categoriesByEntity,
  suppliers,
  costCenters,
  today,
}: {
  locale: Locale;
  entities: Option[];
  categoriesByEntity: Record<string, Option[]>;
  suppliers: Option[];
  costCenters: Option[];
  today: string;
}) {
  const [state, formAction, pending] = useActionState(createExpenseAction, initial);
  const ar = locale === "ar";

  return (
    <form action={formAction} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="entityId">
            {ar ? "الجهة" : "Entity"}
          </label>
          <select id="entityId" name="entityId" required className={field}>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>{e.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className={label} htmlFor="costCategoryId">
            {ar ? "بند التكلفة" : "Cost category"}
          </label>
          {/*
            Categories from both entities are listed together and grouped, but
            the server rejects a mismatched pair — a factory category on a
            brand expense would put the cost in the wrong books.
          */}
          <select id="costCategoryId" name="costCategoryId" required className={field}>
            {entities.map((e) => (
              <optgroup key={e.id} label={e.label}>
                {(categoriesByEntity[e.id] ?? []).map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className={label} htmlFor="description">
          {ar ? "الوصف" : "Description"}
        </label>
        <input
          id="description" name="description" required className={field}
          placeholder={ar ? "إيجار المصنع — أغسطس" : "Factory rent — August"}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className={label} htmlFor="amount">
            {ar ? "المبلغ (ج.م)" : "Amount (EGP)"}
          </label>
          <input
            id="amount" name="amount" type="number" step="0.01" min="0.01" required
            dir="ltr" className={`${field} num`}
          />
        </div>
        <div>
          <label className={label} htmlFor="incurredDate">
            {ar ? "تاريخ الاستحقاق الفعلي" : "Incurred date"}
          </label>
          <input
            id="incurredDate" name="incurredDate" type="date" required
            defaultValue={today} dir="ltr" className={field}
          />
        </div>
        <div>
          <label className={label} htmlFor="dueDate">
            {ar ? "تاريخ السداد" : "Due date"}
          </label>
          <input
            id="dueDate" name="dueDate" type="date" required
            defaultValue={today} dir="ltr" className={field}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className={label} htmlFor="supplierId">
            {ar ? "المورد" : "Supplier"}
          </label>
          <select id="supplierId" name="supplierId" className={field}>
            <option value="">{ar ? "— بدون —" : "— none —"}</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="costCenterId">
            {ar ? "مركز التكلفة" : "Cost centre"}
          </label>
          <select id="costCenterId" name="costCenterId" className={field}>
            <option value="">{ar ? "— بدون —" : "— none —"}</option>
            {costCenters.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="reference">
            {ar ? "رقم الفاتورة" : "Invoice reference"}
          </label>
          <input id="reference" name="reference" className={field} dir="ltr" />
        </div>
      </div>

      <p className="text-xs text-ink-500">
        {ar
          ? "يُسجَّل المصروف عند نشأته لا عند سداده، ويُرحَّل فورًا إلى دفتر الأستاذ."
          : "The cost is recognised when incurred, not when paid, and posts to the ledger immediately."}
      </p>

      {state.error && (
        <p role="alert" className="rounded-lg bg-bad/10 px-3 py-2 text-sm text-bad">
          {state.error}
        </p>
      )}
      {state.success && (
        <p role="status" className="rounded-lg bg-good/10 px-3 py-2 text-sm text-good">
          {state.success}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending
          ? (ar ? "جارٍ الترحيل…" : "Posting…")
          : (ar ? "تسجيل وترحيل" : "Record and post")}
      </button>
    </form>
  );
}
