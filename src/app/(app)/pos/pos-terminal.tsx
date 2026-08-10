"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { checkoutAction, lookupSerialAction, type PosState } from "./actions";
import { isWellFormedSerial, normaliseTypedSerial } from "@/core/serial";
import type { Locale } from "@/lib/i18n";

type Product = {
  variantId: string;
  sku: string;
  barcode: string | null;
  styleCode: string;
  styleEn: string;
  styleAr: string;
  colourEn: string;
  colourAr: string;
  hex: string | null;
  size: string;
  available: string;
  retailPrice: string | null;
};

type CartLine = {
  variantId: string;
  sku: string;
  label: string;
  quantity: number;
  retailPrice: number;
  discountPct: number;
  available: number;
  /**
   * The tags scanned for this line. Shorter than `quantity` when the cashier
   * tapped the tile for some of them, which is fine — the sale then names the
   * pieces it can and picks the rest oldest-first.
   */
  scannedSerials: string[];
};

const initial: PosState = {};

/** Rounds the way the invoice does, so the till shows what will be charged. */
const money = (n: number) => Math.round(n * 100) / 100;

export function PosTerminal({
  locale,
  products,
  posSessionId,
  locationId,
  entityId,
  channelId,
  canDiscount,
  mayGiveCredit,
  customers,
}: {
  locale: Locale;
  products: Product[];
  posSessionId: string;
  locationId: string;
  entityId: string;
  channelId: string;
  canDiscount: boolean;
  /** Letting somebody walk out owing money is its own decision, and its own right. */
  mayGiveCredit: boolean;
  customers: { id: string; name: string; phone: string | null }[];
}) {
  const ar = locale === "ar";
  const [state, formAction, pending] = useActionState(checkoutAction, initial);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [query, setQuery] = useState("");
  const [method, setMethod] = useState("CASH");
  const [tendered, setTendered] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [onAccount, setOnAccount] = useState(false);
  const [paidNow, setPaidNow] = useState("");
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) =>
        p.sku.toLowerCase().includes(q) ||
        p.barcode?.toLowerCase().includes(q) ||
        p.styleEn.toLowerCase().includes(q) ||
        p.styleAr.includes(query.trim()) ||
        p.colourEn.toLowerCase().includes(q) ||
        p.colourAr.includes(query.trim()),
    );
  }, [products, query]);

  const total = useMemo(
    () =>
      money(
        cart.reduce(
          (s, l) => s + money(money(l.retailPrice) * (1 - l.discountPct)) * l.quantity,
          0,
        ),
      ),
    [cart],
  );

  const change = Math.max(0, money(Number(tendered || 0) - total));

  // What the customer is actually handing over. A blank box while "part now"
  // is ticked means nothing yet, not the whole price.
  const collectedNow = onAccount
    ? Math.min(total, Math.max(0, money(Number(paidNow || 0))))
    : total;
  const owed = money(total - collectedNow);
  // A debt has to have a name on it, so the sale is blocked here rather than
  // letting the server refuse it after the cashier has taken the money.
  const creditBlocked = owed > 0 && !customerId;

  // The cart is cleared only once a sale has actually been recorded. Clearing
  // it on click would throw away the customer's basket whenever a checkout
  // fails — a shortfall of stock, a missing permission — and the cashier would
  // have to ring the whole thing up again with a queue waiting.
  const lastReceipt = state.receipt?.orderNumber;
  useEffect(() => {
    if (!lastReceipt) return;
    setCart([]);
    setTendered("");
    setCustomerId("");
    searchRef.current?.focus();
  }, [lastReceipt]);

  function add(p: Product, serial?: string) {
    const available = Number(p.available);
    setCart((prev) => {
      const line = prev.find((l) => l.variantId === p.variantId);
      if (line) {
        // The same tag scanned twice is one garment, not two.
        if (serial && line.scannedSerials.includes(serial)) return prev;
        // Never let the cart exceed the shelf — the sale would fail at
        // checkout with the customer still standing there.
        if (line.quantity >= available) return prev;
        return prev.map((l) =>
          l.variantId === p.variantId
            ? {
                ...l,
                quantity: l.quantity + 1,
                scannedSerials: serial ? [...l.scannedSerials, serial] : l.scannedSerials,
              }
            : l,
        );
      }
      return [
        ...prev,
        {
          variantId: p.variantId,
          sku: p.sku,
          label: `${ar ? p.styleAr : p.styleEn} · ${ar ? p.colourAr : p.colourEn} · ${p.size}`,
          quantity: 1,
          retailPrice: Number(p.retailPrice ?? 0),
          discountPct: 0,
          available,
          scannedSerials: serial ? [serial] : [],
        },
      ];
    });
    setQuery("");
    setScanError(null);
    searchRef.current?.focus();
  }

  const setLine = (variantId: string, patch: Partial<CartLine>) =>
    setCart((prev) =>
      prev.map((l) => (l.variantId === variantId ? { ...l, ...patch } : l)),
    );

  const priced = cart.every((l) => l.retailPrice > 0);

  /**
   * A barcode scanner types fast and finishes with Enter.
   *
   * A garment tag is an eight-character code with a check character, so it can
   * be told apart from someone typing a style name without asking the server
   * first. Scanning names the exact piece; searching still works as it did.
   */
  async function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();

    const typed = normaliseTypedSerial(query);
    if (isWellFormedSerial(typed)) {
      setScanning(true);
      setScanError(null);
      try {
        const result = await lookupSerialAction(typed, locationId);
        if (!result.ok) {
          setScanError(result.message);
          setQuery("");
          return;
        }
        const product = products.find((p) => p.variantId === result.variantId);
        if (!product) {
          setScanError(
            ar
              ? "الصنف ده مش على رف الفرع ده."
              : "That garment is not on this branch's shelf.",
          );
          setQuery("");
          return;
        }
        add(product, result.serial);
      } finally {
        setScanning(false);
      }
      return;
    }

    if (filtered.length === 1) add(filtered[0]);
  }

  const field =
    "rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 " +
    "focus:border-ink-400 focus:outline-none focus:ring-1 focus:ring-ink-300";

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      {/* ---------------------------------------------------------- catalogue */}
      <div>
        <input
          ref={searchRef}
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKey}
          placeholder={ar ? "امسح الليبل أو ابحث بالكود أو الاسم…" : "Scan a tag, or search by SKU or name…"}
          className={`${field} mb-3 w-full`}
        />

        {scanning && (
          <p className="mb-3 text-sm text-ink-400">{ar ? "بيقرا…" : "Reading…"}</p>
        )}
        {scanError && (
          <p className="mb-3 rounded-lg bg-bad/10 px-3 py-2 text-sm text-bad">{scanError}</p>
        )}

        {filtered.length === 0 ? (
          <div className="rounded-xl border border-dashed border-ink-200 py-12 text-center text-sm text-ink-400">
            {/* What to do about it is said once, in the banner above, and only
                when there is actually something at the factory to transfer. */}
            {products.length === 0
              ? ar
                ? "لا يوجد مخزون في هذا الفرع."
                : "No stock at this location."
              : ar
                ? "لا يوجد صنف مطابق."
                : "Nothing matches."}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
            {filtered.map((p) => {
              const inCart = cart.find((l) => l.variantId === p.variantId)?.quantity ?? 0;
              const left = Number(p.available) - inCart;
              return (
                <button
                  key={p.variantId}
                  type="button"
                  onClick={() => add(p)}
                  disabled={left <= 0}
                  className="rounded-xl border border-ink-200 bg-white p-3 text-start transition-colors hover:border-ink-400 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <div className="flex items-center gap-2">
                    {p.hex && (
                      <span
                        aria-hidden
                        className="h-3 w-3 shrink-0 rounded-full border border-ink-200"
                        style={{ backgroundColor: p.hex }}
                      />
                    )}
                    <span className="truncate text-sm font-medium text-ink-900">
                      {ar ? p.styleAr : p.styleEn}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-ink-500">
                    {ar ? p.colourAr : p.colourEn} · {p.size}
                  </div>
                  <div className="mt-2 flex items-baseline justify-between">
                    <span className="num text-sm font-semibold">
                      {p.retailPrice ? Number(p.retailPrice).toFixed(2) : "—"}
                    </span>
                    <span className={`num text-xs ${left <= 3 ? "text-bad" : "text-ink-400"}`}>
                      {left} {ar ? "متاح" : "left"}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* -------------------------------------------------------------- cart */}
      <form action={formAction} className="flex flex-col gap-3">
        <input type="hidden" name="cart" value={JSON.stringify(
          cart.map((l) => ({
            variantId: l.variantId,
            quantity: l.quantity,
            retailPrice: l.retailPrice,
            discountPct: l.discountPct,
          })),
        )} />
        <input type="hidden" name="posSessionId" value={posSessionId} />
        <input type="hidden" name="locationId" value={locationId} />
        <input type="hidden" name="entityId" value={entityId} />
        <input type="hidden" name="channelId" value={channelId} />
        <input type="hidden" name="total" value={total.toFixed(2)} />
        {/* What is being collected right now; the rest goes on the tab. */}
        <input type="hidden" name="paidNow" value={collectedNow.toFixed(2)} />
        <input type="hidden" name="method" value={method} />
        <input type="hidden" name="tendered" value={tendered || "0"} />
        <input type="hidden" name="customerId" value={customerId} />

        <div className="rounded-xl border border-ink-200 bg-white p-3">
          <h2 className="mb-2 text-sm font-semibold text-ink-800">
            {ar ? "الفاتورة" : "Receipt"}
          </h2>

          {cart.length === 0 ? (
            <p className="py-8 text-center text-sm text-ink-400">
              {ar ? "اضغط على صنف لإضافته" : "Tap a product to add it"}
            </p>
          ) : (
            <ul className="space-y-2">
              {cart.map((l) => {
                const lineTotal = money(money(l.retailPrice) * (1 - l.discountPct)) * l.quantity;
                return (
                  <li key={l.variantId} className="border-b border-ink-100 pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm">{l.label}</span>
                      <button
                        type="button"
                        onClick={() => setCart((c) => c.filter((x) => x.variantId !== l.variantId))}
                        className="text-xs text-ink-400 hover:text-bad"
                        aria-label={ar ? "حذف" : "Remove"}
                      >
                        ✕
                      </button>
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      <div className="flex items-center rounded-lg border border-ink-200">
                        <button
                          type="button"
                          className="px-2 py-1 text-sm"
                          onClick={() =>
                            l.quantity > 1
                              ? setLine(l.variantId, { quantity: l.quantity - 1 })
                              : setCart((c) => c.filter((x) => x.variantId !== l.variantId))
                          }
                        >
                          −
                        </button>
                        <span className="num w-8 text-center text-sm">{l.quantity}</span>
                        <button
                          type="button"
                          className="px-2 py-1 text-sm disabled:opacity-30"
                          disabled={l.quantity >= l.available}
                          onClick={() => setLine(l.variantId, { quantity: l.quantity + 1 })}
                        >
                          +
                        </button>
                      </div>

                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={l.retailPrice || ""}
                        onChange={(e) =>
                          setLine(l.variantId, { retailPrice: Number(e.target.value) })
                        }
                        dir="ltr"
                        className={`${field} num w-20 px-2 py-1`}
                        aria-label={ar ? "السعر" : "Price"}
                      />

                      {canDiscount && (
                        <select
                          value={l.discountPct}
                          onChange={(e) =>
                            setLine(l.variantId, { discountPct: Number(e.target.value) })
                          }
                          className={`${field} w-20 px-2 py-1`}
                          aria-label={ar ? "الخصم" : "Discount"}
                        >
                          {[0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.5].map((d) => (
                            <option key={d} value={d}>{d === 0 ? "—" : `${d * 100}%`}</option>
                          ))}
                        </select>
                      )}

                      <span className="num ms-auto text-sm font-medium">
                        {lineTotal.toFixed(2)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-3 flex items-baseline justify-between border-t border-ink-300 pt-2">
            <span className="font-semibold">{ar ? "الإجمالي" : "Total"}</span>
            <span className="num text-xl font-semibold">{total.toFixed(2)}</span>
          </div>
        </div>

        {/* ------------------------------------------------------- payment */}
        <div className="rounded-xl border border-ink-200 bg-white p-3">
          <div className="mb-2 grid grid-cols-4 gap-1.5">
            {(["CASH", "CARD", "WALLET", "COD"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMethod(m)}
                className={
                  "rounded-lg border px-2 py-2 text-xs font-medium " +
                  (method === m
                    ? "border-ink-900 bg-ink-900 text-white"
                    : "border-ink-200 text-ink-700")
                }
              >
                {ar
                  ? { CASH: "كاش", CARD: "بطاقة", WALLET: "محفظة", COD: "عند الاستلام" }[m]
                  : { CASH: "Cash", CARD: "Card", WALLET: "Wallet", COD: "On delivery" }[m]}
              </button>
            ))}
          </div>

          {method === "CASH" && (
            <div className="mb-2 flex items-center gap-2">
              <input
                type="number"
                step="0.01"
                min="0"
                value={tendered}
                onChange={(e) => setTendered(e.target.value)}
                placeholder={ar ? "المدفوع" : "Tendered"}
                dir="ltr"
                className={`${field} num flex-1`}
              />
              <div className="text-end">
                <div className="text-xs text-ink-500">{ar ? "الباقي" : "Change"}</div>
                <div className="num text-sm font-semibold">{change.toFixed(2)}</div>
              </div>
            </div>
          )}

          <select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            className={`${field} mb-2 w-full`}
          >
            <option value="">{ar ? "بدون عميل" : "No customer"}</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}{c.phone ? ` — ${c.phone}` : ""}
              </option>
            ))}
          </select>

          {/* ----------------------------------------------- part payment */}
          {mayGiveCredit && (
            <div className="mb-2 rounded-lg border border-ink-200 p-2">
              <label className="flex items-center gap-2 text-xs text-ink-700">
                <input
                  type="checkbox"
                  checked={onAccount}
                  onChange={(e) => {
                    setOnAccount(e.target.checked);
                    if (!e.target.checked) setPaidNow("");
                  }}
                />
                {ar ? "الزبون هيدفع جزء دلوقتي والباقي بعدين" : "Paying part now, rest later"}
              </label>

              {onAccount && (
                <div className="mt-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max={total}
                      value={paidNow}
                      onChange={(e) => setPaidNow(e.target.value)}
                      placeholder={ar ? "بيدفع كام دلوقتي" : "Paying now"}
                      dir="ltr"
                      className={`${field} num flex-1`}
                    />
                    <div className="text-end">
                      <div className="text-xs text-ink-500">{ar ? "الباقي عليه" : "Owes"}</div>
                      <div
                        className={
                          "num text-sm font-semibold " + (owed > 0 ? "text-warn" : "")
                        }
                      >
                        {owed.toFixed(2)}
                      </div>
                    </div>
                  </div>

                  {owed > 0 && !customerId && (
                    <p className="mt-2 rounded-lg bg-bad/10 px-3 py-2 text-xs text-bad">
                      {ar
                        ? "لازم تختار العميل — الدين من غير اسم محدش يقدر يطالب بيه."
                        : "Choose the customer: a debt with no name cannot be chased."}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {!priced && cart.length > 0 && (
            <p className="mb-2 rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">
              {ar
                ? "في صنف من غير سعر — اكتب السعر قبل إتمام البيع."
                : "A line has no price — enter one before completing the sale."}
            </p>
          )}

          {state.error && (
            <p role="alert" className="mb-2 rounded-lg bg-bad/10 px-3 py-2 text-sm text-bad">
              {state.error}
            </p>
          )}
          {state.receipt && (
            <p role="status" className="mb-2 rounded-lg bg-good/10 px-3 py-2 text-sm text-good">
              {ar ? "تم البيع" : "Sold"} — {state.receipt.orderNumber}
              {Number(state.receipt.change) > 0 && (
                <>
                  {" · "}
                  {ar ? "الباقي" : "change"} <span className="num">{state.receipt.change}</span>
                </>
              )}
            </p>
          )}

          <button
            type="submit"
            disabled={pending || cart.length === 0 || !priced || creditBlocked}
            className="w-full rounded-lg bg-ink-900 px-4 py-3 text-sm font-semibold text-white disabled:opacity-40"
          >
            {pending
              ? (ar ? "جارٍ التسجيل…" : "Recording…")
              : owed > 0
                ? (ar
                    ? `بيع بـ ${collectedNow.toFixed(2)} · وعليه ${owed.toFixed(2)}`
                    : `Sell · ${collectedNow.toFixed(2)} now, ${owed.toFixed(2)} owed`)
                : (ar ? `إتمام البيع · ${total.toFixed(2)}` : `Complete sale · ${total.toFixed(2)}`)}
          </button>
        </div>
      </form>
    </div>
  );
}
