"use client";

import { useActionState, useState } from "react";
import { recordScrapAction } from "./actions";
import type { FormState } from "@/components/entity-form";

const empty: FormState = {};
const field =
  "w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep";
const label = "mb-1 block text-xs font-medium text-ink-600";

export type ScrapSource = {
  materialId: string;
  locationId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  uom: string;
  onHand: string;
  locationAr: string;
  locationEn: string;
};

export type ScrapRun = {
  id: string;
  orderNumber: string;
  styleAr: string;
  styleEn: string;
};

/**
 * Recording offcuts.
 *
 * The book value is deliberately not a field. It is whatever FIFO says the
 * specific metres cost, and letting somebody type it is how the inventory
 * account stops agreeing with the inventory. The form shows what is on the
 * shelf so the quantity can be sanity-checked before it is written off.
 *
 * Salvage only appears for cloth that was sold, because nothing came back for
 * the rest and a box that can be filled in will eventually be filled in.
 */
export function ScrapForm({
  ar,
  entityId,
  sources,
  runs,
}: {
  ar: boolean;
  entityId: string;
  sources: ScrapSource[];
  runs: ScrapRun[];
}) {
  const [state, action, pending] = useActionState(recordScrapAction, empty);
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState(
    sources[0] ? `${sources[0].materialId}:${sources[0].locationId}` : "",
  );
  const [disposition, setDisposition] = useState("DISCARDED");
  const [quantity, setQuantity] = useState("");

  const today = new Date().toISOString().slice(0, 10);
  const chosen = sources.find((s) => `${s.materialId}:${s.locationId}` === source);
  const available = chosen ? Number(chosen.onHand) : 0;
  const asked = quantity === "" ? 0 : Number(quantity);
  const tooMuch = asked > available;

  if (sources.length === 0) {
    return (
      <p className="text-sm text-ink-500">
        {ar
          ? "مفيش خامات في المخزن دلوقتي، فمفيش حاجة تتسجل كقصاصات."
          : "There is no material in stock, so there is nothing to write off."}
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
        {ar ? "سجّل قصاصات" : "Record scrap"}
      </button>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="entityId" value={entityId} />
      <input type="hidden" name="scrapDate" value={today} />

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="source">
            {ar ? "الخامة" : "Material"}
          </label>
          <select
            id="source" name="source" required className={field}
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            {sources.map((s) => (
              <option key={`${s.materialId}:${s.locationId}`} value={`${s.materialId}:${s.locationId}`}>
                {s.code} — {ar ? s.nameAr : s.nameEn} · {ar ? s.locationAr : s.locationEn} (
                {Number(s.onHand).toLocaleString()} {s.uom})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={label} htmlFor="quantity">
            {ar ? "الكمية" : "Quantity"}
            {chosen && (
              <span className="ms-2 font-normal text-ink-400">
                {ar ? "المتاح" : "available"} {available.toLocaleString()} {chosen.uom}
              </span>
            )}
          </label>
          <input
            id="quantity" name="quantity" type="number" step="0.01" min="0.01"
            required dir="ltr" className={`${field} num`}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
          {tooMuch && (
            <p className="mt-1 text-xs text-bad">
              {ar
                ? `مفيش غير ${available.toLocaleString()} في المخزن.`
                : `Only ${available.toLocaleString()} is on the shelf.`}
            </p>
          )}
        </div>

        <div>
          <label className={label} htmlFor="disposition">
            {ar ? "راحت فين" : "What became of it"}
          </label>
          <select
            id="disposition" name="disposition" className={field}
            value={disposition}
            onChange={(e) => setDisposition(e.target.value)}
          >
            <option value="DISCARDED">{ar ? "اترمت" : "Discarded"}</option>
            <option value="SOLD">{ar ? "اتباعت" : "Sold on"}</option>
            <option value="USED_FOR_SAMPLING">{ar ? "اتستخدمت في عينات" : "Used for samples"}</option>
            <option value="RETURNED_TO_STOCK">{ar ? "رجعت للمخزن" : "Back to stock"}</option>
          </select>
          <p className="mt-1 text-[11px] text-ink-400">
            {disposition === "RETURNED_TO_STOCK"
              ? ar
                ? "القماش ما خرجش من المخزن، فمفيش خسارة ومفيش قيد."
                : "The cloth never leaves stock, so there is no loss and no journal."
              : ar
                ? "القماش هيتشال من المخزن بتكلفته الفعلية (FIFO)."
                : "The cloth leaves stock at what it actually cost (FIFO)."}
          </p>
        </div>

        {disposition === "SOLD" && (
          <div>
            <label className={label} htmlFor="salvageValue">
              {ar ? "اتباعت بكام" : "Sold for"}
            </label>
            <input
              id="salvageValue" name="salvageValue" type="number" step="0.01" min="0"
              dir="ltr" className={`${field} num`}
            />
            <p className="mt-1 text-[11px] text-ink-400">
              {ar
                ? "الخسارة هي الفرق بين التكلفة واللي رجع. لو باعتيها بأكتر من تكلفتها فدي بيعة مش قصاصة."
                : "The loss is the difference. Above cost it is a sale, not a scrap recovery."}
            </p>
          </div>
        )}

        <div>
          <label className={label} htmlFor="productionOrderId">
            {ar ? "أمر الإنتاج (اختياري)" : "Production run (optional)"}
          </label>
          <select id="productionOrderId" name="productionOrderId" className={field}>
            <option value="">{ar ? "مش مربوط بأمر" : "Not tied to a run"}</option>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.orderNumber} — {ar ? r.styleAr : r.styleEn}
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

      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      {state.success && <p className="text-sm text-good">{state.success}</p>}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending || tooMuch}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {pending ? (ar ? "بيتسجل…" : "Recording…") : ar ? "سجّل" : "Record"}
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
