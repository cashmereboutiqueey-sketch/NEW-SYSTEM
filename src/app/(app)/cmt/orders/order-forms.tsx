"use client";

import { useActionState, useState } from "react";
import {
  confirmOrderAction, completeOrderAction, cancelOrderAction,
  recordDepositAction, recordPaymentAction,
} from "./actions";
import { RequestIdField } from "@/components/request-id";
import type { FormState } from "@/components/entity-form";

const empty: FormState = {};
const field =
  "w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep";
const small =
  "w-full rounded-lg border border-ink-200 bg-panel px-2 py-1.5 text-sm outline-none focus:border-rose-deep";
const label = "mb-1 block text-xs font-medium text-ink-600";

export type ConfirmableQuote = {
  id: string;
  quoteNumber: string;
  description: string;
  clientCode: string;
  clientName: string;
  quantity: number;
  totalMinutes: string;
  quotedTotal: string;
};

/**
 * Turning an accepted quote into a commitment.
 *
 * The minutes are booked against the period when this runs. That is the whole
 * point: the capacity is spent whether or not anybody writes it down, and only
 * writing it down keeps the next quote honest about what is left.
 */
export function ConfirmForm({ ar, quotes }: { ar: boolean; quotes: ConfirmableQuote[] }) {
  const [state, action, pending] = useActionState(confirmOrderAction, empty);
  const [quoteId, setQuoteId] = useState(quotes[0]?.id ?? "");

  const today = new Date().toISOString().slice(0, 10);
  const quote = quotes.find((q) => q.id === quoteId);

  if (quotes.length === 0) {
    return (
      <p className="text-sm text-ink-500">
        {ar
          ? "مفيش عروض أسعار مقبولة مستنية تتحول لأوامر."
          : "There are no accepted quotes waiting to become orders."}
      </p>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="orderDate" value={today} />

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="quoteId">
            {ar ? "عرض السعر" : "Quote"}
          </label>
          <select
            id="quoteId" name="quoteId" required className={field}
            value={quoteId}
            onChange={(e) => setQuoteId(e.target.value)}
          >
            {quotes.map((q) => (
              <option key={q.id} value={q.id}>
                {q.quoteNumber} — {q.clientName} · {q.description} ({q.quantity})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="dueDate">
            {ar ? "ميعاد التسليم (اختياري)" : "Due date (optional)"}
          </label>
          <input id="dueDate" name="dueDate" type="date" dir="ltr" className={`${field} num`} />
        </div>
      </div>

      {quote && (
        <div className="rounded-lg border border-ink-200 bg-ink-50 p-3 text-sm">
          {ar ? "هيتحجز" : "This books"}{" "}
          <b className="num">{Number(quote.totalMinutes).toLocaleString()}</b>{" "}
          {ar ? "دقيقة من طاقة الشهر، مقابل" : "minutes of this month's capacity, for"}{" "}
          <b className="num">{Number(quote.quotedTotal).toLocaleString()}</b>
        </div>
      )}

      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      {state.success && <p className="text-sm text-good">{state.success}</p>}

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-ink-900 px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {pending ? (ar ? "بيتأكد…" : "Confirming…") : ar ? "أكّد الأمر" : "Confirm the order"}
      </button>
    </form>
  );
}

/** Closing a run out against what it actually took. */
export function CompleteForm({
  ar,
  cmtOrderId,
  quotedMinutes,
  orderedQty,
  unitPrice,
  depositHeld,
}: {
  ar: boolean;
  cmtOrderId: string;
  quotedMinutes: string;
  orderedQty: number;
  unitPrice: string;
  depositHeld: string;
}) {
  const [state, action, pending] = useActionState(completeOrderAction, empty);
  const [open, setOpen] = useState(false);
  const [minutes, setMinutes] = useState("");
  const [delivered, setDelivered] = useState(String(orderedQty));

  const today = new Date().toISOString().slice(0, 10);
  const quoted = Number(quotedMinutes);
  const actual = minutes === "" ? 0 : Number(minutes);
  const overrun = actual > 0 ? actual - quoted : null;
  // What the client will be billed, worked out in front of whoever is closing
  // the run: the invoice is pieces handed over, not pieces ordered.
  const pieces = delivered === "" ? 0 : Number(delivered);
  const invoice = pieces * Number(unitPrice);
  const afterDeposit = Math.max(0, invoice - Number(depositHeld));

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-ink-300 px-2.5 py-1 text-xs font-medium text-ink-700"
      >
        {ar ? "اقفل" : "Close out"}
      </button>
    );
  }

  return (
    <form action={action} className="min-w-[14rem] space-y-2">
      <input type="hidden" name="cmtOrderId" value={cmtOrderId} />
      <input type="hidden" name="completedAt" value={today} />

      <label className={label} htmlFor={`q-${cmtOrderId}`}>
        {ar ? "القطع السليمة اللي اتسلّمت" : "Good garments handed over"}
      </label>
      <input
        id={`q-${cmtOrderId}`} name="deliveredQty" type="number" min="1" step="1"
        max={orderedQty} required
        dir="ltr" className={`${small} num`} value={delivered}
        onChange={(e) => setDelivered(e.target.value)}
      />
      {pieces > 0 && (
        <p className="text-xs text-ink-500">
          {ar
            ? `الفاتورة ${invoice.toLocaleString()} (${pieces} × ${Number(unitPrice).toLocaleString()})`
            : `Invoice ${invoice.toLocaleString()} (${pieces} × ${Number(unitPrice).toLocaleString()})`}
          {Number(depositHeld) > 0 &&
            (ar
              ? ` — بعد خصم المقدّم ${Number(depositHeld).toLocaleString()} يتبقى ${afterDeposit.toLocaleString()}`
              : ` — ${afterDeposit.toLocaleString()} after the ${Number(depositHeld).toLocaleString()} deposit`)}
        </p>
      )}

      <label className={label} htmlFor={`m-${cmtOrderId}`}>
        {ar ? "الدقايق الفعلية" : "Minutes it actually took"}
      </label>
      <input
        id={`m-${cmtOrderId}`} name="actualMinutes" type="number" min="1" step="1" required
        dir="ltr" className={`${small} num`} value={minutes}
        onChange={(e) => setMinutes(e.target.value)}
      />

      {overrun !== null && (
        <p className={overrun > 0 ? "text-xs text-bad" : "text-xs text-good"}>
          {overrun > 0
            ? ar
              ? `زاد ${overrun.toLocaleString()} دقيقة عن المتفق (${quoted.toLocaleString()})`
              : `${overrun.toLocaleString()} minutes over the ${quoted.toLocaleString()} it was sold on`
            : ar
              ? `وفّر ${Math.abs(overrun).toLocaleString()} دقيقة`
              : `${Math.abs(overrun).toLocaleString()} minutes under`}
        </p>
      )}

      {state.error && <p className="text-xs text-bad">{state.error}</p>}
      {state.success && <p className="text-xs text-good">{state.success}</p>}

      <div className="flex gap-1.5">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-ink-900 px-3 py-1.5 text-xs text-white disabled:opacity-50"
        >
          {pending ? (ar ? "…" : "…") : ar ? "اقفل" : "Close"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg border border-ink-200 px-3 py-1.5 text-xs text-ink-600"
        >
          {ar ? "إلغاء" : "Cancel"}
        </button>
      </div>
    </form>
  );
}

/** Cancelling, which gives the booked minutes back. */
export function CancelForm({ ar, cmtOrderId }: { ar: boolean; cmtOrderId: string }) {
  const [state, action, pending] = useActionState(cancelOrderAction, empty);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-ink-200 px-2.5 py-1 text-xs text-ink-500"
      >
        {ar ? "ألغِ" : "Cancel"}
      </button>
    );
  }

  return (
    <form action={action} className="min-w-[13rem] space-y-2">
      <input type="hidden" name="cmtOrderId" value={cmtOrderId} />

      <label className={label} htmlFor={`r-${cmtOrderId}`}>
        {ar ? "السبب" : "Reason"}
      </label>
      <input id={`r-${cmtOrderId}`} name="reason" required className={small} maxLength={300} />

      <p className="text-[11px] text-ink-400">
        {ar
          ? "الدقايق المحجوزة هترجع للطاقة المتاحة."
          : "The booked minutes go back to available capacity."}
      </p>

      {state.error && <p className="text-xs text-bad">{state.error}</p>}
      {state.success && <p className="text-xs text-good">{state.success}</p>}

      <div className="flex gap-1.5">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-bad px-3 py-1.5 text-xs text-white disabled:opacity-50"
        >
          {ar ? "ألغِ الأمر" : "Cancel it"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg border border-ink-200 px-3 py-1.5 text-xs text-ink-600"
        >
          {ar ? "رجوع" : "Back"}
        </button>
      </div>
    </form>
  );
}

/**
 * Money against an order: the deposit before the work, the settlement after.
 *
 * One form for both, because from the person taking the money it is the same
 * act — what differs is only which side of the invoice it falls on, and the
 * screen already knows that.
 */
export function MoneyForm({
  ar,
  cmtOrderId,
  kind,
  outstanding,
}: {
  ar: boolean;
  cmtOrderId: string;
  kind: "DEPOSIT" | "SETTLEMENT";
  /** Only for a settlement: what is still owed on the invoice. */
  outstanding?: string;
}) {
  const [state, action, pending] = useActionState(
    kind === "DEPOSIT" ? recordDepositAction : recordPaymentAction,
    empty,
  );
  const [open, setOpen] = useState(false);
  const today = new Date().toISOString().slice(0, 10);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-ink-300 px-2.5 py-1 text-xs font-medium text-ink-700"
      >
        {kind === "DEPOSIT" ? (ar ? "سجّل مقدّم" : "Deposit") : ar ? "حصّل" : "Collect"}
      </button>
    );
  }

  return (
    <form action={action} className="min-w-[14rem] space-y-2">
      <RequestIdField state={state} />
      <input type="hidden" name="cmtOrderId" value={cmtOrderId} />
      <input type="hidden" name="paidOn" value={today} />

      <label className={label} htmlFor={`a-${kind}-${cmtOrderId}`}>
        {ar ? "المبلغ" : "Amount"}
      </label>
      <input
        id={`a-${kind}-${cmtOrderId}`} name="amount" type="number" min="0.01" step="0.01"
        required dir="ltr" className={`${small} num`}
        defaultValue={kind === "SETTLEMENT" ? outstanding : undefined}
      />
      {kind === "SETTLEMENT" && outstanding && (
        <p className="text-xs text-ink-500">
          {ar ? `المستحق ${Number(outstanding).toLocaleString()}` : `${Number(outstanding).toLocaleString()} owed`}
        </p>
      )}

      <label className={label} htmlFor={`me-${kind}-${cmtOrderId}`}>
        {ar ? "جت إزاي" : "How it arrived"}
      </label>
      <select id={`me-${kind}-${cmtOrderId}`} name="method" className={small} defaultValue="BANK_TRANSFER">
        <option value="BANK_TRANSFER">{ar ? "تحويل بنكي" : "Bank transfer"}</option>
        <option value="INSTAPAY">{ar ? "إنستاباي" : "InstaPay"}</option>
        <option value="CASH">{ar ? "كاش" : "Cash"}</option>
        <option value="CARD">{ar ? "فيزا" : "Card"}</option>
      </select>

      <input
        name="reference" placeholder={ar ? "مرجع (اختياري)" : "Reference (optional)"}
        className={small}
      />

      {state.error && <p className="text-xs text-bad">{state.error}</p>}
      {state.success && <p className="text-xs text-good">{state.success}</p>}

      <div className="flex gap-1.5">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-ink-900 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
        >
          {pending ? (ar ? "بيتسجل…" : "Saving…") : ar ? "سجّل" : "Record"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg border border-ink-200 px-2.5 py-1 text-xs text-ink-600"
        >
          {ar ? "إلغاء" : "Cancel"}
        </button>
      </div>
    </form>
  );
}
