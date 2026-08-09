"use client";

import { useActionState, useState } from "react";
import { despatchToBrandAction } from "./actions";
import type { FormState } from "@/components/entity-form";
import type { Locale } from "@/lib/i18n";

const initial: FormState = {};
const field =
  "rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 " +
  "focus:border-ink-400 focus:outline-none focus:ring-1 focus:ring-ink-300";
const label = "mb-1 block text-xs font-medium text-ink-600";

export type DespatchRow = {
  variantId: string;
  sku: string;
  name: string;
  locationId: string;
  locationName: string;
  quantity: string;
  transferPrice: string | null;
  marginPerUnit: string | null;
  retailPrice: string | null;
  costSnapshotId: string | null;
};

/**
 * One row, one despatch.
 *
 * The quantity defaults to everything available, because sending part of a run
 * is the exception. The price is shown but never editable — it comes from the
 * snapshot frozen before the run started.
 */
export function DespatchForm({
  locale,
  row,
  today,
}: {
  locale: Locale;
  row: DespatchRow;
  today: string;
}) {
  const [state, formAction, pending] = useActionState(despatchToBrandAction, initial);
  const [quantity, setQuantity] = useState(row.quantity);
  const ar = locale === "ar";

  const available = Number(row.quantity);
  const qty = Number(quantity) || 0;
  const price = Number(row.transferPrice ?? 0);
  const retail = row.retailPrice == null ? null : Number(row.retailPrice);

  const tooMany = qty > available;
  // A transfer price at or above retail means the Brand cannot sell it at a
  // profit. Worth saying before the goods leave, not after.
  const squeezed = retail != null && price >= retail;

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="variantId" value={row.variantId} />
      <input type="hidden" name="fromLocationId" value={row.locationId} />
      <input type="hidden" name="costSnapshotId" value={row.costSnapshotId ?? ""} />

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className={label} htmlFor={`qty-${row.variantId}`}>
            {ar ? "الكمية" : "Quantity"}
          </label>
          <input
            id={`qty-${row.variantId}`}
            name="quantity"
            type="number"
            step="1"
            min="1"
            max={available}
            required
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            dir="ltr"
            className={`${field} num w-28`}
          />
          <p className="mt-1 text-xs text-ink-400">
            {ar ? "المتاح" : "Available"} <span className="num">{available}</span>
          </p>
        </div>

        <div>
          <label className={label} htmlFor={`date-${row.variantId}`}>
            {ar ? "تاريخ الشحن" : "Despatch date"}
          </label>
          <input
            id={`date-${row.variantId}`}
            name="despatchDate"
            type="date"
            required
            defaultValue={today}
            dir="ltr"
            className={`${field}`}
          />
        </div>

        <div>
          <label className={label} htmlFor={`note-${row.variantId}`}>
            {ar ? "ملاحظة" : "Note"}
          </label>
          <input
            id={`note-${row.variantId}`}
            name="notes"
            type="text"
            placeholder={ar ? "اسم السواق مثلًا" : "driver, van, anything"}
            className={`${field} w-44`}
          />
        </div>

        <div className="ms-auto text-end">
          <p className="text-xs text-ink-500">{ar ? "قيمتها عند الاستلام" : "Value on arrival"}</p>
          <p className="num text-lg font-semibold">{(qty * price).toFixed(2)}</p>
        </div>

        <button
          type="submit"
          disabled={pending || tooMany || qty <= 0 || !row.costSnapshotId}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {pending
            ? ar ? "جارٍ الشحن…" : "Sending…"
            : ar ? "اشحن للبراند" : "Send to the Brand"}
        </button>
      </div>

      {tooMany && (
        <p className="text-sm text-bad">
          {ar
            ? `مفيش غير ${available} قطعة في المصنع.`
            : `The factory only holds ${available}.`}
        </p>
      )}

      {squeezed && (
        <p className="text-sm text-warn">
          {ar
            ? `سعر التحويل ${price.toFixed(2)} مش أقل من سعر البيع ${retail!.toFixed(2)} — البراند هيبيع بخسارة.`
            : `The transfer price of ${price.toFixed(2)} is not below the ${retail!.toFixed(2)} retail price — the Brand would sell at a loss.`}
        </p>
      )}

      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      {state.success && <p className="text-sm text-good">{state.success}</p>}
    </form>
  );
}
