"use client";

import { useActionState } from "react";
import { createScheduledItemAction, stopScheduledItemAction } from "./actions";
import type { FormState } from "@/components/entity-form";
import type { Locale } from "@/lib/i18n";

const initial: FormState = {};
const field =
  "rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm text-ink-900 " +
  "focus:border-rose-deep focus:outline-none focus:ring-1 focus:ring-rose";
const label = "mb-1 block text-xs font-medium text-ink-600";

export function ScheduledItemForm({
  locale,
  entities,
  today,
}: {
  locale: Locale;
  entities: { id: string; label: string }[];
  today: string;
}) {
  const [state, formAction, pending] = useActionState(createScheduledItemAction, initial);
  const ar = locale === "ar";

  return (
    <form action={formAction} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className={label} htmlFor="si-name">{ar ? "الاسم" : "Name"}</label>
          <input
            id="si-name" name="nameEn" required
            placeholder={ar ? "إيجار المعرض" : "Showroom rent"}
            className={`${field} w-full`}
          />
        </div>
        <div>
          <label className={label} htmlFor="si-namear">{ar ? "بالعربي" : "In Arabic"}</label>
          <input id="si-namear" name="nameAr" className={`${field} w-full`} />
        </div>
        <div>
          <label className={label} htmlFor="si-entity">{ar ? "الكيان" : "Entity"}</label>
          <select id="si-entity" name="entityId" required className={`${field} w-full`}>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>{e.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div>
          <label className={label} htmlFor="si-dir">{ar ? "الاتجاه" : "Direction"}</label>
          <select id="si-dir" name="direction" className={`${field} w-full`}>
            <option value="OUTFLOW">{ar ? "خارج" : "Out"}</option>
            <option value="INFLOW">{ar ? "داخل" : "In"}</option>
          </select>
        </div>
        <div>
          <label className={label} htmlFor="si-amount">{ar ? "المبلغ" : "Amount"}</label>
          <input
            id="si-amount" name="amount" type="number" min="0.01" step="0.01" required
            dir="ltr" className={`${field} num w-full`}
          />
        </div>
        <div>
          <label className={label} htmlFor="si-freq">{ar ? "التكرار" : "Frequency"}</label>
          <select id="si-freq" name="frequency" defaultValue="MONTHLY" className={`${field} w-full`}>
            <option value="MONTHLY">{ar ? "شهري" : "Monthly"}</option>
            <option value="QUARTERLY">{ar ? "ربع سنوي" : "Quarterly"}</option>
            <option value="ANNUAL">{ar ? "سنوي" : "Annual"}</option>
            <option value="ONE_OFF">{ar ? "مرة واحدة" : "One-off"}</option>
          </select>
        </div>
        <div>
          <label className={label} htmlFor="si-day">{ar ? "يوم الشهر" : "Day of month"}</label>
          <input
            id="si-day" name="dayOfMonth" type="number" min="1" max="28" defaultValue={1} required
            dir="ltr" className={`${field} num w-full`}
          />
        </div>
        <div>
          <label className={label} htmlFor="si-start">{ar ? "يبدأ" : "Starts"}</label>
          <input
            id="si-start" name="startDate" type="date" required defaultValue={today}
            dir="ltr" className={`${field} w-full`}
          />
        </div>
        <div>
          <label className={label} htmlFor="si-end">{ar ? "ينتهي" : "Ends"}</label>
          <input id="si-end" name="endDate" type="date" dir="ltr" className={`${field} w-full`} />
        </div>
      </div>

      <p className="text-xs text-ink-500">
        {ar
          ? "اليوم محدود بـ٢٨ عشان البند الشهري مايفوّتش فبراير."
          : "The day is capped at 28 so a monthly item never skips February."}
      </p>

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
      >
        {pending ? "…" : ar ? "ضيفه للتوقعات" : "Add it to the forecast"}
      </button>

      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      {state.success && <p className="text-sm text-good">{state.success}</p>}
    </form>
  );
}

export function StopItemForm({ locale, itemId }: { locale: Locale; itemId: string }) {
  const [state, formAction, pending] = useActionState(stopScheduledItemAction, initial);
  const ar = locale === "ar";

  return (
    <form action={formAction}>
      <input type="hidden" name="itemId" value={itemId} />
      <button
        type="submit"
        disabled={pending}
        className="text-xs text-ink-400 hover:text-bad disabled:opacity-40"
      >
        {pending ? "…" : ar ? "أوقفه" : "Stop"}
      </button>
      {state.error && <span className="text-xs text-bad">{state.error}</span>}
    </form>
  );
}
