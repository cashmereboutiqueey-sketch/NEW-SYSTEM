"use client";

import { useActionState, useState } from "react";
import { transferToBrandAction } from "./actions";
import type { FormState } from "@/components/entity-form";
import type { Locale } from "@/lib/i18n";

const initial: FormState = {};
const field =
  "rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 " +
  "focus:border-ink-400 focus:outline-none focus:ring-1 focus:ring-ink-300";
const label = "mb-1 block text-xs font-medium text-ink-600";

export type TransferRow = {
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
 * One row, one movement.
 *
 * The quantity defaults to everything available, because sending part of a run
 * is the exception. The price is shown but never editable — it comes from the
 * snapshot frozen before the run started.
 */
export function TransferForm({
  locale,
  row,
  destinations,
  today,
}: {
  locale: Locale;
  row: TransferRow;
  destinations: { id: string; label: string }[];
  today: string;
}) {
  const [state, formAction, pending] = useActionState(transferToBrandAction, initial);
  const [quantity, setQuantity] = useState(row.quantity);
  const ar = locale === "ar";

  const available = Number(row.quantity);
  const qty = Number(quantity) || 0;
  const price = Number(row.transferPrice ?? 0);
  const retail = row.retailPrice == null ? null : Number(row.retailPrice);

  const tooMany = qty > available;
  // A transfer price at or above retail means the Brand cannot sell it at a
  // profit. Worth saying before the invoice exists, not after.
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
          <label className={label} htmlFor={`to-${row.variantId}`}>
            {ar ? "إلى" : "To"}
          </label>
          <select
            id={`to-${row.variantId}`}
            name="toLocationId"
            required
            className={`${field} min-w-44`}
          >
            {destinations.map((d) => (
              <option key={d.id} value={d.id}>{d.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className={label} htmlFor={`date-${row.variantId}`}>
            {ar ? "التاريخ" : "Date"}
          </label>
          <input
            id={`date-${row.variantId}`}
            name="transferDate"
            type="date"
            required
            defaultValue={today}
            dir="ltr"
            className={`${field}`}
          />
        </div>

        <div className="ms-auto text-end">
          <p className="text-xs text-ink-500">{ar ? "قيمة الفاتورة" : "Invoice value"}</p>
          <p className="num text-lg font-semibold">{(qty * price).toFixed(2)}</p>
        </div>

        <button
          type="submit"
          disabled={pending || tooMany || qty <= 0 || !row.costSnapshotId}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {pending
            ? ar ? "جارٍ التحويل…" : "Transferring…"
            : ar ? "حوّل للبراند" : "Transfer to Brand"}
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
