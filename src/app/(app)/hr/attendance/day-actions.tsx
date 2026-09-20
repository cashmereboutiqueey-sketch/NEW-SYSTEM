"use client";

import { useActionState, useState } from "react";
import {
  correctDayAction,
  reviewDayAction,
  decideOvertimeAction,
  linkBadgeAction,
} from "./actions";
import type { FormState } from "@/components/entity-form";

const empty: FormState = {};

const field =
  "rounded-lg border border-ink-200 bg-panel px-2 py-1.5 text-xs outline-none focus:border-rose-deep";
const primary =
  "rounded-lg bg-ink-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50";
const quiet = "rounded-lg border border-ink-200 px-3 py-1.5 text-xs text-ink-700";

/**
 * What a person can do about one day.
 *
 * Every one of these takes a reason before it takes effect. The day is a
 * judgement and the punches are evidence: the judgement can change as often as
 * the facts require, and each change says who made it and why.
 *
 * The forms open on demand rather than sitting in every row — an inbox of
 * sixty days with four open forms each is a screen nobody can read.
 */
export function DayActions({
  ar,
  dayId,
  status,
  locked,
  overtimeCandidate,
  mayCorrect,
  mayReview,
  mayApproveOvertime,
  mayLock,
}: {
  ar: boolean;
  dayId: string;
  status: string;
  locked: boolean;
  overtimeCandidate: number;
  mayCorrect: boolean;
  mayReview: boolean;
  mayApproveOvertime: boolean;
  mayLock: boolean;
}) {
  const [open, setOpen] = useState<null | "correct" | "overtime">(null);
  const [correctState, correct, correcting] = useActionState(correctDayAction, empty);
  const [reviewState, review, reviewing] = useActionState(reviewDayAction, empty);
  const [otState, decideOvertime, deciding] = useActionState(decideOvertimeAction, empty);

  const settled = status !== "NEEDS_REVIEW" && status !== "INCOMPLETE";
  // A locked day can still be put right, but only by somebody who may unlock
  // the month, and it is recorded as an adjustment rather than an edit.
  const mayChange = locked ? mayLock : mayCorrect;

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1">
        {mayChange && (
          <button type="button" onClick={() => setOpen(open === "correct" ? null : "correct")} className={quiet}>
            {locked ? (ar ? "تعديل بعد القفل" : "Adjust after lock") : ar ? "صحّح" : "Correct"}
          </button>
        )}

        {mayReview && settled && !locked && (
          <form action={review}>
            <input type="hidden" name="dayId" value={dayId} />
            <button type="submit" disabled={reviewing} className={primary}>
              {reviewing ? "…" : ar ? "اعتمد" : "Accept"}
            </button>
          </form>
        )}

        {mayApproveOvertime && overtimeCandidate > 0 && !locked && (
          <button type="button" onClick={() => setOpen(open === "overtime" ? null : "overtime")} className={quiet}>
            {ar ? "إضافي" : "Overtime"}
          </button>
        )}
      </div>

      {open === "correct" && mayChange && (
        <form action={correct} className="flex flex-wrap items-end gap-2 rounded-lg bg-ink-50 p-2">
          <input type="hidden" name="dayId" value={dayId} />
          {locked && <input type="hidden" name="afterLock" value="1" />}
          <div>
            <label className="mb-1 block text-[10px] text-ink-500">{ar ? "الحالة" : "Status"}</label>
            <select name="status" defaultValue={status} className={field}>
              <option value="PRESENT">{ar ? "حاضر" : "Present"}</option>
              <option value="LATE">{ar ? "متأخر" : "Late"}</option>
              <option value="EARLY_LEAVE">{ar ? "خرج بدري" : "Left early"}</option>
              <option value="LEAVE">{ar ? "إجازة" : "Approved leave"}</option>
              <option value="ABSENT">{ar ? "غياب" : "Absent"}</option>
              <option value="OFF">{ar ? "إجازة أسبوعية" : "Off day"}</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[10px] text-ink-500">{ar ? "دقائق العمل" : "Worked minutes"}</label>
            <input name="workedMinutes" type="number" step="1" min="0" dir="ltr" className={`${field} num w-24`} />
          </div>
          <div className="min-w-48 flex-1">
            <label className="mb-1 block text-[10px] text-ink-500">
              {ar ? "السبب — مطلوب" : "Reason — required"}
            </label>
            <input
              name="reason"
              required
              placeholder={ar ? "مثلاً: الجهاز مقراش الخروج، المشرف أكّد" : "e.g. reader missed the exit; supervisor confirms"}
              className={`${field} w-full`}
            />
          </div>
          <button type="submit" disabled={correcting} className={primary}>
            {correcting ? "…" : ar ? "احفظ" : "Save"}
          </button>
          {correctState.error && <p className="w-full text-xs text-bad">{correctState.error}</p>}
        </form>
      )}

      {open === "overtime" && mayApproveOvertime && (
        <form action={decideOvertime} className="flex flex-wrap items-end gap-2 rounded-lg bg-ink-50 p-2">
          <input type="hidden" name="dayId" value={dayId} />
          <div>
            <label className="mb-1 block text-[10px] text-ink-500">{ar ? "دقائق" : "Minutes"}</label>
            <input
              name="minutes"
              type="number"
              step="1"
              min="0"
              defaultValue={overtimeCandidate}
              dir="ltr"
              className={`${field} num w-24`}
            />
          </div>
          <div className="min-w-48 flex-1">
            <label className="mb-1 block text-[10px] text-ink-500">{ar ? "السبب" : "Reason"}</label>
            <input name="reason" required className={`${field} w-full`} />
          </div>
          <button type="submit" name="decision" value="approve" disabled={deciding} className={primary}>
            {ar ? "وافق" : "Approve"}
          </button>
          <button type="submit" name="decision" value="reject" disabled={deciding} className={quiet}>
            {ar ? "ارفض" : "Refuse"}
          </button>
          {otState.error && <p className="w-full text-xs text-bad">{otState.error}</p>}
        </form>
      )}

      {(correctState.success || reviewState.success || otState.success) && (
        <p className="text-xs text-good">
          {correctState.success ?? reviewState.success ?? otState.success}
        </p>
      )}
      {reviewState.error && <p className="text-xs text-bad">{reviewState.error}</p>}
    </div>
  );
}

