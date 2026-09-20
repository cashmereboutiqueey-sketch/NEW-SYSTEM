"use client";

import { useActionState, useState } from "react";
import { createShiftAction, assignShiftAction } from "../actions";
import type { FormState } from "@/components/entity-form";

const empty: FormState = {};
const field =
  "rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep";
const label = "mb-1 block text-xs text-ink-600";

/** Sunday first, because that is where the week starts here. */
const DAYS: { value: number; ar: string; en: string }[] = [
  { value: 0, ar: "الأحد", en: "Sun" },
  { value: 1, ar: "الاثنين", en: "Mon" },
  { value: 2, ar: "الثلاثاء", en: "Tue" },
  { value: 3, ar: "الأربعاء", en: "Wed" },
  { value: 4, ar: "الخميس", en: "Thu" },
  { value: 5, ar: "الجمعة", en: "Fri" },
  { value: 6, ar: "السبت", en: "Sat" },
];

/**
 * A working pattern.
 *
 * Whether it crosses midnight is ticked, never guessed: a shift from 20:00 to
 * 04:00 and one from 09:00 to 09:00 look identical to arithmetic and differ by
 * a whole day of somebody's pay.
 */
export function ShiftForm({ ar, lines }: { ar: boolean; lines: { id: string; label: string }[] }) {
  const [state, action, pending] = useActionState(createShiftAction, empty);
  const [overnight, setOvernight] = useState(false);

  return (
    <form action={action} className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className={label} htmlFor="s-code">{ar ? "الكود" : "Code"}</label>
          <input id="s-code" name="code" required dir="ltr" className={`${field} w-28`} />
        </div>
        <div>
          <label className={label} htmlFor="s-en">{ar ? "الاسم (إنجليزي)" : "Name (English)"}</label>
          <input id="s-en" name="nameEn" required className={`${field} w-40`} />
        </div>
        <div>
          <label className={label} htmlFor="s-ar">{ar ? "الاسم (عربي)" : "Name (Arabic)"}</label>
          <input id="s-ar" name="nameAr" required className={`${field} w-40`} />
        </div>
        <div>
          <label className={label} htmlFor="s-start">{ar ? "من" : "Starts"}</label>
          <input id="s-start" name="start" type="time" required defaultValue="09:00" dir="ltr" className={`${field} num`} />
        </div>
        <div>
          <label className={label} htmlFor="s-end">{ar ? "إلى" : "Ends"}</label>
          <input id="s-end" name="end" type="time" required defaultValue="17:00" dir="ltr" className={`${field} num`} />
        </div>
        <label className="flex items-center gap-2 self-center text-sm">
          <input
            type="checkbox"
            name="crossesMidnight"
            checked={overnight}
            onChange={(e) => setOvernight(e.target.checked)}
            className="h-4 w-4 rounded border-ink-300"
          />
          <span>{ar ? "بتعدّي نص الليل" : "Crosses midnight"}</span>
        </label>
      </div>

      <div>
        <p className={label}>{ar ? "أيام الشغل" : "Working days"}</p>
        <div className="flex flex-wrap gap-2">
          {DAYS.map((d) => (
            <label key={d.value} className="flex items-center gap-1 rounded-lg border border-ink-200 px-2 py-1 text-xs">
              <input
                type="checkbox"
                name="workingDays"
                value={d.value}
                defaultChecked={d.value <= 4}
                className="h-3.5 w-3.5 rounded border-ink-300"
              />
              <span>{ar ? d.ar : d.en}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className={label} htmlFor="s-break">{ar ? "راحة (دقيقة)" : "Break (minutes)"}</label>
          <input id="s-break" name="breakMinutes" type="number" min="0" defaultValue={30} dir="ltr" className={`${field} num w-24`} />
        </div>
        <label className="flex items-center gap-2 self-center text-sm">
          <input type="checkbox" name="breakPaid" className="h-4 w-4 rounded border-ink-300" />
          <span>{ar ? "الراحة مدفوعة" : "Break is paid"}</span>
        </label>
        <div>
          <label className={label} htmlFor="s-grace">{ar ? "سماح التأخير" : "Grace (minutes)"}</label>
          <input id="s-grace" name="graceMinutes" type="number" min="0" defaultValue={10} dir="ltr" className={`${field} num w-24`} />
        </div>
        <div>
          <label className={label} htmlFor="s-ot">{ar ? "الإضافي بعد (دقيقة)" : "Overtime after (minutes)"}</label>
          <input id="s-ot" name="overtimeAfterMinutes" type="number" min="0" defaultValue={480} dir="ltr" className={`${field} num w-28`} />
        </div>
        <div>
          <label className={label} htmlFor="s-dept">{ar ? "القسم (اختياري)" : "Department (optional)"}</label>
          <input id="s-dept" name="department" className={`${field} w-36`} />
        </div>
        <div>
          <label className={label} htmlFor="s-line">{ar ? "خط الإنتاج (اختياري)" : "Line (optional)"}</label>
          <select id="s-line" name="lineId" defaultValue="" className={`${field} w-40`}>
            <option value="">{ar ? "— الكل —" : "— any —"}</option>
            {lines.map((l) => (
              <option key={l.id} value={l.id}>{l.label}</option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={pending} className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
          {pending ? (ar ? "جارٍ…" : "Saving…") : ar ? "أضف الوردية" : "Add the shift"}
        </button>
      </div>

      <p className="text-xs text-ink-500">
        {ar
          ? "الراحة غير المدفوعة بتتخصم من وقت الشغل. السماح بيحدد إذا كان التأخير يتحسب أصلاً، مش قد إيه يتحسب."
          : "An unpaid break comes off the worked time. Grace decides whether lateness counts at all, not how much of it counts."}
      </p>

      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      {state.success && <p className="text-sm text-good">{state.success}</p>}
    </form>
  );
}

/** Puts somebody on a shift from a date, leaving earlier months as they were. */
export function AssignForm({
  ar,
  employees,
  shifts,
  today,
}: {
  ar: boolean;
  employees: { id: string; label: string }[];
  shifts: { id: string; label: string }[];
  today: string;
}) {
  const [state, action, pending] = useActionState(assignShiftAction, empty);

  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <div>
        <label className={label} htmlFor="a-emp">{ar ? "الموظف" : "Employee"}</label>
        <select id="a-emp" name="employeeId" required defaultValue="" className={`${field} min-w-52`}>
          <option value="" disabled>{ar ? "اختار" : "Choose"}</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>{e.label}</option>
          ))}
        </select>
      </div>
      <div>
        <label className={label} htmlFor="a-shift">{ar ? "الوردية" : "Shift"}</label>
        <select id="a-shift" name="shiftId" required defaultValue="" className={`${field} min-w-44`}>
          <option value="" disabled>{ar ? "اختار" : "Choose"}</option>
          {shifts.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
      </div>
      <div>
        <label className={label} htmlFor="a-from">{ar ? "من تاريخ" : "From"}</label>
        <input id="a-from" name="effectiveFrom" type="date" required defaultValue={today} dir="ltr" className={field} />
      </div>
      <button type="submit" disabled={pending} className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
        {pending ? (ar ? "جارٍ…" : "Saving…") : ar ? "عيّن" : "Assign"}
      </button>
      {state.error && <p className="w-full text-sm text-bad">{state.error}</p>}
      {state.success && <p className="w-full text-sm text-good">{state.success}</p>}
    </form>
  );
}
