"use client";

import { useActionState, useState } from "react";
import { createClientAction, createQuoteAction, setQuoteStatusAction } from "./actions";
import type { FormState } from "@/components/entity-form";
import type { Locale } from "@/lib/i18n";

const initial: FormState = {};
const field =
  "rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm text-ink-900 " +
  "focus:border-rose-deep focus:outline-none focus:ring-1 focus:ring-rose";
const label = "mb-1 block text-xs font-medium text-ink-600";

export function ClientForm({ locale }: { locale: Locale }) {
  const [state, formAction, pending] = useActionState(createClientAction, initial);
  const ar = locale === "ar";

  return (
    <form action={formAction} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className={label} htmlFor="cl-code">{ar ? "الكود" : "Code"}</label>
          <input id="cl-code" name="code" required dir="ltr" className={`${field} w-full`} />
        </div>
        <div className="sm:col-span-2">
          <label className={label} htmlFor="cl-name">{ar ? "الاسم" : "Name"}</label>
          <input id="cl-name" name="name" required className={`${field} w-full`} />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <label className={label} htmlFor="cl-contact">{ar ? "المسؤول" : "Contact"}</label>
          <input id="cl-contact" name="contactPerson" className={`${field} w-full`} />
        </div>
        <div>
          <label className={label} htmlFor="cl-phone">{ar ? "التليفون" : "Phone"}</label>
          <input id="cl-phone" name="phone" dir="ltr" className={`${field} w-full`} />
        </div>
        <div>
          <label className={label} htmlFor="cl-email">{ar ? "الإيميل" : "Email"}</label>
          <input id="cl-email" name="email" type="email" dir="ltr" className={`${field} w-full`} />
        </div>
        <div>
          <label className={label} htmlFor="cl-credit">{ar ? "أيام الائتمان" : "Credit days"}</label>
          <input
            id="cl-credit" name="creditDays" type="number" min="0" defaultValue={0}
            dir="ltr" className={`${field} num w-full`}
          />
        </div>
      </div>
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
      >
        {pending ? (ar ? "…" : "…") : ar ? "أضف العميل" : "Add the client"}
      </button>
      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      {state.success && <p className="text-sm text-good">{state.success}</p>}
    </form>
  );
}

/**
 * Pricing a job.
 *
 * The floor is shown live and the button locks below it. Quoting under the
 * full-capacity rate means the Brand is paying part of a stranger's bill,
 * which is the one thing the whole costing model exists to prevent.
 */
