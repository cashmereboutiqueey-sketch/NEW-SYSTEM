"use client";

import { useActionState, useMemo, useState } from "react";
import { sellConsignedAction, type ConsignmentState } from "@/app/(app)/consignment/actions";
import { RequestIdField } from "@/components/request-id";
import { CustomerPicker } from "@/components/customer-picker";
import { cairoDateKey } from "@/lib/cairo-date";

type Item = {
  id: string;
  itemCode: string;
  description: string;
  image: string | null;
  colour: string | null;
  size: string | null;
  consignorName: string;
  retailPrice: string;
  left: number;
};

const field = "w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep";

export function ModeratorConsignmentForm({
  ar,
  items,
  customers,
}: {
  ar: boolean;
  items: Item[];
  customers: { id: string; name: string; phone: string | null }[];
}) {
  const [state, action, pending] = useActionState<ConsignmentState, FormData>(sellConsignedAction, {});
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [customerId, setCustomerId] = useState("");
  const [method, setMethod] = useState("COD");
  const selected = items.find((item) => item.id === selectedId);
  const matching = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items.slice(0, 8);
    return items.filter((item) =>
      [item.itemCode, item.description, item.colour, item.size, item.consignorName]
        .some((value) => value?.toLowerCase().includes(q)),
    ).slice(0, 12);
  }, [items, query]);

  return (
    <form action={action} className="space-y-4">
      <RequestIdField state={state} />
      <input type="hidden" name="itemId" value={selectedId} />
      <input type="hidden" name="saleDate" value={cairoDateKey()} />
      <input type="hidden" name="soldPrice" value={price} />
      <input type="hidden" name="paymentMethod" value={method} />

      <label className="block text-sm">
        <span className="mb-1 block text-ink-600">{ar ? "اختار قطعة الأمانة بالكود أو الاسم أو صاحبها" : "Find consignment by code, item or owner"}</span>
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} className={field} />
      </label>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {matching.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => { setSelectedId(item.id); setPrice(item.retailPrice); setQuantity("1"); }}
            className={`overflow-hidden rounded-lg border text-start ${selectedId === item.id ? "border-rose-deep ring-2 ring-rose/40" : "border-ink-200 hover:border-rose-deep"}`}
          >
            {item.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={item.image} alt="" className="aspect-[3/4] w-full object-cover" />
            ) : <span className="flex aspect-[3/4] items-center justify-center bg-ink-100 text-xs text-ink-400">{ar ? "مفيش صورة" : "No photo"}</span>}
            <span className="block p-2 text-sm">
              <code dir="ltr" className="block text-xs text-ink-500">{item.itemCode}</code>
              <span className="block font-medium">{item.description}</span>
              <span className="block text-xs text-ink-500">{item.consignorName} · {item.colour} {item.size} · {ar ? "فاضل" : "Left"} {item.left}</span>
            </span>
          </button>
        ))}
        {matching.length === 0 && <p className="col-span-full py-3 text-sm text-ink-500">{ar ? "مفيش قطعة مطابقة." : "No matching item."}</p>}
      </div>

      {selected && (
        <div className="grid gap-3 rounded-lg border border-ink-200 p-3 sm:grid-cols-2 lg:grid-cols-4">
          <p className="sm:col-span-2 lg:col-span-4 text-sm font-medium">{selected.description} · {selected.itemCode} · {selected.consignorName}</p>
          <label className="text-sm"><span className="mb-1 block text-ink-600">{ar ? "العدد" : "Quantity"}</span>
            <input name="quantity" type="number" min="1" max={selected.left} step="1" value={quantity} onChange={(event) => setQuantity(event.target.value)} className={field} />
          </label>
          <label className="text-sm"><span className="mb-1 block text-ink-600">{ar ? "سعر القطعة" : "Unit price"}</span>
            <input type="number" min="0" step="0.01" value={price} onChange={(event) => setPrice(event.target.value)} className={field} />
          </label>
          <div className="text-sm">
            <p className="mb-1 block text-ink-600">{ar ? "العميل" : "Customer"}</p>
            <CustomerPicker ar={ar} people={customers} value={customerId} onChange={(id) => setCustomerId(id)} source="MODERATOR" name="customerId" />
          </div>
          <label className="text-sm"><span className="mb-1 block text-ink-600">{ar ? "طريقة التحصيل" : "Payment method"}</span>
            <select value={method} onChange={(event) => setMethod(event.target.value)} className={field}>
              <option value="COD">{ar ? "عند الاستلام" : "Cash on delivery"}</option>
              <option value="CASH">{ar ? "كاش" : "Cash"}</option>
              <option value="CARD">{ar ? "بطاقة" : "Card"}</option>
              <option value="BANK_TRANSFER">{ar ? "تحويل بنكي" : "Bank transfer"}</option>
              <option value="INSTAPAY">Instapay</option>
            </select>
          </label>
          <p className="sm:col-span-2 lg:col-span-4 text-xs text-ink-500">
            {ar ? "بيعة الأمانة بتتسجل في حساب صاحب البضاعة، وشحنها بيتعمل خارج شيت شحن Cashmere حالياً." : "This records the owner's consignment sale. Its shipment is handled outside the Cashmere courier sheet for now."}
          </p>
          <button type="submit" disabled={pending || Number(quantity) < 1 || Number(quantity) > selected.left || (method === "COD" && !customerId)} className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 sm:col-span-2 lg:col-span-4">
            {pending ? (ar ? "بيسجل…" : "Recording…") : ar ? "سجل بيعة الأمانة" : "Record consignment sale"}
          </button>
          {method === "COD" && !customerId && <p className="sm:col-span-2 lg:col-span-4 text-xs text-warn">{ar ? "اختار العميل للطلب عند الاستلام." : "Choose a customer for cash on delivery."}</p>}
        </div>
      )}
      {state.error && <p role="alert" className="text-sm text-bad">{state.error}</p>}
      {state.success && <p role="status" className="text-sm text-good">{state.success}</p>}
    </form>
  );
}
