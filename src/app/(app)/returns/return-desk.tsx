"use client";

import { useActionState, useState, useTransition } from "react";
import {
  loadOrderAction,
  recordReturnAction,
  type OrderPicture,
  type ReturnState,
} from "./actions";

const empty: ReturnState = {};
const field =
  "rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm outline-none focus:border-ink-500";

type OrderRow = {
  id: string;
  orderNumber: string;
  orderDate: string;
  customerName: string | null;
  customerPhone: string | null;
  netAmount: string;
  units: number;
  returnedUnits: number;
  fullyReturned: boolean;
};

/**
 * The counter conversation, in order: which order, which garment, what state
 * it is in, and what the customer gets back.
 *
 * The refund box is pre-filled with what they actually paid — after any
 * discount — because that is the number in dispute nine times out of ten, and
 * a cashier working it out from a ticket price will get it wrong in the
 * shop's favour and lose the customer.
 */
export function ReturnDesk({
  ar,
  initialQuery,
  orders,
}: {
  ar: boolean;
  initialQuery: string;
  orders: OrderRow[];
}) {
  const [state, action, pending] = useActionState(recordReturnAction, empty);
  const [query, setQuery] = useState(initialQuery);
  const [picture, setPicture] = useState<OrderPicture | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [variantId, setVariantId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [refund, setRefund] = useState("");
  const [disposition, setDisposition] = useState("RESTOCK");
  const [refundMethod, setRefundMethod] = useState("CASH");
  const [loading, startLoading] = useTransition();

  const today = new Date().toISOString().slice(0, 10);

  const visible = orders.filter((o) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      o.orderNumber.toLowerCase().includes(q) ||
      (o.customerName ?? "").toLowerCase().includes(q) ||
      (o.customerPhone ?? "").includes(q)
    );
  });

  const line = picture?.lines.find((l) => l.variantId === variantId);
  const paid = line ? Number(line.unitPrice) * Number(quantity || 0) : 0;

  function open(orderId: string) {
    setLoadError(null);
    setPicture(null);
    setVariantId("");
    startLoading(async () => {
      const result = await loadOrderAction(orderId);
      if ("error" in result) setLoadError(result.error);
      else {
        setPicture(result);
        const first = result.lines.find((l) => l.returnable > 0);
        if (first) {
          setVariantId(first.variantId);
          setQuantity("1");
          setRefund(first.unitPrice);
        }
      }
    });
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={ar ? "رقم الطلب، اسم الزبون، أو التليفون" : "Order number, name or phone"}
          className={`${field} w-72`}
        />
        {picture && (
          <button
            type="button"
            onClick={() => { setPicture(null); setVariantId(""); }}
            className="text-xs text-ink-500 underline"
          >
            {ar ? "طلب تاني" : "Different order"}
          </button>
        )}
      </div>

      {!picture && (
        <div className="max-h-64 overflow-y-auto rounded-lg border border-ink-200">
          {visible.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-400">
              {ar ? "مفيش طلب مطابق." : "No order matches."}
            </p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {visible.map((o) => (
                  <tr key={o.id} className="border-b border-ink-100 last:border-0">
                    <td className="px-3 py-2 num text-xs" dir="ltr">{o.orderNumber}</td>
                    <td className="px-3 py-2 num text-xs text-ink-400" dir="ltr">{o.orderDate}</td>
                    <td className="px-3 py-2">{o.customerName ?? "—"}</td>
                    <td className="px-3 py-2 num text-xs">{Number(o.netAmount).toFixed(2)}</td>
                    <td className="px-3 py-2 text-xs text-ink-500">
                      {o.returnedUnits > 0 && (
                        <span className={o.fullyReturned ? "text-bad" : "text-warn"}>
                          {ar
                            ? `رجع ${o.returnedUnits} من ${o.units}`
                            : `${o.returnedUnits} of ${o.units} back`}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-end">
                      <button
                        type="button"
                        onClick={() => open(o.id)}
                        disabled={loading || o.fullyReturned}
                        className="rounded-lg border border-ink-300 px-2.5 py-1 text-xs font-medium text-ink-700 disabled:opacity-40"
                      >
                        {o.fullyReturned ? (ar ? "رجع كله" : "all back") : ar ? "افتح" : "Open"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {loadError && <p className="mt-2 text-sm text-bad">{loadError}</p>}

      {picture && (
        <form action={action} className="space-y-3">
          <input type="hidden" name="salesOrderId" value={picture.order.id} />
          <input type="hidden" name="returnDate" value={today} />

          <div className="rounded-lg bg-ink-100 px-3 py-2 text-sm">
            <span className="num text-xs" dir="ltr">{picture.order.orderNumber}</span>
            {picture.order.customerName && (
              <span className="ms-3">{picture.order.customerName}</span>
            )}
            <span className="ms-3 text-xs text-ink-500">
              {ar ? `عمره ${picture.order.daysOld} يوم` : `${picture.order.daysOld} days old`}
            </span>
            {picture.order.pastWindow && (
              <span className="ms-3 text-xs text-warn">
                {ar
                  ? `خارج مهلة الـ ${picture.order.windowDays} يوم — قرارك`
                  : `past the ${picture.order.windowDays}-day window — your call`}
              </span>
            )}
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            <label className="text-sm lg:col-span-2">
              <span className="mb-1 block text-ink-600">{ar ? "الراجع إيه" : "Which garment"}</span>
              <select
                name="variantId"
                value={variantId}
                onChange={(e) => {
                  setVariantId(e.target.value);
                  const l = picture.lines.find((x) => x.variantId === e.target.value);
                  setQuantity("1");
                  setRefund(l?.unitPrice ?? "");
                }}
                required
                className={`${field} w-full`}
              >
                {picture.lines.map((l) => (
                  <option key={l.variantId} value={l.variantId} disabled={l.returnable === 0}>
                    {l.styleName} · {l.colour} · {l.size} —{" "}
                    {l.returnable > 0
                      ? ar ? `يقدر يرجع ${l.returnable}` : `${l.returnable} returnable`
                      : ar ? "رجع كله" : "all back"}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-sm">
              <span className="mb-1 block text-ink-600">{ar ? "عدد" : "How many"}</span>
              <input
                name="quantity"
                type="number"
                min="1"
                max={line?.returnable ?? 1}
                value={quantity}
                onChange={(e) => {
                  setQuantity(e.target.value);
                  if (line) {
                    setRefund(
                      (Number(line.unitPrice) * Number(e.target.value || 0)).toFixed(2),
                    );
                  }
                }}
                required
                dir="ltr"
                className={`${field} w-full text-end`}
              />
            </label>

            <label className="text-sm">
              <span className="mb-1 block text-ink-600">{ar ? "حالة القطعة" : "Condition"}</span>
              <select
                name="disposition"
                value={disposition}
                onChange={(e) => setDisposition(e.target.value)}
                className={`${field} w-full`}
              >
                <option value="RESTOCK">{ar ? "سليمة — ترجع المخزن" : "Fine — back on the rail"}</option>
                <option value="REPAIR_AND_RESTOCK">{ar ? "محتاجة تصليح" : "Needs repair"}</option>
                <option value="WRITE_OFF">{ar ? "مش صالحة للبيع" : "Not resellable"}</option>
              </select>
            </label>

            <label className="text-sm">
              <span className="mb-1 block text-ink-600">{ar ? "الفلوس ترجع إزاي" : "Refund by"}</span>
              <select
                name="refundMethod"
                value={refundMethod}
                onChange={(e) => setRefundMethod(e.target.value)}
                className={`${field} w-full`}
              >
                <option value="CASH">{ar ? "كاش من الدرج" : "Cash"}</option>
                <option value="BANK_TRANSFER">{ar ? "تحويل" : "Transfer"}</option>
                <option value="CARD">{ar ? "على الفيزا" : "Card"}</option>
                {Number(picture.order.outstanding) > 0 && (
                  <option value="AGAINST_BALANCE">
                    {ar
                      ? `يتخصم من اللي عليه (${Number(picture.order.outstanding).toFixed(2)})`
                      : `Against what they owe (${Number(picture.order.outstanding).toFixed(2)})`}
                  </option>
                )}
              </select>
            </label>

            <label className="text-sm">
              <span className="mb-1 block text-ink-600">{ar ? "المبلغ" : "Amount"}</span>
              <input
                name="refundAmount"
                type="number"
                step="0.01"
                min="0"
                max={paid}
                value={refund}
                onChange={(e) => setRefund(e.target.value)}
                dir="ltr"
                className={`${field} w-full text-end`}
              />
            </label>
          </div>

          <label className="block text-sm">
            <span className="mb-1 block text-ink-600">{ar ? "السبب" : "Reason"}</span>
            <input
              name="reason"
              placeholder={ar ? "المقاس، اللون، عيب في الخياطة…" : "Size, colour, a fault…"}
              className={`${field} w-full`}
            />
          </label>

          {line && (
            <p className="text-xs text-ink-500">
              {ar
                ? `دفع ${paid.toFixed(2)} في العدد ده.`
                : `They paid ${paid.toFixed(2)} for that many.`}
              {disposition === "WRITE_OFF" && (
                <span className="ms-2 text-warn">
                  {ar
                    ? "مش هترجع المخزن — تكلفتها هتتقيد خسارة."
                    : "It will not go back on the rail; its cost is written off."}
                </span>
              )}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={pending || !variantId || Number(quantity) < 1}
              className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {pending ? (ar ? "بيتسجّل…" : "Recording…") : ar ? "سجّل المرتجع" : "Record the return"}
            </button>
            {state.error && <p className="text-sm text-bad">{state.error}</p>}
            {state.success && <p className="text-sm text-good">{state.success}</p>}
          </div>
        </form>
      )}
    </div>
  );
}
