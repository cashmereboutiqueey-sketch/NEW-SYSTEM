"use client";

import { useActionState, useMemo, useState } from "react";
import { createModeratorSaleAction } from "./actions";
import type { FormState } from "@/components/entity-form";
import type { Locale } from "@/lib/i18n";

const initial: FormState = {};
const field =
  "rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 " +
  "focus:border-ink-400 focus:outline-none focus:ring-1 focus:ring-ink-300";
const label = "mb-1 block text-xs font-medium text-ink-600";

/** Rounds the way the invoice does, so the screen shows what will be charged. */
const money = (n: number) => Math.round(n * 100) / 100;

type Product = {
  variantId: string;
  sku: string;
  label: string;
  available: number;
  retailPrice: number;
};

type Line = { variantId: string; quantity: number; retailPrice: number };

/**
 * Taking an order that came in by message.
 *
 * Only stock that exists is offered, for the same reason the till only offers
 * what is on the shelf: promising a customer a garment the shop does not have
 * is worse than telling them straight away.
 */
export function ModeratorOrderForm({
  locale,
  products,
  customers,
  locations,
  channels,
  entityId,
  canDiscount,
  today,
}: {
  locale: Locale;
  products: Product[];
  customers: { id: string; name: string; phone: string | null }[];
  locations: { id: string; label: string }[];
  channels: { id: string; label: string }[];
  entityId: string;
  canDiscount: boolean;
  today: string;
}) {
  const [state, formAction, pending] = useActionState(createModeratorSaleAction, initial);
  const [lines, setLines] = useState<Line[]>([]);
  const [query, setQuery] = useState("");
  const [discountPct, setDiscountPct] = useState(0);
  const [shipping, setShipping] = useState(0);
  const [method, setMethod] = useState("COD");
  const ar = locale === "ar";

  const byId = useMemo(() => new Map(products.map((p) => [p.variantId, p])), [products]);

  const matching = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products.slice(0, 8);
    return products
      .filter((p) => p.sku.toLowerCase().includes(q) || p.label.toLowerCase().includes(q))
      .slice(0, 8);
  }, [products, query]);

  const add = (p: Product) =>
    setLines((prev) => {
      const found = prev.find((l) => l.variantId === p.variantId);
      if (found) {
        return prev.map((l) =>
          l.variantId === p.variantId
            ? { ...l, quantity: Math.min(l.quantity + 1, p.available) }
            : l,
        );
      }
      return [...prev, { variantId: p.variantId, quantity: 1, retailPrice: p.retailPrice }];
    });

  const setLine = (variantId: string, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l) => (l.variantId === variantId ? { ...l, ...patch } : l)));

  const remove = (variantId: string) =>
    setLines((prev) => prev.filter((l) => l.variantId !== variantId));

  const goods = lines.reduce(
    (s, l) => s + money(l.retailPrice * (1 - discountPct / 100)) * l.quantity,
    0,
  );
  const total = money(goods + shipping);
  const overstocked = lines.filter((l) => l.quantity > (byId.get(l.variantId)?.available ?? 0));

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="entityId" value={entityId} />
      <input type="hidden" name="lines" value={JSON.stringify(lines)} />
      <input type="hidden" name="discountPct" value={discountPct} />
      <input type="hidden" name="shippingAmount" value={shipping} />
      <input type="hidden" name="paymentMethod" value={method} />

      {/* ------------------------------------------------------ what they want */}
      <div>
        <label className={label} htmlFor="mod-search">
          {ar ? "دوّر على الصنف" : "Find the item"}
        </label>
        <input
          id="mod-search"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={ar ? "SKU أو اسم الموديل" : "SKU or style name"}
          className={`${field} w-full`}
        />
        <div className="mt-2 flex flex-wrap gap-2">
          {matching.length === 0 ? (
            <p className="py-2 text-sm text-ink-400">
              {ar ? "مفيش صنف مطابق في المخزون." : "Nothing in stock matches."}
            </p>
          ) : (
            matching.map((p) => (
              <button
                key={p.variantId}
                type="button"
                onClick={() => add(p)}
                className="rounded-lg border border-ink-200 px-3 py-2 text-start text-sm hover:border-ink-400"
              >
                <code dir="ltr" className="block text-xs text-ink-500">{p.sku}</code>
                <span className="text-ink-700">{p.label}</span>
                <span className="ms-2 num text-xs text-ink-400">×{p.available}</span>
              </button>
            ))
          )}
        </div>
      </div>

      {/* ------------------------------------------------------------- the order */}
      <div className="rounded-lg border border-ink-200 p-3">
        {lines.length === 0 ? (
          <p className="py-3 text-center text-sm text-ink-400">
            {ar ? "اضغط على صنف عشان تضيفه" : "Tap an item to add it"}
          </p>
        ) : (
          <ul className="space-y-2">
            {lines.map((l) => {
              const p = byId.get(l.variantId);
              const short = p != null && l.quantity > p.available;
              return (
                <li key={l.variantId} className="flex flex-wrap items-center gap-2">
                  <span className="flex-1 text-sm">
                    <code dir="ltr" className="text-xs text-ink-500">{p?.sku}</code>
                    <span className="ms-2">{p?.label}</span>
                  </span>
                  <input
                    type="number" min="1" step="1" value={l.quantity}
                    onChange={(e) => setLine(l.variantId, { quantity: Number(e.target.value) })}
                    dir="ltr" className={`${field} num w-20 ${short ? "border-bad" : ""}`}
                  />
                  <input
                    type="number" min="0" step="0.01" value={l.retailPrice}
                    onChange={(e) => setLine(l.variantId, { retailPrice: Number(e.target.value) })}
                    dir="ltr" className={`${field} num w-28`}
                  />
                  <span className="num w-28 text-end text-sm font-medium">
                    {(money(l.retailPrice * (1 - discountPct / 100)) * l.quantity).toFixed(2)}
                  </span>
                  <button
                    type="button"
                    onClick={() => remove(l.variantId)}
                    className="text-sm text-ink-400 hover:text-bad"
                  >
                    ×
                  </button>
                  {short && (
                    <p className="w-full text-xs text-bad">
                      {ar
                        ? `المتاح ${p!.available} بس.`
                        : `Only ${p!.available} available.`}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* -------------------------------------------------------- who and where */}
      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <label className={label} htmlFor="mod-customer">{ar ? "العميلة" : "Customer"}</label>
          <select id="mod-customer" name="customerId" className={`${field} w-full`}>
            <option value="">{ar ? "بدون عميل" : "No customer"}</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}{c.phone ? ` — ${c.phone}` : ""}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="mod-channel">{ar ? "القناة" : "Channel"}</label>
          <select id="mod-channel" name="channelId" required className={`${field} w-full`}>
            {channels.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="mod-location">{ar ? "يتشحن من" : "Ships from"}</label>
          <select id="mod-location" name="locationId" required className={`${field} w-full`}>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="mod-date">{ar ? "تاريخ الأوردر" : "Order date"}</label>
          <input
            id="mod-date" name="orderDate" type="date" required defaultValue={today}
            dir="ltr" className={`${field} w-full`}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <label className={label} htmlFor="mod-city">{ar ? "المدينة" : "City"}</label>
          <input id="mod-city" name="city" type="text" className={`${field} w-full`} />
        </div>
        <div>
          <label className={label} htmlFor="mod-ship">{ar ? "الشحن" : "Shipping"}</label>
          <input
            id="mod-ship" type="number" min="0" step="0.01" value={shipping || ""}
            onChange={(e) => setShipping(Number(e.target.value))}
            dir="ltr" className={`${field} num w-full`}
          />
        </div>
        {canDiscount && (
          <div>
            <label className={label} htmlFor="mod-disc">{ar ? "خصم %" : "Discount %"}</label>
            <input
              id="mod-disc" type="number" min="0" max="100" step="1" value={discountPct || ""}
              onChange={(e) => setDiscountPct(Number(e.target.value))}
              dir="ltr" className={`${field} num w-full`}
            />
          </div>
        )}
        <div>
          <label className={label} htmlFor="mod-notes">{ar ? "ملاحظات" : "Notes"}</label>
          <input id="mod-notes" name="notes" type="text" className={`${field} w-full`} />
        </div>
      </div>

      {/* -------------------------------------------------------------- payment */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <p className={label}>{ar ? "الدفع" : "Payment"}</p>
          <div className="flex flex-wrap gap-2">
            {([
              ["COD", ar ? "عند الاستلام" : "On delivery"],
              ["BANK_TRANSFER", ar ? "تحويل بنكي" : "Bank transfer"],
              ["INSTAPAY", ar ? "إنستاباي" : "InstaPay"],
              ["CASH", ar ? "كاش" : "Cash"],
            ] as const).map(([value, text]) => (
              <button
                key={value}
                type="button"
                onClick={() => setMethod(value)}
                className={`rounded-lg border px-3 py-2 text-sm ${
                  method === value ? "border-ink-900 bg-ink-900 text-white" : "border-ink-200"
                }`}
              >
                {text}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className={label} htmlFor="mod-fee">{ar ? "رسوم التحصيل" : "Collection fee"}</label>
          <input
            id="mod-fee" name="fee" type="number" min="0" step="0.01" defaultValue={0}
            dir="ltr" className={`${field} num w-28`}
          />
        </div>

        <div className="ms-auto text-end">
          <p className="text-xs text-ink-500">{ar ? "الإجمالي" : "Total"}</p>
          <p className="num text-xl font-semibold">{total.toFixed(2)}</p>
        </div>

        <button
          type="submit"
          disabled={pending || lines.length === 0 || overstocked.length > 0}
          className="rounded-lg bg-ink-900 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {pending
            ? ar ? "جارٍ التسجيل…" : "Recording…"
            : ar ? `سجّل الأوردر · ${total.toFixed(2)}` : `Record the order · ${total.toFixed(2)}`}
        </button>
      </div>

      {method === "COD" && lines.length > 0 && (
        <p className="text-xs text-ink-500">
          {ar
            ? "الدفع عند الاستلام بيتسجّل كمستحق على شركة الشحن لحد ما تورّد."
            : "Cash on delivery is recorded as owed by the courier until they remit."}
        </p>
      )}

      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      {state.success && <p className="text-sm text-good">{state.success}</p>}
    </form>
  );
}