/**
 * Giving an unrecognised badge a name.
 *
 * Linking claims the punches already stored under that number, so a card
 * linked in October still explains September. The dates of the punches it
 * would claim are passed along, so the days they fall on are worked out at
 * once rather than waiting for the next derivation.
 */
export function LinkBadgeForm({
  ar,
  deviceUserId,
  employees,
  from,
  to,
}: {
  ar: boolean;
  deviceUserId: string;
  employees: { id: string; label: string }[];
  from: string;
  to: string;
}) {
  const [state, action, pending] = useActionState(linkBadgeAction, empty);

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="deviceUserId" value={deviceUserId} />
      <input type="hidden" name="from" value={from} />
      <input type="hidden" name="to" value={to} />
      <select name="employeeId" required defaultValue="" className={`${field} min-w-48`}>
        <option value="" disabled>
          {ar ? "اختار الموظف" : "Choose the employee"}
        </option>
        {employees.map((e) => (
          <option key={e.id} value={e.id}>{e.label}</option>
        ))}
      </select>
      <input
        name="reason"
        placeholder={ar ? "السبب (اختياري)" : "Reason (optional)"}
        className={`${field} w-44`}
      />
      <button type="submit" disabled={pending} className={primary}>
        {pending ? "…" : ar ? "اربط" : "Link"}
      </button>
      {state.error && <p className="w-full text-xs text-bad">{state.error}</p>}
      {state.success && <p className="w-full text-xs text-good">{state.success}</p>}
    </form>
  );
}
