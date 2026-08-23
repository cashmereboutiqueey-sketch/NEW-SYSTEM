"use client";

import { useActionState, useState } from "react";
import { logStageAction } from "./actions";
import type { FormState } from "@/components/entity-form";

const empty: FormState = {};
const field =
  "w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep";
const label = "mb-1 block text-xs font-medium text-ink-600";

export type LoggableRun = {
  id: string;
  orderNumber: string;
  styleCode: string;
  styleAr: string;
  styleEn: string;
  plannedQty: number;
  stages: { stage: string; standardMinutes: string }[];
  unroutedOperations: number;
};

export type Line = { id: string; code: string; nameAr: string; nameEn: string };

/**
 * Logging what a shift produced.
 *
 * Efficiency is not a field. It is earned over clocked, and earned is qtyOut
 * times the standard minutes the style's own operations say the stage takes —
 * so the form shows the arithmetic as it is typed rather than asking anybody
 * to agree with a number they cannot check.
 *
 * Only stages the routing covers are offered. A style with no operations
 * assigned to packing has no standard for packing, and an empty dropdown with
 * no explanation sends people to the wrong screen looking for the fix.
 */
export function StageForm({
  ar,
  runs,
  lines,
}: {
  ar: boolean;
  runs: LoggableRun[];
  lines: Line[];
}) {
  const [state, action, pending] = useActionState(logStageAction, empty);
  const [open, setOpen] = useState(false);
  const [runId, setRunId] = useState(runs[0]?.id ?? "");
  const [stage, setStage] = useState(runs[0]?.stages[0]?.stage ?? "");
  const [qtyIn, setQtyIn] = useState("");
  const [qtyOut, setQtyOut] = useState("");
  const [clocked, setClocked] = useState("");

  const today = new Date().toISOString().slice(0, 10);
  const run = runs.find((r) => r.id === runId);
  const routed = run?.stages ?? [];
  const chosen = routed.find((s) => s.stage === stage);

  const standard = chosen ? Number(chosen.standardMinutes) : 0;
  const out = qtyOut === "" ? 0 : Number(qtyOut);
  const inQty = qtyIn === "" ? 0 : Number(qtyIn);
  const clockedMinutes = clocked === "" ? 0 : Number(clocked);
  const earned = standard * out;
  const efficiency = clockedMinutes > 0 ? earned / clockedMinutes : null;
  const backwards = out > inQty;

  const stageLabel: Record<string, string> = ar
    ? { CUTTING: "قص", SEWING: "خياطة", FINISHING: "تشطيب", QC: "جودة", PACKING: "تعبئة" }
    : { CUTTING: "Cutting", SEWING: "Sewing", FINISHING: "Finishing", QC: "QC", PACKING: "Packing" };

  if (runs.length === 0) {
    return (
      <p className="text-sm text-ink-500">
        {ar
          ? "مفيش أوامر إنتاج مفتوحة تتسجل عليها ورديات."
          : "There are no open production runs to log a shift against."}
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg bg-ink-900 px-4 py-2 text-sm text-white hover:bg-ink-800"
      >
        {ar ? "سجّل وردية" : "Log a shift"}
      </button>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="logDate" value={today} />

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <label className={label} htmlFor="productionOrderId">
            {ar ? "أمر الإنتاج" : "Production run"}
          </label>
          <select
            id="productionOrderId" name="productionOrderId" required className={field}
            value={runId}
            onChange={(e) => {
              setRunId(e.target.value);
              const next = runs.find((r) => r.id === e.target.value);
              setStage(next?.stages[0]?.stage ?? "");
            }}
          >
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.orderNumber} — {ar ? r.styleAr : r.styleEn} ({r.plannedQty})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={label} htmlFor="stage">
            {ar ? "المرحلة" : "Stage"}
          </label>
          <select
            id="stage" name="stage" required className={field}
            value={stage}
            onChange={(e) => setStage(e.target.value)}
            disabled={routed.length === 0}
          >
            {routed.map((s) => (
              <option key={s.stage} value={s.stage}>
                {stageLabel[s.stage] ?? s.stage} ({Number(s.standardMinutes).toFixed(2)}{" "}
                {ar ? "دقيقة/قطعة" : "min/pc"})
              </option>
            ))}
          </select>
        </div>
      </div>

      {routed.length === 0 && (
        <p className="rounded-lg border border-warn/30 bg-warn/5 p-2.5 text-xs">
          {ar
            ? `الموديل ${run?.styleCode} مفيش أي عملية متحدد ليها مرحلة، فمفيش دقايق معيارية نقيس عليها. حدّد المراحل من صفحة الموديلات الأول.`
            : `${run?.styleCode} has no operation assigned to a stage, so there are no standard minutes to measure against. Set the stages on the style first.`}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <label className={label} htmlFor="qtyIn">
            {ar ? "دخل المرحلة" : "Pieces in"}
          </label>
          <input
            id="qtyIn" name="qtyIn" type="number" min="0" step="1" required dir="ltr"
            className={`${field} num`} value={qtyIn}
            onChange={(e) => setQtyIn(e.target.value)}
          />
        </div>
        <div>
          <label className={label} htmlFor="qtyOut">
            {ar ? "خرج منها" : "Pieces out"}
          </label>
          <input
            id="qtyOut" name="qtyOut" type="number" min="0" step="1" required dir="ltr"
            className={`${field} num`} value={qtyOut}
            onChange={(e) => setQtyOut(e.target.value)}
          />
          {backwards && (
            <p className="mt-1 text-xs text-bad">
              {ar ? "مش ممكن يخرج أكتر مما دخل." : "More cannot come out than went in."}
            </p>
          )}
        </div>
        <div>
          <label className={label} htmlFor="clockedMinutes">
            {ar ? "دقائق مدفوعة" : "Minutes clocked"}
          </label>
          <input
            id="clockedMinutes" name="clockedMinutes" type="number" min="1" step="1" required dir="ltr"
            className={`${field} num`} value={clocked}
            onChange={(e) => setClocked(e.target.value)}
          />
        </div>
        <div>
          <label className={label} htmlFor="operatorsCount">
            {ar ? "عدد العمال" : "Operators"}
          </label>
          <input
            id="operatorsCount" name="operatorsCount" type="number" min="1" step="1" dir="ltr"
            className={`${field} num`}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="lineId">
            {ar ? "الخط" : "Line"}
          </label>
          <select id="lineId" name="lineId" className={field}>
            <option value="">{ar ? "بدون خط" : "Unassigned"}</option>
            {lines.map((l) => (
              <option key={l.id} value={l.id}>
                {ar ? l.nameAr : l.nameEn}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="notes">
            {ar ? "ملاحظات" : "Notes"}
          </label>
          <input id="notes" name="notes" className={field} maxLength={500} />
        </div>
      </div>

      {/* The arithmetic, shown as it is typed rather than asserted afterwards. */}
      {standard > 0 && out > 0 && (
        <div className="rounded-lg border border-ink-200 bg-ink-50 p-3 text-sm">
          <span className="num">{out}</span>{" "}
          {ar ? "قطعة ×" : "pieces ×"} <span className="num">{standard.toFixed(2)}</span>{" "}
          {ar ? "دقيقة =" : "min ="} <b className="num">{earned.toFixed(1)}</b>{" "}
          {ar ? "دقيقة مكتسبة" : "minutes earned"}
          {clockedMinutes > 0 && (
            <>
              {" ÷ "}
              <span className="num">{clockedMinutes}</span>{" "}
              {ar ? "مدفوعة =" : "clocked ="}{" "}
              <b
                className={
                  efficiency && efficiency >= 0.85
                    ? "num text-good"
                    : efficiency && efficiency >= 0.6
                      ? "num text-warn"
                      : "num text-bad"
                }
              >
                {((efficiency ?? 0) * 100).toFixed(1)}%
              </b>
            </>
          )}
        </div>
      )}

      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      {state.success && <p className="text-sm text-good">{state.success}</p>}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending || backwards || routed.length === 0}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {pending ? (ar ? "بيتسجل…" : "Logging…") : ar ? "سجّل" : "Log"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg border border-ink-200 px-4 py-2 text-sm text-ink-600"
        >
          {ar ? "إلغاء" : "Cancel"}
        </button>
      </div>
    </form>
  );
}
