"use client";

import { useActionState, useState } from "react";
import { takeCustomOrderAction, type CustomOrderState } from "./actions";

const empty: CustomOrderState = {};
const field =
  "w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm outline-none focus:border-ink-500";

export function TakeOrderForm({
  ar,
  entityId,
  customers,
  variants,
  locations,
}: {
  ar: boolean;
  entityId: string;
  customers: { id: string; name: string; phone: string | null }[];
  variants: { id: string; sku: string; label: string; retailPrice: string }[];
  locations: { id: string; name: string }[];
}) {
  const [state, action, pending] = useActionState(takeCustomOrderAction, empty);
  const [variantId, setVariantId] = useState("");
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [deposit, setDeposit] = useState("");

  const today = new Date().toISOString().slice(0, 10);
  const inTwoWeeks = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);

  const total = (Number(price || 0) * Number(quantity || 0)) || 0;
  const held = Number(deposit || 0);
  const uncovered = Math.max(0, total - held);

  return (
    <form action={action} className="grid gap-3 lg:grid-cols-3">
      <input type="hidden" name="entityId" value={entityId} />
      <input type="hidden" name="orderDate" value={today} />

      <label className="text-sm">
        <span className="mb-1 block text-ink-600">{ar ? "الزبون" : "Customer"}</span>
        <select name="customerId" required className={field}>
          <option value="">{ar ? "اختار" : "Choose"}</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}{c.phone ? ` — ${c.phone}` : ""}
            </option>
          ))}
        </select>
      </label>

      <label className="text-sm lg:col-span-2">
        <span className="mb-1 block text-ink-600">{ar ? "الموديل واللون والمقاس" : "Style, colour, size"}</span>
        <select
          name="variantId"
          required
          value={variantId}
          onChange={(e) => {
            setVariantId(e.target.value);
            const v = variants.find((x) => x.id === e.target.value);
            // The list price is a starting point, not a rule: bespoke work is
            // priced by the person taking the order.
            if (v?.retailPrice) setPrice(v.retailPrice);
          }}
          className={field}
        >
          <option value="">{ar ? "اختار" : "Choose"}</option>
          {variants.map((v) => (
            <option key={v.id} value={v.id}>{v.label}</option>
          ))}
        </select>
      </label>

      <label className="text-sm">
        <span className="mb-1 block text-ink-600">{ar ? "العدد" : "Quantity"}</span>
        <input
          name="quantity" type="number" min="1" step="1" required dir="ltr"
          value={quantity} onChange={(e) => setQuantity(e.target.value)}
          className={`${field} text-end`}
        />
      </label>

      <label className="text-sm">
        <span className="mb-1 block text-ink-600">{ar ? "سعر القطعة" : "Unit price"}</span>
        <input
          name="agreedUnitPrice" type="number" min="0" step="0.01" required dir="ltr"
          value={price} onChange={(e) => setPrice(e.target.value)}
          className={`${field} text-end`}
        />
      </label>

      <label className="text-sm">
        <span className="mb-1 block text-ink-600">{ar ? "يستلم من" : "Collects from"}</span>
        <select name="locationId" required className={field}>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
      </label>

      <label className="text-sm">
        <span className="mb-1 block text-ink-600">{ar ? "عربون (اختياري)" : "Deposit (optional)"}</span>
        <input
          name="depositAmount" type="number" min="0" step="0.01" dir="ltr"
          value={deposit} onChange={(e) => setDeposit(e.target.value)}
          placeholder="0.00"
          className={`${field} text-end`}
        />
      </label>

      <label className="text-sm">
        <span className="mb-1 block text-ink-600">{ar ? "طريقة العربون" : "Deposit by"}</span>
        <select name="depositMethod" className={field}>
          <option value="CASH">{ar ? "كاش" : "Cash"}</option>
          <option value="CARD">{ar ? "فيزا" : "Card"}</option>
          <option value="BANK_TRANSFER">{ar ? "تحويل" : "Transfer"}</option>
          <option value="INSTAPAY">{ar ? "إنستاباي" : "InstaPay"}</option>
        </select>
      </label>

      <label className="text-sm">
        <span className="mb-1 block text-ink-600">{ar ? "الميعاد المتفق عليه" : "Promised for"}</span>
        <input
          name="promisedDate" type="date" defaultValue={inTwoWeeks} dir="ltr"
          className={field}
        />
      </label>

      <label className="text-sm lg:col-span-3">
        <span className="mb-1 block text-ink-600">{ar ? "ملاحظات" : "Notes"}</span>
        <input
          name="notes"
          placeholder={ar ? "مقاسات، تعديلات، أي حاجة اتفقت عليها" : "Measurements, alterations, anything agreed"}
          className={field}
        />
      </label>

      {total > 0 && (
        <div className="lg:col-span-3 rounded-lg bg-ink-100 px-3 py-2 text-sm">
          <span className="text-ink-600">{ar ? "الإجمالي" : "Total"}: </span>
          <span className="num font-semibold">{total.toFixed(2)}</span>
          {uncovered > 0 ? (
            <span className="ms-3 text-bad">
              {ar
                ? `مكشوف ${uncovered.toFixed(2)} — لو الزبون ماجاش، دي خسارة`
                : `${uncovered.toFixed(2)} uncovered — the shop's loss if nobody collects`}
            </span>
          ) : (
            <span className="ms-3 text-good">
              {ar ? "مغطّى بالكامل بالعربون" : "fully covered by the deposit"}
            </span>
          )}
        </div>
      )}

      <div className="lg:col-span-3 flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? (ar ? "بيتسجّل…" : "Saving…") : ar ? "سجّل الأوردر" : "Take the order"}
        </button>
        {state.error && <p className="text-sm text-bad">{state.error}</p>}
        {state.success && <p className="text-sm text-good">{state.success}</p>}
      </div>
    </form>
  );
}
