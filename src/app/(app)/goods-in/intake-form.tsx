"use client";

import { useActionState, useState } from "react";
import { receiveAtBrandAction } from "./actions";
import type { FormState } from "@/components/entity-form";
import type { Locale } from "@/lib/i18n";

const initial: FormState = {};
const field =
  "rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 " +
  "focus:border-ink-400 focus:outline-none focus:ring-1 focus:ring-ink-300";
const label = "mb-1 block text-xs font-medium text-ink-600";

export type IntakeRow = {
  despatchNumber: string;
  variantId: string;
  sku: string;
  styleId: string;
  expectedQty: string;
  transferPrice: string | null;
};

/**
 * Counting a delivery in.
 *
 * The counted quantity starts blank rather than pre-filled with what the note
 * claims. A box that already says 31 gets confirmed without anyone opening it,
 * which defeats the point of counting.
 */
export function IntakeForm({
  locale,
  row,
  destinations,
  today,
}: {
  locale: Locale;
  row: IntakeRow;
  destinations: { id: string; label: string }[];
  today: string;
}) {
  const [state, formAction, pending] = useActionState(receiveAtBrandAction, initial);
  const [counted, setCounted] = useState("");
  const [labelled, setLabelled] = useState(false);
  const ar = locale === "ar";

  const expected = Number(row.expectedQty);
  const qty = counted === "" ? null : Number(counted);
  const shortfall = qty == null ? 0 : expected - qty;
  const tooMany = qty != null && qty > expected;
  const price = Number(row.transferPrice ?? 0);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="despatchNumber" value={row.despatchNumber} />
      <input type="hidden" name="variantId" value={row.variantId} />

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className={label} htmlFor={`c-${row.variantId}`}>
            {ar ? "العدد اللي وصل" : "Counted"}
          </label>
          <input
            id={`c-${row.variantId}`}
            name="countedQty"
            type="number"
            step="1"
            min="1"
            max={expected}
            required
            value={counted}
            onChange={(e) => setCounted(e.target.value)}
            placeholder={ar ? "عُدّها" : "count them"}
            dir="ltr"
            className={`${field} num w-28`}
          />
          <p className="mt-1 text-xs text-ink-400">
            {ar ? "المصنع باعت" : "The note says"} <span className="num">{expected}</span>
          </p>
        </div>

        <div>
          <label className={label} htmlFor={`to-${row.variantId}`}>
            {ar ? "إلى" : "Into"}
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
          <label className={label} htmlFor={`rd-${row.variantId}`}>
            {ar ? "تاريخ الاستلام" : "Received"}
          </label>
          <input
            id={`rd-${row.variantId}`}
            name="receivedDate"
            type="date"
            required
            defaultValue={today}
            dir="ltr"
            className={field}
          />
        </div>

        <div className="ms-auto text-end">
          <p className="text-xs text-ink-500">{ar ? "قيمة الفاتورة" : "Invoice value"}</p>
          <p className="num text-lg font-semibold">{((qty ?? 0) * price).toFixed(2)}</p>
        </div>
      </div>

      {/* ------------------------------------------------------ the label gate */}
      <div className="rounded-lg border border-ink-200 bg-paper-50 p-3">
        <div className="flex flex-wrap items-center gap-3">
          <a
            href={`/print/labels/${row.styleId}?stock=1`}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-ink-300 px-3 py-1.5 text-sm text-ink-700"
          >
            {ar ? "اطبع الليبل والباركود" : "Print the labels"}
          </a>
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              name="labelsPrinted"
              checked={labelled}
              onChange={(e) => setLabelled(e.target.checked)}
              className="h-4 w-4"
            />
            {ar ? "اتطبعت واتلبّست على القطع" : "Printed and applied to the garments"}
          </label>
        </div>
        <p className="mt-2 text-xs text-ink-500">
          {ar
            ? "القطعة من غير باركود مايقدرش الكاشير يقراها ولا الجرد يعدّها، عشان كده مافيش حاجة تدخل المعرض قبل التكويد."
            : "A garment with no barcode cannot be rung up or counted, so nothing reaches the floor before it is tagged."}
        </p>
      </div>

      {shortfall > 0 && qty != null && (
        <div>
          <label className={label} htmlFor={`sn-${row.variantId}`}>
            {ar ? `ناقص ${shortfall} — إيه اللي حصل؟` : `${shortfall} short — what happened?`}
          </label>
          <input
            id={`sn-${row.variantId}`}
            name="shortfallNote"
            type="text"
            placeholder={ar ? "اتكسرت، اتسرقت، غلط في العد…" : "damaged, lost, miscounted…"}
            className={`${field} w-full`}
          />
          <p className="mt-1 text-sm text-warn">
            {ar
              ? `الـ ${shortfall} دول هيتحملهم المصنع كفاقد غير طبيعي، والبراند هيتفوترله ${qty} بس.`
              : `Those ${shortfall} go to the factory as an abnormal loss; the Brand is invoiced for ${qty} only.`}
          </p>
        </div>
      )}

      {tooMany && (
        <p className="text-sm text-bad">
          {ar
            ? `إذن الشحن بيقول ${expected}. مش ممكن يوصل أكتر من اللي اتبعت — راجع العد.`
            : `The note says ${expected}. More cannot arrive than left — check the count.`}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending || !labelled || qty == null || qty <= 0 || tooMany}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {pending
            ? ar ? "جارٍ الاستلام…" : "Receiving…"
            : ar ? "استلم وادخل المعرض" : "Receive onto the floor"}
        </button>
        {!labelled && (
          <span className="text-xs text-ink-400">
            {ar ? "أكّد التكويد الأول" : "Confirm the labelling first"}
          </span>
        )}
      </div>

      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      {state.success && <p className="text-sm text-good">{state.success}</p>}
    </form>
  );
}