export function QuoteForm({
  locale,
  clients,
  basis,
  today,
}: {
  locale: Locale;
  clients: { id: string; label: string }[];
  basis: {
    floorMinuteRate: string;
    actualMinuteRate: string;
    freeMinutes: string;
    label: string;
  } | null;
  today: string;
}) {
  const [state, formAction, pending] = useActionState(createQuoteAction, initial);
  const [rate, setRate] = useState(basis ? Number(basis.actualMinuteRate).toFixed(4) : "");
  const [quantity, setQuantity] = useState("");
  const [smv, setSmv] = useState("");
  const ar = locale === "ar";

  const floor = Number(basis?.floorMinuteRate ?? 0);
  const quoted = Number(rate) || 0;
  const minutes = (Number(quantity) || 0) * (Number(smv) || 0);
  const total = minutes * quoted;

  const belowFloor = basis != null && quoted > 0 && quoted < floor;
  const overCapacity = basis != null && minutes > Number(basis.freeMinutes);
  const marginOverFloor = floor > 0 ? (quoted - floor) / floor : 0;

  return (
    <form action={formAction} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <label className={label} htmlFor="q-client">{ar ? "العميل" : "Client"}</label>
          <select id="q-client" name="clientId" required className={`${field} w-full`}>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="q-date">{ar ? "تاريخ العرض" : "Quote date"}</label>
          <input
            id="q-date" name="quoteDate" type="date" required defaultValue={today}
            dir="ltr" className={`${field} w-full`}
          />
        </div>
        <div>
          <label className={label} htmlFor="q-valid">{ar ? "صالح حتى" : "Valid until"}</label>
          <input id="q-valid" name="validUntil" type="date" dir="ltr" className={`${field} w-full`} />
        </div>
      </div>

      <div>
        <label className={label} htmlFor="q-desc">{ar ? "وصف الموديل" : "What they want made"}</label>
        <input id="q-desc" name="styleDescription" required className={`${field} w-full`} />
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <label className={label} htmlFor="q-qty">{ar ? "الكمية" : "Quantity"}</label>
          <input
            id="q-qty" name="quantity" type="number" min="1" step="1" required
            value={quantity} onChange={(e) => setQuantity(e.target.value)}
            dir="ltr" className={`${field} num w-full`}
          />
        </div>
        <div>
          <label className={label} htmlFor="q-smv">{ar ? "دقائق القطعة" : "Minutes per garment"}</label>
          <input
            id="q-smv" name="smvPerUnit" type="number" min="0.1" step="0.1" required
            value={smv} onChange={(e) => setSmv(e.target.value)}
            dir="ltr" className={`${field} num w-full`}
          />
        </div>
        <div>
          <label className={label} htmlFor="q-rate">{ar ? "سعر الدقيقة" : "Rate per minute"}</label>
          <input
            id="q-rate" name="quotedMinuteRate" type="number" min="0" step="0.0001" required
            value={rate} onChange={(e) => setRate(e.target.value)}
            dir="ltr"
            className={`${field} num w-full ${belowFloor ? "border-bad" : ""}`}
          />
          {basis && (
            <p className="mt-1 text-xs text-ink-400">
              {ar ? "الحد الأدنى" : "Floor"}{" "}
              <span className="num">{Number(basis.floorMinuteRate).toFixed(4)}</span>
            </p>
          )}
        </div>
        <div className="text-end">
          <p className="text-xs text-ink-500">{ar ? "قيمة العرض" : "Quote total"}</p>
          <p className="num text-lg font-semibold">{total.toFixed(2)}</p>
          {minutes > 0 && (
            <p className="text-xs text-ink-400">
              <span className="num">{minutes.toFixed(0)}</span> {ar ? "دقيقة" : "minutes"}
            </p>
          )}
        </div>
      </div>

      <div>
        <label className={label} htmlFor="q-notes">{ar ? "ملاحظات" : "Notes"}</label>
        <input id="q-notes" name="notes" className={`${field} w-full`} />
      </div>

      {belowFloor && (
        <p className="text-sm text-bad">
          {ar
            ? `${quoted.toFixed(4)} تحت الحد الأدنى ${floor.toFixed(4)}. كده البراند بيدفع جزء من فاتورة العميل ده.`
            : `${quoted.toFixed(4)} is under the ${floor.toFixed(4)} floor. At that price the Brand is paying part of this client's bill.`}
        </p>
      )}

      {!belowFloor && quoted > 0 && basis && (
        <p className="text-sm text-good">
          {ar
            ? `${(marginOverFloor * 100).toFixed(1)}% فوق الحد الأدنى. كل دقيقة هنا بتنزّل تكلفة الدقيقة اللي البراند بيدفعها.`
            : `${(marginOverFloor * 100).toFixed(1)}% above the floor. Every minute here lowers the rate the Brand itself pays.`}
        </p>
      )}

      {overCapacity && basis && (
        <p className="text-sm text-warn">
          {ar
            ? `العرض محتاج ${minutes.toFixed(0)} دقيقة والشهر فيه ${Number(basis.freeMinutes).toFixed(0)} فاضية بس — يا توظّف، يا تأخّر المواعيد.`
            : `This needs ${minutes.toFixed(0)} minutes and the month has ${Number(basis.freeMinutes).toFixed(0)} free — either hire, or push the dates out.`}
        </p>
      )}

      <button
        type="submit"
        disabled={pending || belowFloor || !basis}
        className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
      >
        {pending ? (ar ? "…" : "…") : ar ? "اعمل عرض السعر" : "Price it"}
      </button>

      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      {state.success && <p className="text-sm text-good">{state.success}</p>}
    </form>
  );
}

export function QuoteStatusForm({
  locale,
  quoteId,
  status,
}: {
  locale: Locale;
  quoteId: string;
  status: string;
}) {
  const [state, formAction, pending] = useActionState(setQuoteStatusAction, initial);
  const ar = locale === "ar";

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="quoteId" value={quoteId} />
      <select
        name="status"
        defaultValue={status === "DRAFT" ? "SENT" : "ACCEPTED"}
        className="rounded-lg border border-ink-200 bg-panel px-2 py-1 text-xs text-ink-700"
      >
        <option value="SENT">{ar ? "اتبعت" : "Sent"}</option>
        <option value="ACCEPTED">{ar ? "اتقبل" : "Accepted"}</option>
        <option value="REJECTED">{ar ? "اترفض" : "Rejected"}</option>
        <option value="EXPIRED">{ar ? "انتهى" : "Expired"}</option>
      </select>
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg border border-ink-300 px-2 py-1 text-xs text-ink-700 disabled:opacity-40"
      >
        {pending ? "…" : ar ? "حدّث" : "Set"}
      </button>
      {state.error && <span className="text-xs text-bad">{state.error}</span>}
    </form>
  );
}
