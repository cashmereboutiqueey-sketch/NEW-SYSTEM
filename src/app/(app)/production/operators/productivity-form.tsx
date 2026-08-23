"use client";

import { useActionState, useState } from "react";
import { recordProductivityAction } from "./actions";
import type { FormState } from "@/components/entity-form";

const empty: FormState = {};
const field =
  "w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep";
const label = "mb-1 block text-xs font-medium text-ink-600";

export type OperatorOption = {
  id: string;
  code: string;
  name: string;
  lineAr: string | null;
  lineEn: string | null;
  hasEmployee: boolean;
};

/**
 * A day's work for one operator.
 *
 * The minutes box only appears for somebody the HR system does not know. For
 * everybody else the figure comes from the biometric attendance already
 * recorded, and offering a box that will be silently ignored is worse than
 * offering none.
 */
export function ProductivityForm({
  ar,
  operators,
}: {
  ar: boolean;
  operators: OperatorOption[];
}) {
  const [state, action, pending] = useActionState(recordProductivityAction, empty);
  const [operatorId, setOperatorId] = useState(operators[0]?.id ?? "");
  const [smv, setSmv] = useState("");
  const [minutes, setMinutes] = useState("");

  const today = new Date().toISOString().slice(0, 10);
  const operator = operators.find((o) => o.id === operatorId);
  const needsMinutes = operator ? !operator.hasEmployee : false;

  const produced = smv === "" ? 0 : Number(smv);
  const clocked = minutes === "" ? 0 : Number(minutes);
  const preview = needsMinutes && clocked > 0 ? produced / clocked : null;

  if (operators.length === 0) {
    return (
      <p className="text-sm text-ink-500">
        {ar ? "مفيش عمّال مسجّلين." : "There are no operators on file."}
      </p>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className={label} htmlFor="operatorId">
            {ar ? "العامل" : "Operator"}
          </label>
          <select
            id="operatorId" name="operatorId" required className={field}
            value={operatorId}
            onChange={(e) => setOperatorId(e.target.value)}
          >
            {operators.map((o) => (
              <option key={o.id} value={o.id}>
                {o.code} — {o.name}
                {o.lineAr ? ` · ${ar ? o.lineAr : o.lineEn}` : ""}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={label} htmlFor="logDate">
            {ar ? "اليوم" : "Day"}
          </label>
          <input
            id="logDate" name="logDate" type="date" required dir="ltr"
            className={`${field} num`} defaultValue={today}
          />
        </div>

        <div>
          <label className={label} htmlFor="smvProduced">
            {ar ? "الدقايق المعيارية اللي أنتجها" : "Standard minutes produced"}
          </label>
          <input
            id="smvProduced" name="smvProduced" type="number" min="0" step="0.01" required
            dir="ltr" className={`${field} num`} value={smv}
            onChange={(e) => setSmv(e.target.value)}
          />
        </div>
      </div>

      {needsMinutes ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={label} htmlFor="clockedMinutes">
              {ar ? "الدقايق المدفوعة" : "Minutes clocked"}
            </label>
            <input
              id="clockedMinutes" name="clockedMinutes" type="number" min="1" step="1" required
              dir="ltr" className={`${field} num`} value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
            <p className="mt-1 text-[11px] text-warn">
              {ar
                ? "العامل ده مش مربوط بملف موظف، فالدقايق بتتكتب بإيد. اربطه بملف عشان تيجي من البصمة."
                : "This operator has no HR record, so the minutes are typed. Link one and they come from the biometric attendance instead."}
            </p>
          </div>
        </div>
      ) : (
        <p className="rounded-lg border border-ink-200 bg-ink-50 p-2.5 text-xs text-ink-500">
          {ar
            ? "الدقايق المدفوعة هتيجي من البصمة بتاعة اليوم ده — مش بتتكتب."
            : "The clocked minutes come from that day's biometric attendance — they are not typed."}
        </p>
      )}

      <div>
        <label className={label} htmlFor="notes">
          {ar ? "ملاحظات" : "Notes"}
        </label>
        <input id="notes" name="notes" className={field} maxLength={500} />
      </div>

      {preview !== null && (
        <div className="rounded-lg border border-ink-200 bg-ink-50 p-3 text-sm">
          <span className="num">{produced}</span> ÷ <span className="num">{clocked}</span> ={" "}
          <b
            className={
              preview >= 0.85 ? "num text-good" : preview >= 0.6 ? "num text-warn" : "num text-bad"
            }
          >
            {(preview * 100).toFixed(1)}%
          </b>
        </div>
      )}

      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      {state.success && <p className="text-sm text-good">{state.success}</p>}

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-ink-900 px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {pending ? (ar ? "بيتسجل…" : "Recording…") : ar ? "سجّل" : "Record"}
      </button>
    </form>
  );
}
