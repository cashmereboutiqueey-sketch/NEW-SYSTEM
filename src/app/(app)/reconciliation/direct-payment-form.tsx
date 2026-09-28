"use client";

import { useActionState, useState } from "react";
import { RequestIdField } from "@/components/request-id";
import type { FormState } from "@/components/entity-form";
import { correctDirectBankPaymentAction } from "./actions";

export function DirectPaymentForm({
  ar,
  today,
  payments,
}: {
  ar: boolean;
  today: string;
  payments: { orderNumber: string; customer: string | null; gross: string; original: "COD" | "CASH" }[];
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(correctDirectBankPaymentAction, {});
  const [orderNumber, setOrderNumber] = useState("");
  const chosen = payments.find((payment) => payment.orderNumber === orderNumber.trim());
  const field = "w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep";

  return (
    <form action={action} className="space-y-3">
      <RequestIdField state={state} />
      <p className="text-xs text-ink-600">
        {ar
          ? "لو الأوردر اتسجل عند الاستلام أو كاش، والعميل حوّل المبلغ كاملًا للحساب، صحّح طريقة الدفع هنا بعد ما تتأكد إن التحويل وصل. مش هيتسجل تحصيل تاني."
          : "If an order was entered as COD or cash and the customer transferred the full amount, correct its payment here after confirming receipt. No second collection is recorded."}
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-xs text-ink-600 lg:col-span-2">
          {ar ? "الأوردر" : "Order"}
          <input name="orderNumber" list="direct-payment-orders" required value={orderNumber} onChange={(event) => setOrderNumber(event.target.value)} placeholder={ar ? "رقم الأوردر" : "Order number"} dir="ltr" className={`mt-1 ${field}`} />
          <datalist id="direct-payment-orders">
            {payments.map((payment) => (
              <option key={payment.orderNumber} value={payment.orderNumber}>
                {payment.customer ?? "—"} · {payment.original} · {Number(payment.gross).toFixed(2)}
              </option>
            ))}
          </datalist>
        </label>
        <label className="text-xs text-ink-600">
          {ar ? "طريقة التحويل" : "Transfer method"}
          <select name="method" className={`mt-1 ${field}`}>
            <option value="INSTAPAY">InstaPay</option>
            <option value="BANK_TRANSFER">{ar ? "تحويل بنكي" : "Bank transfer"}</option>
          </select>
        </label>
        <label className="text-xs text-ink-600">
          {ar ? "تاريخ وصول التحويل" : "Received on"}
          <input name="receivedOn" type="date" required defaultValue={today} max={today} dir="ltr" className={`mt-1 ${field}`} />
        </label>
        <label className="text-xs text-ink-600 lg:col-span-2">
          {ar ? "مرجع التحويل من البنك / InstaPay" : "Bank or InstaPay reference"}
          <input name="reference" required maxLength={120} dir="ltr" className={`mt-1 ${field}`} />
        </label>
      </div>
      {chosen && (
        <p className="text-xs text-ink-600">
          {ar
            ? `هيتنقل ${Number(chosen.gross).toFixed(2)} من ${chosen.original === "COD" ? "حساب شركة الشحن" : "درج الكاش"} للبنك.`
            : `${Number(chosen.gross).toFixed(2)} will move from ${chosen.original === "COD" ? "courier clearing" : "the cash drawer"} to the bank.`}
        </p>
      )}
      <label className="flex items-start gap-2 text-xs text-ink-700">
        <input type="checkbox" name="receivedConfirmed" value="yes" required className="mt-0.5" />
        <span>{ar ? "اتأكدت إن المبلغ كاملًا وصل البنك. لو الأوردر كان عند الاستلام، هبلّغ MG إن التحصيل على الطرد بقى صفر." : "I confirmed the full amount arrived in the bank. If this was COD, I will tell MG the parcel's COD is now zero."}</span>
      </label>
      <button type="submit" disabled={pending || !orderNumber.trim()} className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
        {pending ? ar ? "بيسجل…" : "Recording…" : ar ? "سجّل التحويل المباشر" : "Record direct payment"}
      </button>
      {state.error && <p role="alert" className="text-sm text-bad">{state.error}</p>}
      {state.success && <p role="status" className="text-sm text-good">{state.success}</p>}
    </form>
  );
}
