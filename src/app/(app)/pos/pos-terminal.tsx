"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import {
  checkoutAction,
  lookupSerialAction,
  quickAddCustomerAction,
  type PosState,
} from "./actions";
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
  styleId: string;
  /** The colour's own shot, or the style's. */
  image: string | null;
  styleImage: string | null;
};

/**
 * Something on the rail that belongs to somebody else.
 *
 * It sits in the same grid as everything else, because to a cashier with a
 * customer waiting it is simply a dress. The difference is all in what
 * happens afterwards, which is the system's problem and not theirs.
 */
type ConsignedProduct = {
  itemId: string;
  itemCode: string;
  description: string;
  size: string;
  colour: string;
  consignorName: string;
  retailPrice: string;
  commissionRate: string;
  available: number;
};

type ConsignedLine = {
  itemId: string;
  label: string;
  consignorName: string;
  quantity: number;
  retailPrice: number;
  available: number;
  commissionRate: number;
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
  isExhibition,
  consigned,
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
  /** A bazaar customer is not a showroom customer, and is recorded as such. */
  isExhibition: boolean;
  /** Goods held for other people, sellable here and owned by nobody here. */
  consigned: ConsignedProduct[];
  customers: { id: string; name: string; phone: string | null }[];
}) {
  const ar = locale === "ar";
  const [state, formAction, pending] = useActionState(checkoutAction, initial);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [query, setQuery] = useState("");
  const [method, setMethod] = useState("CASH");
  const [tendered, setTendered] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [openStyleId, setOpenStyleId] = useState<string | null>(null);
  const [consignedLines, setConsignedLines] = useState<ConsignedLine[]>([]);

  /**
   * The customer list, held locally so somebody added mid-queue appears at
   * once. Waiting for the page to revalidate would mean the cashier adds a
   * customer and then cannot find them, which is how the same person ends up
   * in the database three times.
   */
  const [people, setPeople] = useState(customers);
  const [addingCustomer, setAddingCustomer] = useState(false);
  const [newCustomer, setNewCustomer] = useState({ name: "", phone: "" });
  const [duplicate, setDuplicate] = useState<
    { id: string; name: string; phone: string | null; code: string } | null
  >(null);
  const [customerError, setCustomerError] = useState<string | null>(null);
  const [savingCustomer, setSavingCustomer] = useState(false);

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

  const ownTotal = useMemo(
    () =>
      money(
        cart.reduce(
          (s, l) => s + money(money(l.retailPrice) * (1 - l.discountPct)) * l.quantity,
          0,
        ),
      ),
    [cart],
  );

  const consignedTotal = useMemo(
    () => money(consignedLines.reduce((s, l) => s + money(l.retailPrice) * l.quantity, 0)),
    [consignedLines],
  );

  /** What the customer pays: one number, whoever owns the garments. */
  const total = money(ownTotal + consignedTotal);

  /** What the shop actually earns on the consigned half. */
  const consignedCommission = useMemo(
    () =>
      money(
        consignedLines.reduce(
          (s, l) => s + money(money(l.retailPrice) * l.quantity * l.commissionRate),
          0,
        ),
      ),
    [consignedLines],
  );

  const filteredConsigned = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return consigned;
    return consigned.filter(
      (c) =>
        c.description.toLowerCase().includes(q) ||
        c.description.includes(query.trim()) ||
        c.consignorName.toLowerCase().includes(q) ||
        c.consignorName.includes(query.trim()) ||
        c.itemCode.toLowerCase().includes(q),
    );
  }, [consigned, query]);

  function addConsigned(item: ConsignedProduct) {
    setConsignedLines((lines) => {
      const existing = lines.find((l) => l.itemId === item.itemId);
      if (existing) {
        if (existing.quantity >= item.available) return lines;
        return lines.map((l) =>
          l.itemId === item.itemId ? { ...l, quantity: l.quantity + 1 } : l,
        );
      }
      return [
        ...lines,
        {
          itemId: item.itemId,
          label: [item.description, item.colour, item.size].filter(Boolean).join(" · "),
          consignorName: item.consignorName,
          quantity: 1,
          retailPrice: Number(item.retailPrice),
          available: item.available,
          commissionRate: Number(item.commissionRate),
        },
      ];
    });
  }

  /**
   * The shelf, grouped the way a shop is laid out.
   *
   * A flat grid of every colour and size means a wall of near-identical tiles
   * — the same coat eighteen times — and a cashier hunting through it with a
   * customer waiting. One card per garment with its photograph, opened to
   * choose the colour and size, is how the person actually thinks about it.
   */
  const styleCards = useMemo(() => {
    const byStyle = new Map<
      string,
      {
        styleId: string;
        styleAr: string;
        styleEn: string;
        image: string | null;
        totalAvailable: number;
        prices: number[];
        swatches: { key: string; colourAr: string; colourEn: string; hex: string | null }[];
      }
    >();

    for (const p of filtered) {
      const card =
        byStyle.get(p.styleId) ?? {
          styleId: p.styleId,
          styleAr: p.styleAr,
          styleEn: p.styleEn,
          // The style's own shot, or the first colour that has one — better a
          // picture of the wrong colour than an empty square.
          image: p.styleImage ?? p.image,
          totalAvailable: 0,
          prices: [] as number[],
          swatches: [] as { key: string; colourAr: string; colourEn: string; hex: string | null }[],
        };

      if (!card.image && p.image) card.image = p.image;
      card.totalAvailable += Number(p.available);
      if (p.retailPrice) card.prices.push(Number(p.retailPrice));
      if (!card.swatches.some((c) => c.key === p.colourEn)) {
        card.swatches.push({
          key: p.colourEn,
          colourAr: p.colourAr,
          colourEn: p.colourEn,
          hex: p.hex,
        });
      }

      byStyle.set(p.styleId, card);
    }

    return [...byStyle.values()]
      .map((c) => {
        if (c.prices.length === 0) return { ...c, priceLabel: "—" };
        const low = Math.min(...c.prices);
        const high = Math.max(...c.prices);
        return {
          ...c,
          // A range only when there is one: "1200" reads better than
          // "1200–1200" on a tile somebody glances at.
          priceLabel: low === high ? low.toFixed(2) : `${low.toFixed(2)}–${high.toFixed(2)}`,
        };
      })
      .sort((a, b) => (ar ? a.styleAr.localeCompare(b.styleAr) : a.styleEn.localeCompare(b.styleEn)));
  }, [filtered, ar]);

  /** The style a cashier has opened, with its colours and their sizes. */
  const openStyle = useMemo(() => {
    if (!openStyleId) return null;
    const rows = filtered.filter((p) => p.styleId === openStyleId);
    if (rows.length === 0) return null;

    const colours = new Map<
      string,
      {
        key: string;
        colourAr: string;
        colourEn: string;
        hex: string | null;
        sizes: Product[];
      }
    >();

    for (const p of rows) {
      const c =
        colours.get(p.colourEn) ?? {
          key: p.colourEn,
          colourAr: p.colourAr,
          colourEn: p.colourEn,
          hex: p.hex,
          sizes: [] as Product[],
        };
      c.sizes.push(p);
      colours.set(p.colourEn, c);
    }

    return {
      styleAr: rows[0].styleAr,
      styleEn: rows[0].styleEn,
      totalAvailable: rows.reduce((s, p) => s + Number(p.available), 0),
      colours: [...colours.values()].map((c) => ({
        ...c,
        sizes: c.sizes.sort((a, b) => a.size.localeCompare(b.size, undefined, { numeric: true })),
      })),
    };
  }, [filtered, openStyleId]);

  /**
   * Add the person standing at the counter.
   *
   * `createAnyway` is what the cashier chose after being shown a match — the
   * decision that this is a different person on the same family phone. It is
   * never assumed.
   */
  async function saveCustomer(createAnyway: boolean) {
    setSavingCustomer(true);
    setCustomerError(null);
    try {
      const result = await quickAddCustomerAction({
        name: newCustomer.name,
        phone: newCustomer.phone,
        source: isExhibition ? "EXHIBITION" : "POS",
        createAnyway,
      });

      if (result.ok) {
        setPeople((list) => [
          { id: result.customer.id, name: result.customer.name, phone: result.customer.phone },
          ...list,
        ]);
        setCustomerId(result.customer.id);
        setAddingCustomer(false);
        setNewCustomer({ name: "", phone: "" });
        setDuplicate(null);
      } else if ("match" in result) {
        setDuplicate(result.match);
      } else {
        setCustomerError(result.message);
      }
    } finally {
      setSavingCustomer(false);
    }
  }

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
    setConsignedLines([]);
    setTendered("");
    setCustomerId("");
    setOnAccount(false);
    setPaidNow("");
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
        ) : openStyle ? (
          /* ------------------------------------------- one style, opened */
          <div>
            <div className="mb-3 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setOpenStyleId(null)}
                className="rounded-lg border border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-700"
              >
                {ar ? "‹ رجوع" : "‹ Back"}
              </button>
              <span className="text-sm font-semibold text-ink-900">
                {ar ? openStyle.styleAr : openStyle.styleEn}
              </span>
              <span className="num text-xs text-ink-400">
                {openStyle.totalAvailable} {ar ? "متاح" : "available"}
              </span>
            </div>

            {openStyle.colours.map((colour) => (
              <div key={colour.key} className="mb-4">
                <div className="mb-2 flex items-center gap-2">
                  {colour.hex && (
                    <span
                      aria-hidden
                      className="h-3.5 w-3.5 shrink-0 rounded-full border border-ink-200"
                      style={{ backgroundColor: colour.hex }}
                    />
                  )}
                  <span className="text-sm font-medium text-ink-800">
                    {ar ? colour.colourAr : colour.colourEn}
                  </span>
                </div>

                <div className="flex flex-wrap gap-2">
                  {colour.sizes.map((p) => {
                    const inCart = cart.find((l) => l.variantId === p.variantId)?.quantity ?? 0;
                    const left = Number(p.available) - inCart;
                    return (
                      <button
                        key={p.variantId}
                        type="button"
                        onClick={() => add(p)}
                        disabled={left <= 0}
                        className="min-w-[4.5rem] rounded-lg border border-ink-200 bg-white px-3 py-2 text-center transition-colors hover:border-ink-900 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <div className="text-sm font-semibold text-ink-900">{p.size}</div>
                        <div
                          className={`num text-[11px] ${left <= 2 ? "text-bad" : "text-ink-400"}`}
                        >
                          {left}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : (
          /* ------------------------------------ one card per style, as a shop */
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
            {styleCards.map((s) => (
              <button
                key={s.styleId}
                type="button"
                onClick={() => setOpenStyleId(s.styleId)}
                className="overflow-hidden rounded-xl border border-ink-200 bg-white text-start transition-colors hover:border-ink-400"
              >
                <div className="aspect-[3/4] w-full bg-ink-100">
                  {s.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={s.image}
                      alt=""
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-xs text-ink-300">
                      {ar ? "من غير صورة" : "no photo"}
                    </div>
                  )}
                </div>

                <div className="p-2.5">
                  <div className="truncate text-sm font-medium text-ink-900">
                    {ar ? s.styleAr : s.styleEn}
                  </div>

                  <div className="mt-1 flex items-center gap-1">
                    {s.swatches.slice(0, 6).map((c) => (
                      <span
                        key={c.key}
                        aria-hidden
                        title={ar ? c.colourAr : c.colourEn}
                        className="h-2.5 w-2.5 rounded-full border border-ink-200"
                        style={{ backgroundColor: c.hex ?? "#d4d4d4" }}
                      />
                    ))}
                    {s.swatches.length > 6 && (
                      <span className="num text-[10px] text-ink-400">
                        +{s.swatches.length - 6}
                      </span>
                    )}
                  </div>

                  <div className="mt-1.5 flex items-baseline justify-between">
                    <span className="num text-sm font-semibold">{s.priceLabel}</span>
                    <span
                      className={`num text-xs ${
                        s.totalAvailable <= 3 ? "text-bad" : "text-ink-400"
                      }`}
                    >
                      {s.totalAvailable}
                    </span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* ------------------------------------- goods held for other people */}
        {filteredConsigned.length > 0 && !openStyle && (
          <div className="mt-5">
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-sm font-semibold text-ink-800">
                {ar ? "بضاعة أمانة" : "On consignment"}
              </h3>
              <span className="text-xs text-ink-400">
                {ar ? "مش بضاعتك — بتاخد نسبة" : "not yours — you take a share"}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
              {filteredConsigned.map((c) => {
                const inCart =
                  consignedLines.find((l) => l.itemId === c.itemId)?.quantity ?? 0;
                const left = c.available - inCart;
                return (
                  <button
                    key={c.itemId}
                    type="button"
                    onClick={() => addConsigned(c)}
                    disabled={left <= 0}
                    className="rounded-xl border border-dashed border-warn/60 bg-warn/5 p-3 text-start transition-colors hover:border-warn disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <div className="truncate text-sm font-medium text-ink-900">
                      {c.description}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-ink-500">
                      {[c.colour, c.size].filter(Boolean).join(" \u00b7 ")}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-warn">
                      {c.consignorName}
                    </div>
                    <div className="mt-1.5 flex items-baseline justify-between">
                      <span className="num text-sm font-semibold">
                        {Number(c.retailPrice).toFixed(2)}
                      </span>
                      <span
                        className={`num text-xs ${left <= 2 ? "text-bad" : "text-ink-400"}`}
                      >
                        {left}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
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
        <input
          type="hidden"
          name="consignedCart"
          value={JSON.stringify(
            consignedLines.map((l) => ({
              itemId: l.itemId,
              quantity: l.quantity,
              retailPrice: l.retailPrice,
            })),
          )}
        />
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

          {/* --------------------------- the half belonging to other people */}
          {consignedLines.length > 0 && (
            <ul className="mt-3 space-y-1.5 border-t border-dashed border-warn/50 pt-2">
              {consignedLines.map((l) => (
                <li key={l.itemId} className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-ink-900">{l.label}</div>
                    <div className="text-[11px] text-warn">
                      {ar ? "أمانة · " : "consigned · "}
                      {l.consignorName}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() =>
                        setConsignedLines((lines) =>
                          lines
                            .map((x) =>
                              x.itemId === l.itemId
                                ? { ...x, quantity: x.quantity - 1 }
                                : x,
                            )
                            .filter((x) => x.quantity > 0),
                        )
                      }
                      className="h-6 w-6 rounded border border-ink-200 text-xs"
                    >
                      −
                    </button>
                    <span className="num w-5 text-center text-sm">{l.quantity}</span>
                    <button
                      type="button"
                      disabled={l.quantity >= l.available}
                      onClick={() =>
                        setConsignedLines((lines) =>
                          lines.map((x) =>
                            x.itemId === l.itemId
                              ? { ...x, quantity: x.quantity + 1 }
                              : x,
                          ),
                        )
                      }
                      className="h-6 w-6 rounded border border-ink-200 text-xs disabled:opacity-30"
                    >
                      +
                    </button>
                  </div>

                  <span className="num w-20 shrink-0 text-end text-sm">
                    {money(l.retailPrice * l.quantity).toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 flex items-baseline justify-between border-t border-ink-300 pt-2">
            <span className="font-semibold">{ar ? "الإجمالي" : "Total"}</span>
            <span className="num text-xl font-semibold">{total.toFixed(2)}</span>
          </div>

          {/* What the shop actually earns, when part of the basket is not its
              own. The takings and the earnings are different numbers here, and
              a cashier reading only the total would think the day went better
              than it did. */}
          {consignedLines.length > 0 && (
            <div className="mt-1 space-y-0.5 text-xs">
              <div className="flex items-baseline justify-between text-ink-500">
                <span>{ar ? "منها بضاعتك" : "of which yours"}</span>
                <span className="num">{ownTotal.toFixed(2)}</span>
              </div>
              <div className="flex items-baseline justify-between text-warn">
                <span>{ar ? "بضاعة أمانة" : "consigned"}</span>
                <span className="num">{consignedTotal.toFixed(2)}</span>
              </div>
              <div className="flex items-baseline justify-between text-good">
                <span>{ar ? "عمولتك منها" : "your commission"}</span>
                <span className="num">{consignedCommission.toFixed(2)}</span>
              </div>
            </div>
          )}
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

          <div className="mb-2 flex items-center gap-2">
            <select
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              className={`${field} min-w-0 flex-1`}
            >
              <option value="">{ar ? "بدون عميل" : "No customer"}</option>
              {people.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.phone ? ` — ${c.phone}` : ""}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={() => {
                setAddingCustomer((v) => !v);
                setNewCustomer({ name: "", phone: "" });
                setDuplicate(null);
                setCustomerError(null);
              }}
              title={ar ? "عميل جديد" : "New customer"}
              className="shrink-0 rounded-lg border border-ink-300 px-3 py-2 text-sm font-semibold text-ink-700"
            >
              {addingCustomer ? "×" : "+"}
            </button>
          </div>

          {/* ------------------------------------------ a new face at the counter */}
          {addingCustomer && (
            <div className="mb-2 rounded-lg border border-ink-200 p-2">
              <div className="mb-2 grid grid-cols-2 gap-2">
                <input
                  value={newCustomer.name}
                  onChange={(e) =>
                    setNewCustomer((c) => ({ ...c, name: e.target.value }))
                  }
                  placeholder={ar ? "الاسم" : "Name"}
                  className={field}
                />
                <input
                  value={newCustomer.phone}
                  onChange={(e) => {
                    setNewCustomer((c) => ({ ...c, phone: e.target.value }));
                    // A changed number is a different question, so the old
                    // answer stops applying.
                    setDuplicate(null);
                  }}
                  placeholder={ar ? "الموبايل" : "Phone"}
                  dir="ltr"
                  inputMode="tel"
                  className={`${field} num`}
                />
              </div>

              {duplicate ? (
                <div className="rounded-lg bg-warn/10 px-2.5 py-2">
                  <p className="mb-2 text-xs text-warn">
                    {ar
                      ? `الرقم ده مسجّل باسم ${duplicate.name}.`
                      : `That number is already ${duplicate.name}'s.`}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setCustomerId(duplicate.id);
                        setPeople((list) =>
                          list.some((p) => p.id === duplicate.id)
                            ? list
                            : [{ id: duplicate.id, name: duplicate.name, phone: duplicate.phone }, ...list],
                        );
                        setAddingCustomer(false);
                        setDuplicate(null);
                      }}
                      className="rounded-lg bg-ink-900 px-3 py-1.5 text-xs font-medium text-white"
                    >
                      {ar ? "أيوه دي هي" : "That's them"}
                    </button>
                    <button
                      type="button"
                      onClick={() => saveCustomer(true)}
                      disabled={savingCustomer}
                      className="rounded-lg border border-ink-300 px-3 py-1.5 text-xs text-ink-700 disabled:opacity-50"
                    >
                      {ar ? "لأ، دي واحدة تانية" : "No, someone else"}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => saveCustomer(false)}
                  disabled={savingCustomer || !newCustomer.name.trim()}
                  className="rounded-lg bg-ink-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                >
                  {savingCustomer
                    ? (ar ? "…" : "…")
                    : ar ? "ضيف واختار" : "Add and select"}
                </button>
              )}

              {customerError && (
                <p className="mt-2 text-xs text-bad">{customerError}</p>
              )}
            </div>
          )}

          {/* ----------------------------------------------- part payment */}
          {mayGiveCredit && consignedLines.length === 0 && (
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

          {consignedLines.length > 0 && (
            <p className="mb-2 rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">
              {ar
                ? "في بضاعة أمانة في السلة — لازم تتدفع كاملة، مفيش آجل عليها."
                : "Consigned goods in the basket must be paid in full — no credit on them."}
            </p>
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
            disabled={
              pending ||
              (cart.length === 0 && consignedLines.length === 0) ||
              !priced ||
              creditBlocked
            }
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
