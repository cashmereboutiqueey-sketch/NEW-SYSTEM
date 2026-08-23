"use client";

import { useActionState, useState } from "react";
import { createPurchaseOrderAction, receiveGoodsAction } from "./actions";
import type { FormState } from "@/components/entity-form";
import type { Locale } from "@/lib/i18n";

const initial: FormState = {};
const field =
  "rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm text-ink-900 " +
  "focus:border-rose-deep focus:outline-none focus:ring-1 focus:ring-rose";
const label = "mb-1 block text-xs font-medium text-ink-600";

type Material = {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string;
  uom: string;
  basePrice: string;
  moq: string | null;
};

type Line = { materialId: string; quantity: number; unitPrice: number };

export function PurchaseOrderForm({
  locale,
  suppliers,
  materials,
  today,
}: {
  locale: Locale;
  suppliers: { id: string; label: string; creditDays: number }[];
  materials: Material[];
  today: string;
}) {
  const [state, formAction, pending] = useActionState(createPurchaseOrderAction, initial);
  const [lines, setLines] = useState<Line[]>([]);
  const ar = locale === "ar";

  const byId = new Map(materials.map((m) => [m.id, m]));
  const total = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);

  const addLine = () =>
    setLines((prev) => [
      ...prev,
      { materialId: materials[0]?.id ?? "", quantity: 0, unitPrice: Number(materials[0]?.basePrice ?? 0) },
    ]);

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l, x) => (x === i ? { ...l, ...patch } : l)));

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="lines" value={JSON.stringify(lines.filter((l) => l.quantity > 0))} />

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className={label} htmlFor="supplierId">{ar ? "المورد" : "Supplier"}</label>
          <select id="supplierId" name="supplierId" required className={`${field} w-full`}>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} — {s.creditDays} {ar ? "يوم ائتمان" : "days credit"}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="orderDate">{ar ? "تاريخ الأمر" : "Order date"}</label>
          <input id="orderDate" name="orderDate" type="date" required defaultValue={today} dir="ltr" className={`${field} w-full`} />
        </div>
        <div>
          <label className={label} htmlFor="expectedDate">{ar ? "التسليم المتوقع" : "Expected delivery"}</label>
          <input id="expectedDate" name="expectedDate" type="date" defaultValue={today} dir="ltr" className={`${field} w-full`} />
        </div>
      </div>

      <div className="rounded-lg border border-ink-200 p-3">
        {lines.length === 0 ? (
          <p className="py-3 text-center text-sm text-ink-400">
            {ar ? "أضف سطر خامة" : "Add a material line"}
          </p>
        ) : (
          <ul className="space-y-2">
            {lines.map((l, i) => {
              const m = byId.get(l.materialId);
              const belowMoq = m?.moq != null && l.quantity > 0 && l.quantity < Number(m.moq);
              return (
                <li key={i} className="flex flex-wrap items-end gap-2">
                  <select
                    value={l.materialId}
                    onChange={(e) => {
                      const next = byId.get(e.target.value);
                      setLine(i, {
                        materialId: e.target.value,
                        unitPrice: Number(next?.basePrice ?? 0),
                      });
                    }}
                    className={`${field} min-w-56 flex-1`}
                  >
                    {materials.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.code} — {ar ? m.nameAr : m.nameEn}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number" step="0.01" min="0" value={l.quantity || ""}
                    onChange={(e) => setLine(i, { quantity: Number(e.target.value) })}
                    placeholder={m?.uom ?? (ar ? "الكمية" : "Qty")}
                    dir="ltr" className={`${field} num w-24`}
                  />
                  <input
                    type="number" step="0.01" min="0" value={l.unitPrice || ""}
                    onChange={(e) => setLine(i, { unitPrice: Number(e.target.value) })}
                    placeholder={ar ? "السعر" : "Price"}
                    dir="ltr" className={`${field} num w-28`}
                  />
                  <span className="num w-24 text-end text-sm font-medium">
                    {(l.quantity * l.unitPrice).toFixed(2)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setLines((p) => p.filter((_, x) => x !== i))}
                    className="text-xs text-ink-400 hover:text-bad"
                  >
                    ✕
                  </button>
                  {belowMoq && (
                    <p className="w-full text-xs text-warn">
                      {ar
                        ? `أقل من الحد الأدنى للطلب (${m!.moq} ${m!.uom}) — المورد ممكن يرفض.`
                        : `Below the minimum order quantity of ${m!.moq} ${m!.uom} — the supplier may refuse.`}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-3 flex items-center justify-between border-t border-ink-100 pt-3">
          <button
            type="button"
            onClick={addLine}
            disabled={materials.length === 0}
            className="rounded-lg border border-ink-300 px-3 py-1.5 text-sm text-ink-700 disabled:opacity-40"
          >
            {ar ? "+ سطر" : "+ Line"}
          </button>
          <span className="num text-sm font-semibold">
            {ar ? "الإجمالي" : "Total"} {total.toFixed(2)}
          </span>
        </div>
      </div>

      <p className="text-xs text-ink-500">
        {ar
          ? "السعر هنا هو سعر الشراء — الشحن والجمارك بيتضافوا من بطاقة الخامة."
          : "The price here is the purchase price — freight and duty are added from the material record."}
      </p>

      {state.error && (
        <p role="alert" className="rounded-lg bg-bad/10 px-3 py-2 text-sm text-bad">{state.error}</p>
      )}
      {state.success && (
        <p role="status" className="rounded-lg bg-good/10 px-3 py-2 text-sm text-good">{state.success}</p>
      )}

      <button
        type="submit"
        disabled={pending || lines.filter((l) => l.quantity > 0).length === 0}
        className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
      >
        {pending ? (ar ? "جارٍ الحفظ…" : "Saving…") : (ar ? "أصدر أمر الشراء" : "Raise purchase order")}
      </button>
    </form>
  );
}

type ReceiptLine = {
  purchaseOrderLineId: string;
  code: string;
  name: string;
  outstanding: number;
  orderedPrice: number;
  acceptedQty: number;
  rejectedQty: number;
  actualUnitPrice: number;
};

export function GoodsReceiptForm({
  locale,
  purchaseOrderId,
  poNumber,
  entityId,
  locations,
  today,
  lines: initialLines,
}: {
  locale: Locale;
  purchaseOrderId: string;
  poNumber: string;
  entityId: string;
  locations: { id: string; label: string }[];
  today: string;
  lines: Omit<ReceiptLine, "acceptedQty" | "rejectedQty" | "actualUnitPrice">[];
}) {
  const [state, formAction, pending] = useActionState(receiveGoodsAction, initial);
  const [lines, setLines] = useState<ReceiptLine[]>(
    initialLines.map((l) => ({
      ...l,
      acceptedQty: l.outstanding,
      rejectedQty: 0,
      actualUnitPrice: l.orderedPrice,
    })),
  );
  const ar = locale === "ar";

  const setLine = (i: number, patch: Partial<ReceiptLine>) =>
    setLines((prev) => prev.map((l, x) => (x === i ? { ...l, ...patch } : l)));

  const variance = lines.reduce(
    (s, l) => s + (l.actualUnitPrice - l.orderedPrice) * l.acceptedQty,
    0,
  );

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="purchaseOrderId" value={purchaseOrderId} />
      <input type="hidden" name="entityId" value={entityId} />
      <input
        type="hidden"
        name="lines"
        value={JSON.stringify(
          lines.map((l) => ({
            purchaseOrderLineId: l.purchaseOrderLineId,
            acceptedQty: l.acceptedQty,
            rejectedQty: l.rejectedQty,
            actualUnitPrice: l.actualUnitPrice,
          })),
        )}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className={label} htmlFor={`loc-${purchaseOrderId}`}>
            {ar ? "مكان الاستلام" : "Received into"}
          </label>
          <select id={`loc-${purchaseOrderId}`} name="locationId" required className={`${field} w-full`}>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor={`date-${purchaseOrderId}`}>
            {ar ? "تاريخ الاستلام" : "Received on"}
          </label>
          <input
            id={`date-${purchaseOrderId}`} name="receivedDate" type="date" required
            defaultValue={today} dir="ltr" className={`${field} w-full`}
          />
        </div>
        <div>
          <label className={label} htmlFor={`inv-${purchaseOrderId}`}>
            {ar ? "رقم فاتورة المورد" : "Supplier invoice"}
          </label>
          <input id={`inv-${purchaseOrderId}`} name="invoiceRef" dir="ltr" className={`${field} w-full`} />
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-ink-200">
        <table className="w-full text-sm">
          <thead className="bg-ink-50/60 text-xs text-ink-500">
            <tr>
              <th className="p-2 text-start">{ar ? "الخامة" : "Material"}</th>
              <th className="p-2 text-end">{ar ? "المتبقي" : "Outstanding"}</th>
              <th className="p-2 text-end">{ar ? "مقبول" : "Accepted"}</th>
              <th className="p-2 text-end">{ar ? "مرفوض" : "Rejected"}</th>
              <th className="p-2 text-end">{ar ? "سعر الأمر" : "Ordered"}</th>
              <th className="p-2 text-end">{ar ? "سعر الفاتورة" : "Invoiced"}</th>
              <th className="p-2 text-end">{ar ? "الفرق" : "Variance"}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const v = (l.actualUnitPrice - l.orderedPrice) * l.acceptedQty;
              return (
                <tr key={l.purchaseOrderLineId} className="border-t border-ink-100">
                  <td className="p-2">
                    <code dir="ltr" className="text-xs text-ink-500">{l.code}</code>
                    <span className="ms-2">{l.name}</span>
                  </td>
                  <td className="num p-2 text-end">{l.outstanding}</td>
                  <td className="p-2 text-end">
                    <input
                      type="number" step="0.01" min="0" max={l.outstanding}
                      value={l.acceptedQty}
                      onChange={(e) => setLine(i, { acceptedQty: Number(e.target.value) })}
                      dir="ltr" className={`${field} num w-24 px-2 py-1`}
                    />
                  </td>
                  <td className="p-2 text-end">
                    <input
                      type="number" step="0.01" min="0"
                      value={l.rejectedQty}
                      onChange={(e) => setLine(i, { rejectedQty: Number(e.target.value) })}
                      dir="ltr" className={`${field} num w-20 px-2 py-1`}
                    />
                  </td>
                  <td className="num p-2 text-end text-ink-500">{l.orderedPrice.toFixed(2)}</td>
                  <td className="p-2 text-end">
                    <input
                      type="number" step="0.01" min="0"
                      value={l.actualUnitPrice}
                      onChange={(e) => setLine(i, { actualUnitPrice: Number(e.target.value) })}
                      dir="ltr" className={`${field} num w-24 px-2 py-1`}
                    />
                  </td>
                  <td className={`num p-2 text-end ${v === 0 ? "" : v > 0 ? "text-bad" : "text-good"}`}>
                    {v === 0 ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-ink-500">
        {ar
          ? "المرفوض بيتسجّل ومابيدخلش المخزن. الفرق بين سعر الأمر وسعر الفاتورة هو اللي بيفسّر ارتفاع تكلفة القطعة."
          : "Rejected goods are recorded but never enter stock. The gap between the ordered and invoiced price is what explains a rise in the cost per garment."}
      </p>

      {variance !== 0 && (
        <p className="rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn">
          {ar ? "فرق السعر الإجمالي" : "Total price variance"}:{" "}
          <span className="num">{variance > 0 ? "+" : ""}{variance.toFixed(2)}</span>
        </p>
      )}

      {state.error && (
        <p role="alert" className="rounded-lg bg-bad/10 px-3 py-2 text-sm text-bad">{state.error}</p>
      )}
      {state.success && (
        <p role="status" className="rounded-lg bg-good/10 px-3 py-2 text-sm text-good">{state.success}</p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? (ar ? "جارٍ الاستلام…" : "Receiving…") : (ar ? `استلم ${poNumber}` : `Receive ${poNumber}`)}
      </button>
    </form>
  );
}
