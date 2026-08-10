"use client";

import { useActionState, useState } from "react";
import { collectPaymentAction, type ReceivableState } from "./actions";

const empty: ReceivableState = {};

type Order = {
  id: string;
  orderNumber: string;
  outstanding: string;
  dueDate: string | null;
};

/**
 * Taking money against one order.
 *
 * One order at a time rather than "paying the account": when a customer says
 * they are paying for the black coat, the record should say that too, or a
 * dispute six weeks later has nothing to point at.
 */
export function CollectForm({
  customerName,
  orders,
  ar,
}: {
  customerName: string;
  orders: Order[];
  ar: boolean;
}) {
  const [state, action, pending] = useActionState(collectPaymentAction, empty);
  const [open, setOpen] = useState(false);
  const [orderId, setOrderId] = useState(orders[0]?.id ?? "");
  const [amount, setAmount] = useState("");

  const today = new Date().toISOString().slice(0, 10);
  const selected = orders.find((o) => o.id === orderId) ?? orders[0];
  const owed = Number(selected?.outstanding ?? 0);
  const typed = amount === "" ? 0 : Number(amount);
  const tooMuch = typed > owed;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-ink-300 px-2.5 py-1 text-xs font-medium text-ink-700"
      >
        {ar ? "تحصيل" : "Collect"}
      </button>
    );
  }

  return (
    <form action={action} className="min-w-[18rem] rounded-lg border border-ink-200 bg-white p-3">
      <p className="mb-2 text-xs font-medium text-ink-700">
        {ar ? `تحصيل من ${customerName}` : `Collect from ${customerName}`}
      </p>

      <input type="hidden" name="collectedOn" value={today} />

      <label className="mb-2 block text-xs">
        <span className="mb-1 block text-ink-500">{ar ? "على أي طلب" : "Against"}</span>
        <select
          name="salesOrderId"
          value={orderId}
          onChange={(e) => setOrderId(e.target.value)}
          className="w-full rounded-lg border border-ink-200 px-2 py-1.5 text-sm outline-none focus:border-ink-500"
        >
          {orders.map((o) => (
            <option key={o.id} value={o.id}>
              {o.orderNumber} — {Number(o.outstanding).toFixed(2)}
              {o.dueDate ? ` (${o.dueDate})` : ""}
            </option>
          ))}
        </select>
      </label>

      <div className="mb-2 grid grid-cols-2 gap-2">
        <label className="block text-xs">
          <span className="mb-1 block text-ink-500">{ar ? "المبلغ" : "Amount"}</span>
          <input
            name="amount"
            type="number"
            step="0.01"
            min="0"
            max={owed}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={owed.toFixed(2)}
            dir="ltr"
            required
            className="w-full rounded-lg border border-ink-200 px-2 py-1.5 text-end text-sm outline-none focus:border-ink-500"
          />
        </label>

        <label className="block text-xs">
          <span className="mb-1 block text-ink-500">{ar ? "الطريقة" : "Method"}</span>
          <select
            name="method"
            className="w-full rounded-lg border border-ink-200 px-2 py-1.5 text-sm outline-none focus:border-ink-500"
          >
            <option value="CASH">{ar ? "كاش" : "Cash"}</option>
            <option value="CARD">{ar ? "فيزا" : "Card"}</option>
            <option value="BANK_TRANSFER">{ar ? "تحويل بنكي" : "Transfer"}</option>
            <option value="WALLET">{ar ? "محفظة" : "Wallet"}</option>
          </select>
        </label>
      </div>

      <button
        type="button"
        onClick={() => setAmount(owed.toFixed(2))}
        className="mb-2 text-xs text-ink-500 underline"
      >
        {ar ? `سدّد الكل (${owed.toFixed(2)})` : `Pay it all (${owed.toFixed(2)})`}
      </button>

      {tooMuch && (
        <p className="mb-2 text-xs text-bad">
          {ar
            ? `الطلب ده عليه ${owed.toFixed(2)} بس.`
            : `That order only has ${owed.toFixed(2)} on it.`}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending || tooMuch || typed <= 0}
          className="rounded-lg bg-ink-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {pending ? (ar ? "…" : "…") : ar ? "حصّل" : "Collect"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-ink-500"
        >
          {ar ? "إلغاء" : "Cancel"}
        </button>
      </div>

      {state.error && <p className="mt-2 text-xs text-bad">{state.error}</p>}
      {state.success && <p className="mt-2 text-xs text-good">{state.success}</p>}
    </form>
  );
}
