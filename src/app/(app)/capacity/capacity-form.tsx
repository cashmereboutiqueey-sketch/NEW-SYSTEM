"use client";

import { useActionState, useState } from "react";
import { setCapacityAction } from "./actions";
import type { FormState } from "@/components/entity-form";
import type { Locale } from "@/lib/i18n";

const initial: FormState = {};
const field =
  "rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 " +
  "focus:border-ink-400 focus:outline-none focus:ring-1 focus:ring-ink-300";
const label = "mb-1 block text-xs font-medium text-ink-600";

/**
 * Setting what the factory has.
 *
 * The minutes are worked out live as the numbers are typed, because these five
 * fields decide what every garment costs and it should be obvious what they do
 * before the button is pressed rather than after.
 */
export function CapacityForm({
  locale,
  entityId,
  periods,
}: {
  locale: Locale;
  entityId: string;
  periods: {
    fiscalPeriodId: string;
    label: string;
    editable: boolean;
    operators: number | null;
    workingDays: string | null;
    hoursPerDay: string | null;
    utilisationRate: string | null;
    efficiencyRate: string | null;
  }[];
}) {
  const [state, formAction, pending] = useActionState(setCapacityAction, initial);
  const editable = periods.filter((p) => p.editable);
  const [periodId, setPeriodId] = useState(editable[0]?.fiscalPeriodId ?? "");
  const ar = locale === "ar";

  const current = periods.find((p) => p.fiscalPeriodId === periodId);

  const [operators, setOperators] = useState(String(current?.operators ?? 40));
  const [days, setDays] = useState(current?.workingDays ?? "26");
  const [hours, setHours] = useState(current?.hoursPerDay ?? "8");
  const [utilisation, setUtilisation] = useState(
    current?.utilisationRate ? (Number(current.utilisationRate) * 100).toFixed(1) : "60",
  );
  const [efficiency, setEfficiency] = useState(
    current?.efficiencyRate ? (Number(current.efficiencyRate) * 100).toFixed(1) : "80",
  );

  const gross = (Number(operators) || 0) * (Number(days) || 0) * (Number(hours) || 0) * 60;
  const productive = gross * ((Number(utilisation) || 0) / 100) * ((Number(efficiency) || 0) / 100);
  const idle = gross - productive;

  if (editable.length === 0) {
    return (
      <p className="py-4 text-sm text-ink-500">
        {ar
          ? "كل الشهور مقفولة. الشهر اللي تكلفة دقيقته مقفولة مايتغيّرش، عشان الأسعار اللي اتحسبت عليه ماتتغيّرش بأثر رجعي."
          : "Every period is locked. A period whose rate is sealed cannot be re-configured, or prices already calculated from it would change retroactively."}
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="entityId" value={entityId} />

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div>
          <label className={label} htmlFor="cap-period">{ar ? "الشهر" : "Month"}</label>
          <select
            id="cap-period"
            name="fiscalPeriodId"
            required
            value={periodId}
            onChange={(e) => setPeriodId(e.target.value)}
            className={`${field} w-full`}
          >
            {editable.map((p) => (
              <option key={p.fiscalPeriodId} value={p.fiscalPeriodId}>{p.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="cap-ops">{ar ? "عدد العمال" : "Operators"}</label>
          <input
            id="cap-ops" name="operators" type="number" min="1" step="1" required
            value={operators} onChange={(e) => setOperators(e.target.value)}
            dir="ltr" className={`${field} num w-full`}
          />
        </div>
        <div>
          <label className={label} htmlFor="cap-days">{ar ? "أيام العمل" : "Working days"}</label>
          <input
            id="cap-days" name="workingDays" type="number" min="1" max="31" step="0.5" required
            value={days} onChange={(e) => setDays(e.target.value)}
            dir="ltr" className={`${field} num w-full`}
          />
        </div>
        <div>
          <label className={label} htmlFor="cap-hours">{ar ? "ساعات اليوم" : "Hours per day"}</label>
          <input
            id="cap-hours" name="hoursPerDay" type="number" min="1" max="24" step="0.5" required
            value={hours} onChange={(e) => setHours(e.target.value)}
            dir="ltr" className={`${field} num w-full`}
          />
        </div>
        <div>
          <label className={label} htmlFor="cap-util">{ar ? "نسبة التشغيل %" : "Utilisation %"}</label>
          <input
            id="cap-util" name="utilisationRate" type="number" min="1" max="100" step="0.1" required
            value={utilisation} onChange={(e) => setUtilisation(e.target.value)}
            dir="ltr" className={`${field} num w-full`}
          />
        </div>
        <div>
          <label className={label} htmlFor="cap-eff">{ar ? "الكفاءة %" : "Efficiency %"}</label>
          <input
            id="cap-eff" name="efficiencyRate" type="number" min="1" max="100" step="0.1" required
            value={efficiency} onChange={(e) => setEfficiency(e.target.value)}
            dir="ltr" className={`${field} num w-full`}
          />
        </div>
      </div>

      <div className="rounded-lg border border-ink-200 bg-paper-50 p-3 text-sm">
        <div className="flex flex-wrap gap-x-6 gap-y-1">
          <span>
            {ar ? "دقائق متاحة" : "Available"}{" "}
            <span className="num font-medium">{gross.toLocaleString()}</span>
          </span>
          <span>
            {ar ? "دقائق منتجة" : "Productive"}{" "}
            <span className="num font-medium">{Math.round(productive).toLocaleString()}</span>
          </span>
          <span className={idle > 0 ? "text-bad" : ""}>
            {ar ? "عاطلة" : "Idle"}{" "}
            <span className="num font-medium">{Math.round(idle).toLocaleString()}</span>
          </span>
        </div>
        <p className="mt-2 text-xs text-ink-500">
          {ar
            ? "نسبة التشغيل والكفاءة بيتضربوا في بعض — ٦٠٪ × ٨٠٪ يعني ٤٨٪ من ساعات المصنع بتطلع إنتاج فعلي."
            : "Utilisation and efficiency multiply — 60% × 80% means 48% of the factory's paid hours turn into output."}
        </p>
      </div>

      <div>
        <label className={label} htmlFor="cap-notes">{ar ? "ملاحظة" : "Note"}</label>
        <input id="cap-notes" name="notes" className={`${field} w-full`} />
      </div>

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
      >
        {pending ? (ar ? "…" : "…") : ar ? "احفظ الطاقة" : "Save the capacity"}
      </button>

      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      {state.success && <p className="text-sm text-good">{state.success}</p>}
    </form>
  );
}
