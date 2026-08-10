"use client";

import { useActionState, useMemo, useState } from "react";
import { recordSettlementAction } from "./actions";
import type { FormState } from "@/components/entity-form";
import type { Locale } from "@/lib/i18n";

const initial: FormState = {};
const field =
  "rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 " +
  "focus:border-ink-400 focus:outline-none focus:ring-1 focus:ring-ink-300";
const label = "mb-1 block text-xs font-medium text-ink-600";

export type OutstandingPayment = {
  paymentId: string;
  orderNumber: string;
  orderDate: string;
  customer: string | null;
  city: string | null;
  channel: string;
  gross: string;
  fee: string;
  expected: string;
  daysOutstanding: number;
};

/**
 * Clearing a remittance.
 *
 * The orders are ticked one by one rather than settled as a total, because
 * that is the difference between "the courier paid 4,000 less than expected"
 * and "the courier never paid for order SO-2026-08-0142". A parcel nobody paid
 * for should be left unticked so it stays outstanding, not explained away in a
 * variance note.
 */
export function SettlementForm({
  locale,
  provider,
  entityId,
  payments,
  channels,
  today,
}: {
  locale: Locale;
  provider: "COURIER" | "PAYMENT_GATEWAY";
  entityId: string;
  payments: OutstandingPayment[];
  channels: { id: string; label: string }[];
  today: string;
}) {
  const [state, formAction, pending] = useActionState(recordSettlementAction, initial);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [netReceived, setNetReceived] = useState("");
  const ar = locale === "ar";

  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const expected = useMemo(
    () =>
      payments
        .filter((p) => chosen.has(p.paymentId))
        .reduce((s, p) => s + Number(p.expected), 0),
    [payments, chosen],
  );

  const received = Number(netReceived) || 0;
  const variance = netReceived === "" ? 0 : Math.round((received - expected) * 100) / 100;
  const needsNote = netReceived !== "" && variance !== 0;

  if (payments.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-ink-400">
        {ar
          ? "مفيش فلوس مستنية تحصيل — كل حاجة اتوردت."
          : "Nothing is outstanding — everything has been paid over."}
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="provider" value={provider} />
      <input type="hidden" name="entityId" value={entityId} />
      <input type="hidden" name="paymentIds" value={[...chosen].join(",")} />

      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <label className={label} htmlFor={`st-date-${provider}`}>
            {ar ? "تاريخ التوريد" : "Remittance date"}
          </label>
          <input
            id={`st-date-${provider}`} name="settlementDate" type="date" required
            defaultValue={today} dir="ltr" className={`${field} w-full`}
          />
        </div>
        <div>
          <label className={label} htmlFor={`st-ref-${provider}`}>
            {ar ? "رقم الدفعة عندهم" : "Their batch reference"}
          </label>
          <input id={`st-ref-${provider}`} name="reference" dir="ltr" className={`${field} w-full`} />
        </div>
        <div>
          <label className={label} htmlFor={`st-ch-${provider}`}>
            {ar ? "القناة" : "Channel"}
          </label>
          <select id={`st-ch-${provider}`} name="channelId" className={`${field} w-full`}>
            <option value="">{ar ? "كلها" : "All"}</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor={`st-net-${provider}`}>
            {ar ? "اللي وصل البنك" : "What landed in the bank"}
          </label>
          <input
            id={`st-net-${provider}`} name="netReceived" type="number" step="0.01" min="0" required
            value={netReceived} onChange={(e) => setNetReceived(e.target.value)}
            dir="ltr" className={`${field} num w-full`}
          />
        </div>
      </div>

      <div className="rounded-lg border border-ink-200">
        <div className="flex items-center justify-between border-b border-ink-100 px-3 py-2 text-xs text-ink-500">
          <span>
            {ar ? "علّم الأوردرات اللي التوريدة دي بتغطيها" : "Tick the orders this remittance covers"}
          </span>
          <button
            type="button"
            onClick={() =>
              setChosen((prev) =>
                prev.size === payments.length
                  ? new Set()
                  : new Set(payments.map((p) => p.paymentId)),
              )
            }
            className="text-ink-600 underline decoration-ink-300 underline-offset-2"
          >
            {chosen.size === payments.length
              ? ar ? "شيل الكل" : "Clear all"
              : ar ? "علّم الكل" : "Select all"}
          </button>
        </div>

        <ul className="max-h-80 divide-y divide-ink-100 overflow-y-auto">
          {payments.map((p) => (
            <li key={p.paymentId} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <input
                type="checkbox"
                checked={chosen.has(p.paymentId)}
                onChange={() => toggle(p.paymentId)}
                className="h-4 w-4"
                aria-label={p.orderNumber}
              />
              <code dir="ltr" className="text-xs text-ink-500">{p.orderNumber}</code>
              <span className="num text-xs text-ink-400" dir="ltr">{p.orderDate}</span>
              <span className="flex-1 text-sm">
                {p.customer ?? (ar ? "بدون عميل" : "no customer")}
                {p.city && <span className="ms-2 text-xs text-ink-400">{p.city}</span>}
              </span>
              <span className="num text-xs text-ink-400">
                {ar ? "إجمالي" : "gross"} {Number(p.gross).toFixed(2)}
              </span>
              <span className="num text-sm font-medium">{Number(p.expected).toFixed(2)}</span>
              <span
                className={
                  p.daysOutstanding > 30
                    ? "num text-xs text-bad"
                    : p.daysOutstanding > 14
                      ? "num text-xs text-warn"
                      : "num text-xs text-ink-400"
                }
              >
                {p.daysOutstanding} {ar ? "يوم" : "d"}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <span>
          {ar ? "المتوقع" : "Expected"}{" "}
          <span className="num font-medium">{expected.toFixed(2)}</span>
        </span>
        <span>
          {ar ? "اللي وصل" : "Received"}{" "}
          <span className="num font-medium">{received.toFixed(2)}</span>
        </span>
        {netReceived !== "" && (
          <span className={variance === 0 ? "text-good" : variance < 0 ? "text-bad" : "text-warn"}>
            {variance === 0
              ? ar ? "مطابق بالقرش" : "Matches to the piastre"
              : `${ar ? "فرق" : "Out by"} ${variance.toFixed(2)}`}
          </span>
        )}
      </div>

      {needsNote && (
        <div>
          <label className={label} htmlFor={`st-note-${provider}`}>
            {variance < 0
              ? ar ? "ورّدوا ناقص — ليه؟" : "They paid short — why?"
              : ar ? "ورّدوا زيادة — ليه؟" : "They paid over — why?"}
          </label>
          <input
            id={`st-note-${provider}`} name="varianceNote" required
            placeholder={
              ar ? "رسوم إضافية، خصم مرتجع…" : "extra handling charge, a refund credited back…"
            }
            className={`${field} w-full`}
          />
          <p className="mt-1 text-xs text-ink-500">
            {ar
              ? "لو الفرق ده أوردر محدش ورّد فلوسه — شيل العلامة عنه بدل ما تفسّر الفرق، عشان يفضل ظاهر إنه مستحق."
              : "If the gap is an order nobody paid for, untick it instead of explaining the difference — it should stay visible as outstanding."}
          </p>
        </div>
      )}

      <button
        type="submit"
        disabled={pending || chosen.size === 0 || netReceived === ""}
        className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
      >
        {pending
          ? ar ? "بيقيّد…" : "Posting…"
          : ar ? `سجّل التوريد · ${chosen.size} أوردر` : `Record the remittance · ${chosen.size} orders`}
      </button>

      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      {state.success && <p className="text-sm text-good">{state.success}</p>}
    </form>
  );
}
