"use client";

import { useActionState, useState } from "react";
import { createCuttingTicketAction } from "./actions";
import type { FormState } from "@/components/entity-form";

const empty: FormState = {};
const field =
  "w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep";
const label = "mb-1 block text-xs font-medium text-ink-600";

export type CuttableRun = {
  id: string;
  orderNumber: string;
  styleAr: string;
  styleEn: string;
  plannedQty: number;
  standardPerPiece: string | null;
};

/**
 * Recording a lay.
 *
 * The marker length and the plies are asked for together because neither
 * measures anything alone: metres laid is one times the other. The form works
 * out metres a garment as it is typed, against what the costing allowed, so
 * the cutter sees the number before the run rather than a month later.
 */
export function TicketForm({ ar, runs }: { ar: boolean; runs: CuttableRun[] }) {
  const [state, action, pending] = useActionState(createCuttingTicketAction, empty);
  const [runId, setRunId] = useState(runs[0]?.id ?? "");
  const [marker, setMarker] = useState("");
  const [plies, setPlies] = useState("");
  const [pieces, setPieces] = useState("");

  const today = new Date().toISOString().slice(0, 10);
  const n = (v: string) => (v === "" ? 0 : Number(v));
  const run = runs.find((r) => r.id === runId);

  const laid = n(marker) * n(plies);
  const perPiece = n(pieces) > 0 && laid > 0 ? laid / n(pieces) : null;
  const standard = run?.standardPerPiece ? Number(run.standardPerPiece) : null;
  const over = perPiece !== null && standard !== null ? perPiece / standard : null;

  if (runs.length === 0) {
    return (
      <p className="text-sm text-ink-500">
        {ar ? "مفيش أوامر إنتاج مفتوحة." : "There are no open production runs."}
      </p>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="cutDate" value={today} />

      <div className="grid gap-3 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <label className={label} htmlFor="productionOrderId">
            {ar ? "أمر الإنتاج" : "Production run"}
          </label>
          <select
            id="productionOrderId" name="productionOrderId" required className={field}
            value={runId}
            onChange={(e) => setRunId(e.target.value)}
          >
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.orderNumber} — {ar ? r.styleAr : r.styleEn} ({r.plannedQty})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={label} htmlFor="markerLengthM">
            {ar ? "طول الماركر (متر)" : "Marker length (m)"}
          </label>
          <input
            id="markerLengthM" name="markerLengthM" type="number" min="0.01" step="0.01"
            dir="ltr" className={`${field} num`} value={marker}
            onChange={(e) => setMarker(e.target.value)}
          />
        </div>

        <div>
          <label className={label} htmlFor="plies">
            {ar ? "عدد الطبقات" : "Plies"}
          </label>
          <input
            id="plies" name="plies" type="number" min="1" step="1"
            dir="ltr" className={`${field} num`} value={plies}
            onChange={(e) => setPlies(e.target.value)}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="piecesCut">
            {ar ? "قطع اتقصت" : "Pieces cut"}
          </label>
          <input
            id="piecesCut" name="piecesCut" type="number" min="1" step="1" required
            dir="ltr" className={`${field} num`} value={pieces}
            onChange={(e) => setPieces(e.target.value)}
          />
        </div>
        <div>
          <label className={label} htmlFor="notes">
            {ar ? "ملاحظات" : "Notes"}
          </label>
          <input id="notes" name="notes" className={field} maxLength={500} />
        </div>
      </div>

      {laid > 0 && (
        <div className="rounded-lg border border-ink-200 bg-ink-50 p-3 text-sm">
          <span className="num">{n(marker)}</span>{" "}
          {ar ? "متر ×" : "m ×"} <span className="num">{n(plies)}</span>{" "}
          {ar ? "طبقة =" : "plies ="} <b className="num">{laid.toFixed(2)}</b>{" "}
          {ar ? "متر" : "m"}
          {perPiece !== null && (
            <>
              {" · "}
              <b className="num">{perPiece.toFixed(3)}</b>{" "}
              {ar ? "متر للقطعة" : "m a garment"}
              {standard !== null && (
                <span
                  className={
                    over !== null && over > 1 ? "ms-2 text-bad" : "ms-2 text-good"
                  }
                >
                  ({ar ? "المعياري" : "standard"} {standard.toFixed(3)} —{" "}
                  {over !== null && over > 1
                    ? ar
                      ? `زيادة ${((over - 1) * 100).toFixed(1)}٪`
                      : `${((over - 1) * 100).toFixed(1)}% over`
                    : ar
                      ? `توفير ${((1 - (over ?? 1)) * 100).toFixed(1)}٪`
                      : `${((1 - (over ?? 1)) * 100).toFixed(1)}% under`}
                  )
                </span>
              )}
            </>
          )}
        </div>
      )}

      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      {state.success && <p className="text-sm text-good">{state.success}</p>}

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-ink-900 px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {pending ? (ar ? "بيتسجل…" : "Recording…") : ar ? "سجّل التذكرة" : "Record the ticket"}
      </button>
    </form>
  );
}
