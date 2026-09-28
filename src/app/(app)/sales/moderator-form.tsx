"use client";

import { useActionState, useMemo, useState } from "react";
import { createModeratorSaleAction } from "./actions";
import type { FormState } from "@/components/entity-form";
import { RequestIdField } from "@/components/request-id";
import type { Locale } from "@/lib/i18n";
import { CustomerPicker, type Person } from "@/components/customer-picker";
import { StyleVariantPicker } from "@/components/style-variant-picker";
import { CourierZoneCreate } from "@/components/courier-zone-create";
import { EGYPT_GOVERNORATES } from "@/lib/egypt-governorates";

const initial: FormState = {};
const field =
  "rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm text-ink-900 " +
  "focus:border-rose-deep focus:outline-none focus:ring-1 focus:ring-rose";
const label = "mb-1 block text-xs font-medium text-ink-600";

/** Rounds the way the invoice does, so the screen shows what will be charged. */
const money = (n: number) => Math.round(n * 100) / 100;

type Product = {
  variantId: string;
  styleId: string;
  styleName: string;
  sku: string;
  label: string;
  available: number;
  retailPrice: number;
  image: string | null;
  styleImage: string | null;
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
  zones,
}: {
  locale: Locale;
  products: Product[];
  customers: { id: string; name: string; phone: string | null }[];
  locations: { id: string; label: string }[];
  channels: { id: string; label: string }[];
  entityId: string;
  canDiscount: boolean;
  today: string;
  /** The courier's areas, by governorate, with what it charges to reach each. */
  zones: { governorate: string; regions: { id: string; region: string; price: string }[] }[];
}) {
  const [state, formAction, pending] = useActionState(createModeratorSaleAction, initial);
  const [lines, setLines] = useState<Line[]>([]);
  const [discountPct, setDiscountPct] = useState(0);
  const [shipping, setShipping] = useState(0);
  const [method, setMethod] = useState("COD");
  const [customerId, setCustomerId] = useState("");
  const [addedCustomer, setAddedCustomer] = useState<Person | null>(null);
  const [governorate, setGovernorate] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [localZones, setLocalZones] = useState(zones);
  const [region, setRegion] = useState("");
  const ar = locale === "ar";

  const customer = addedCustomer?.id === customerId
    ? addedCustomer
    : customers.find((c) => c.id === customerId);
  const regions = localZones.find((z) => z.governorate === governorate)?.regions ?? [];
  const zone = regions.find((r) => r.id === zoneId);

  const byId = useMemo(() => new Map(products.map((p) => [p.variantId, p])), [products]);

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
      <RequestIdField state={state} />
      <input type="hidden" name="entityId" value={entityId} />
      <input type="hidden" name="lines" value={JSON.stringify(lines)} />
      <input type="hidden" name="discountPct" value={discountPct} />
      <input type="hidden" name="shippingAmount" value={shipping} />
      <input type="hidden" name="paymentMethod" value={method} />

      {/* ------------------------------------------------------ what they want */}
      <div>
        <p className={label}>
          {ar ? "دوّر على الصنف" : "Find the item"}
        </p>
        <StyleVariantPicker ar={ar} variants={products} kind="stock" onSelect={add} />
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
                  {p?.image && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.image} alt="" className="h-12 w-9 rounded object-cover" />
                  )}
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
          <p className={label}>{ar ? "العميلة" : "Customer"}</p>
          <CustomerPicker
            ar={ar}
            people={customers}
            value={customerId}
            onChange={(id, person) => { setCustomerId(id); setAddedCustomer(person); }}
            source="MODERATOR"
            name="customerId"
          />
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

      {/* ------------------------------------------------------------ delivery */}
      <fieldset className="rounded-xl border border-ink-100 p-3">
        <legend className="px-1 text-xs font-medium text-ink-600">
          {ar ? "التوصيل — بيطلع في شيت MG زي ما هو" : "Delivery — goes onto the MG sheet as written"}
        </legend>
        <div className="grid gap-3 sm:grid-cols-4">
          <div>
            <label className={label} htmlFor="mod-recipient">{ar ? "اسم المستلم" : "Recipient"}</label>
            <input
              id="mod-recipient" name="recipientName" type="text" className={`${field} w-full`}
              placeholder={customer?.name ?? ""}
            />
          </div>
          <div>
            <label className={label} htmlFor="mod-phone">{ar ? "التليفون" : "Phone"}</label>
            <input
              id="mod-phone" name="shippingPhone" type="tel" dir="ltr" className={`${field} num w-full`}
              placeholder={customer?.phone ?? "01xxxxxxxxx"}
            />
          </div>
          <div>
            <label className={label} htmlFor="mod-phone2">{ar ? "تليفون تاني" : "Second phone"}</label>
            <input id="mod-phone2" name="secondPhone" type="tel" dir="ltr" className={`${field} num w-full`} />
          </div>
          <div>
            <label className={label} htmlFor="mod-gov">{ar ? "المحافظة" : "Governorate"}</label>
            <select
              id="mod-gov" name="governorate" className={`${field} w-full`} value={governorate}
              onChange={(e) => {
                setGovernorate(e.target.value);
                setZoneId("");
                setRegion("");
              }}
            >
              <option value="">{ar ? "اختار" : "Choose"}</option>
              {[...new Set([...EGYPT_GOVERNORATES, ...localZones.map((z) => z.governorate)])].map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="mod-zone">{ar ? "المنطقة" : "Area"}</label>
            <select
              id="mod-zone" name="courierZoneId" className={`${field} w-full`} value={zoneId}
              disabled={!governorate}
              onChange={(e) => {
                setZoneId(e.target.value);
                const picked = regions.find((r) => r.id === e.target.value);
                // The courier's price as a starting point, never over one typed.
                if (picked && !shipping) setShipping(Number(picked.price));
              }}
            >
              <option value="">{ar ? "اختار" : "Choose"}</option>
              {regions.map((r) => (
                <option key={r.id} value={r.id}>{r.region}</option>
              ))}
            </select>
            {zone && (
              <p className="mt-1 text-xs text-ink-500">
                {ar ? `MG بتاخد ${Number(zone.price)} جنيه` : `MG charges ${Number(zone.price)}`}
              </p>
            )}
            {governorate && (
              <div className="mt-2">
                <CourierZoneCreate
                  ar={ar}
                  governorate={governorate}
                  onCreated={(added) => {
                    setLocalZones((current) => {
                      const found = current.find((group) => group.governorate === added.governorate);
                      if (!found) return [...current, { governorate: added.governorate, regions: [added] }];
                      return current.map((group) => group.governorate === added.governorate
                        ? { ...group, regions: [...group.regions.filter((item) => item.id !== added.id), added] }
                        : group);
                    });
                    setZoneId(added.id);
                    setRegion(added.region);
                    if (!shipping) setShipping(Number(added.price));
                  }}
                />
              </div>
            )}
          </div>
          {governorate && !zoneId && (
            <div>
              <label className={label} htmlFor="mod-region">{ar ? "المدينة / المنطقة" : "City / area"}</label>
              <input id="mod-region" name="region" value={region} onChange={(event) => setRegion(event.target.value)} className={`${field} w-full`} />
              <p className="mt-1 text-xs text-warn">{ar ? "العنوان هيتحفظ، لكن شيت MG محتاج إضافة منطقة الشحن وسعرها." : "The address will be saved; the MG sheet needs a delivery area and its price."}</p>
            </div>
          )}
          <div className="sm:col-span-3">
            <label className={label} htmlFor="mod-address">{ar ? "العنوان بالتفصيل" : "Full address"}</label>
            <input
              id="mod-address" name="addressLine" type="text" className={`${field} w-full`}
              placeholder={ar ? "الشارع، رقم العمارة، الدور، الشقة، علامة مميزة" : "Street, building, floor, flat, landmark"}
            />
          </div>
        </div>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-4">
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
              ["COD", ar ? "المندوب يحصّل عند الاستلام" : "Courier collects on delivery"],
              ["BANK_TRANSFER", ar ? "تحويل بنكي وصل" : "Bank transfer received"],
              ["INSTAPAY", ar ? "InstaPay وصل" : "InstaPay received"],
              ["CASH", ar ? "كاش استلمناه فعلًا" : "Cash already received"],
            ] as const).map(([value, text]) => (
              <button
                key={value}
                type="button"
                onClick={() => setMethod(value)}
                className={`rounded-lg border px-3 py-2 text-sm ${
                  method === value ? "border-rose bg-rose text-ink-900" : "border-ink-200"
                }`}
              >
                {text}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-ink-500">{ar ? "اختار طريقة الدفع اللي حصلت فعلًا. لو العميل حوّل بعد تسجيل الأوردر، صحّحها من التسويات." : "Choose what actually happened. If the customer transfers after the order is recorded, correct it in Reconciliation."}</p>
        </div>

        {method === "COD" && <div>
          <label className={label} htmlFor="mod-fee">{ar ? "رسوم التحصيل" : "Collection fee"}</label>
          <input
            id="mod-fee" name="fee" type="number" min="0" step="0.01" defaultValue={0}
            dir="ltr" className={`${field} num w-28`}
          />
        </div>}

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
