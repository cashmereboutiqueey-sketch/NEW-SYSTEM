"use client";

import { useActionState, useState } from "react";
import { recordInspectionAction, recordReworkAction } from "./actions";
import type { FormState } from "@/components/entity-form";

const empty: FormState = {};
const field =
  "w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm outline-none focus:border-ink-500";
const label = "mb-1 block text-xs font-medium text-ink-600";

export type QualityRun = {
  id: string;
  orderNumber: string;
  styleCode: string;
  styleAr: string;
  styleEn: string;
  plannedQty: number;
  actualQty: number | null;
};

export type QualityLine = { id: string; nameAr: string; nameEn: string };

export type MaterialSource = {
  materialId: string;
  locationId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  uom: string;
  onHand: string;
};

/**
 * Recording an inspection.
 *
 * The defect rate is not a field. Every garment inspected ends up passed,
 * sent back, or rejected, and the rate falls out of those three — so the form
 * adds them up as they are typed and refuses to submit until they reconcile.
 * A rate somebody enters directly is a rate nobody can check.
 */
export function InspectionForm({ ar, runs }: { ar: boolean; runs: QualityRun[] }) {
  const [state, action, pending] = useActionState(recordInspectionAction, empty);
  const [inspected, setInspected] = useState("");
  const [passed, setPassed] = useState("");
  const [reworkQty, setReworkQty] = useState("");
  const [rejected, setRejected] = useState("");

  const today = new Date().toISOString().slice(0, 10);
  const n = (v: string) => (v === "" ? 0 : Number(v));
  const total = n(passed) + n(reworkQty) + n(rejected);
  const inspectedN = n(inspected);
  const reconciles = inspectedN > 0 && total === inspectedN;
  const defective = n(reworkQty) + n(rejected);
  const rate = inspectedN > 0 ? defective / inspectedN : null;

  if (runs.length === 0) {
    return (
      <p className="text-sm text-ink-500">
        {ar ? "مفيش أوامر إنتاج تتفحص." : "There are no runs to inspect."}
      </p>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="inspectionDate" value={today} />

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="i-order">
            {ar ? "أمر الإنتاج" : "Production run"}
          </label>
          <select id="i-order" name="productionOrderId" required className={field}>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.orderNumber} — {ar ? r.styleAr : r.styleEn} ({r.actualQty ?? r.plannedQty})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="i-stage">
            {ar ? "المرحلة" : "Stage"}
          </label>
          <select id="i-stage" name="stage" className={field} defaultValue="QC">
            <option value="QC">{ar ? "جودة" : "QC"}</option>
            <option value="CUTTING">{ar ? "قص" : "Cutting"}</option>
            <option value="SEWING">{ar ? "خياطة" : "Sewing"}</option>
            <option value="FINISHING">{ar ? "تشطيب" : "Finishing"}</option>
            <option value="PACKING">{ar ? "تعبئة" : "Packing"}</option>
          </select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <label className={label} htmlFor="inspectedQty">
            {ar ? "اتفحص" : "Inspected"}
          </label>
          <input
            id="inspectedQty" name="inspectedQty" type="number" min="1" step="1" required
            dir="ltr" className={`${field} num`} value={inspected}
            onChange={(e) => setInspected(e.target.value)}
          />
        </div>
        <div>
          <label className={label} htmlFor="passedQty">
            {ar ? "عدّى" : "Passed"}
          </label>
          <input
            id="passedQty" name="passedQty" type="number" min="0" step="1" required
            dir="ltr" className={`${field} num`} value={passed}
            onChange={(e) => setPassed(e.target.value)}
          />
        </div>
        <div>
          <label className={label} htmlFor="reworkQty">
            {ar ? "رجع للإصلاح" : "Sent back"}
          </label>
          <input
            id="reworkQty" name="reworkQty" type="number" min="0" step="1"
            dir="ltr" className={`${field} num`} value={reworkQty}
            onChange={(e) => setReworkQty(e.target.value)}
          />
        </div>
        <div>
          <label className={label} htmlFor="rejectedQty">
            {ar ? "اترفض" : "Rejected"}
          </label>
          <input
            id="rejectedQty" name="rejectedQty" type="number" min="0" step="1"
            dir="ltr" className={`${field} num`} value={rejected}
            onChange={(e) => setRejected(e.target.value)}
          />
        </div>
      </div>

      <div>
        <label className={label} htmlFor="defectNotes">
          {ar ? "العيوب" : "What was wrong"}
        </label>
        <input id="defectNotes" name="defectNotes" className={field} maxLength={1000} />
      </div>

      {inspectedN > 0 && (
        <div
          className={
            "rounded-lg border p-3 text-sm " +
            (reconciles ? "border-line bg-surface" : "border-bad/30 bg-bad/5")
          }
        >
          {reconciles ? (
            <>
              {ar ? "نسبة العيوب" : "Defect rate"}{" "}
              <b
                className={
                  (rate ?? 0) <= 0.03 ? "num text-good" : (rate ?? 0) <= 0.08 ? "num text-warn" : "num text-bad"
                }
              >
                {((rate ?? 0) * 100).toFixed(1)}%
              </b>{" "}
              <span className="text-ink-500">
                ({defective} {ar ? "من" : "of"} {inspectedN})
              </span>
            </>
          ) : (
            <span className="text-bad">
              {ar
                ? `عدّى + رجع + اترفض = ${total}، والمفروض ${inspectedN}.`
                : `Passed + sent back + rejected = ${total}, but ${inspectedN} were inspected.`}
            </span>
          )}
        </div>
      )}

      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      {state.success && <p className="text-sm text-good">{state.success}</p>}

      <button
        type="submit"
        disabled={pending || !reconciles}
        className="rounded-lg bg-ink-900 px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {pending ? (ar ? "بيتسجل…" : "Recording…") : ar ? "سجّل الفحص" : "Record inspection"}
      </button>
    </form>
  );
}

/**
 * Recording rework.
 *
 * The cost is not a field either. It is minutes times the rate in force on the
 * day, and that rate is frozen onto the record so a revision next quarter
 * cannot restate what this quarter's mistakes cost.
 */
export function ReworkForm({
  ar,
  entityId,
  runs,
  lines,
  minuteRate,
  materials,
}: {
  ar: boolean;
  entityId: string;
  runs: QualityRun[];
  lines: QualityLine[];
  minuteRate: string | null;
  materials: MaterialSource[];
}) {
  const [state, action, pending] = useActionState(recordReworkAction, empty);
  const [quantity, setQuantity] = useState("");
  const [minutes, setMinutes] = useState("");
  const [source, setSource] = useState("");
  const [materialQty, setMaterialQty] = useState("");

  const today = new Date().toISOString().slice(0, 10);
  const n = (v: string) => (v === "" ? 0 : Number(v));
  const rate = minuteRate ? Number(minuteRate) : null;
  const totalMinutes = n(quantity) * n(minutes);
  const labour = rate ? totalMinutes * rate : null;

  const chosen = materials.find((m) => `${m.materialId}:${m.locationId}` === source);
  const available = chosen ? Number(chosen.onHand) : 0;
  const tooMuch = source !== "" && n(materialQty) > available;

  if (runs.length === 0) {
    return (
      <p className="text-sm text-ink-500">
        {ar ? "مفيش أوامر إنتاج." : "There are no runs."}
      </p>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="entityId" value={entityId} />
      <input type="hidden" name="reworkDate" value={today} />

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="r-order">
            {ar ? "أمر الإنتاج" : "Production run"}
          </label>
          <select id="r-order" name="productionOrderId" required className={field}>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.orderNumber} — {ar ? r.styleAr : r.styleEn}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="type">
            {ar ? "نوع الإصلاح" : "Kind of fixing"}
          </label>
          <select id="type" name="type" className={field} defaultValue="RESEWING">
            <option value="RESEWING">{ar ? "إعادة خياطة" : "Resewing"}</option>
            <option value="REPRESSING">{ar ? "إعادة مكوى" : "Repressing"}</option>
            <option value="REPACKING">{ar ? "إعادة تعبئة" : "Repacking"}</option>
            <option value="RECUTTING">{ar ? "إعادة قص" : "Recutting"}</option>
            <option value="WASHING">{ar ? "غسيل" : "Washing"}</option>
          </select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <label className={label} htmlFor="quantity">
            {ar ? "عدد القطع" : "Pieces"}
          </label>
          <input
            id="quantity" name="quantity" type="number" min="1" step="1" required
            dir="ltr" className={`${field} num`} value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </div>
        <div>
          <label className={label} htmlFor="minutesPerUnit">
            {ar ? "دقايق للقطعة" : "Minutes each"}
          </label>
          <input
            id="minutesPerUnit" name="minutesPerUnit" type="number" min="0.01" step="0.01" required
            dir="ltr" className={`${field} num`} value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
        </div>
        <div>
          <label className={label} htmlFor="r-line">
            {ar ? "الخط" : "Line"}
          </label>
          <select id="r-line" name="lineId" className={field}>
            <option value="">{ar ? "بدون خط" : "Unassigned"}</option>
            {lines.map((l) => (
              <option key={l.id} value={l.id}>
                {ar ? l.nameAr : l.nameEn}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <label className={label} htmlFor="materialSource">
            {ar ? "خامة اتصرفت (اختياري)" : "Material used (optional)"}
          </label>
          <select
            id="materialSource" name="materialSource" className={field}
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            <option value="">{ar ? "مفيش خامات" : "None"}</option>
            {materials.map((m) => (
              <option key={`${m.materialId}:${m.locationId}`} value={`${m.materialId}:${m.locationId}`}>
                {m.code} — {ar ? m.nameAr : m.nameEn} ({Number(m.onHand).toLocaleString()} {m.uom})
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-ink-400">
            {ar
              ? "التكلفة بتتحسب بالـ FIFO من المخزن — مش بتتكتب."
              : "The cost comes from the shelf at FIFO — it is never typed."}
          </p>
        </div>
        <div>
          <label className={label} htmlFor="materialQuantity">
            {ar ? "الكمية" : "Quantity"}
          </label>
          <input
            id="materialQuantity" name="materialQuantity" type="number" min="0.01" step="0.01"
            dir="ltr" className={`${field} num`} value={materialQty}
            disabled={source === ""}
            onChange={(e) => setMaterialQty(e.target.value)}
          />
          {tooMuch && (
            <p className="mt-1 text-xs text-bad">
              {ar
                ? `مفيش غير ${available.toLocaleString()}.`
                : `Only ${available.toLocaleString()} on hand.`}
            </p>
          )}
        </div>
      </div>

      <div>
        <label className={label} htmlFor="reason">
          {ar ? "السبب" : "Why"}
        </label>
        <input id="reason" name="reason" className={field} maxLength={500} />
      </div>

      {rate === null ? (
        <p className="rounded-lg border border-warn/30 bg-warn/5 p-2.5 text-xs">
          {ar
            ? "مفيش تكلفة دقيقة محسوبة للفترة دي، فمش هينفع نحسب تكلفة الإصلاح. احسب تكلفة الدقيقة الأول."
            : "No minute rate has been calculated for this period, so rework cannot be costed. Calculate the minute rate first."}
        </p>
      ) : (
        totalMinutes > 0 && (
          <div className="rounded-lg border border-line bg-surface p-3 text-sm">
            <span className="num">{totalMinutes.toFixed(0)}</span>{" "}
            {ar ? "دقيقة ×" : "min ×"} <span className="num">{rate.toFixed(4)}</span>{" "}
            {ar ? "= أجور" : "= labour"}{" "}
            <b className="num text-bad">{(labour ?? 0).toFixed(2)}</b>{" "}
            <span className="text-ink-500">
              {ar ? "على حساب ٥٥٠٠" : "to account 5500"}
            </span>
            {source !== "" && n(materialQty) > 0 && (
              <span className="ms-2 text-ink-500">
                {ar
                  ? "+ تكلفة الخامة بالـ FIFO"
                  : "+ the material at whatever FIFO says it cost"}
              </span>
            )}
          </div>
        )
      )}

      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      {state.success && <p className="text-sm text-good">{state.success}</p>}

      <button
        type="submit"
        disabled={pending || rate === null || tooMuch}
        className="rounded-lg bg-ink-900 px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {pending ? (ar ? "بيتسجل…" : "Recording…") : ar ? "سجّل الإصلاح" : "Record rework"}
      </button>
    </form>
  );
}
