"use client";

import { useActionState, useMemo, useState } from "react";
import {
  createBatchesAction, uploadReportAction, updateDestinationAction, type BatchState,
} from "./actions";
import type { FormState } from "@/components/entity-form";
import { RequestIdField } from "@/components/request-id";

export type ReadyOrder = {
  id: string;
  orderNumber: string;
  recipient: string | null;
  phone: string | null;
  governorate: string | null;
  region: string | null;
  addressLine: string | null;
  branch: string | null;
  pieces: number;
  codAmount: string;
  problems: string[];
};

const BRANCHES: Record<string, string> = { "1": "MG Express", "5": "MG Cairo" };

const PROBLEM_AR: Record<string, string> = {
  "no delivery area": "مفيش منطقة",
  "no phone number": "مفيش تليفون",
  "no street address": "مفيش عنوان",
  "no recipient name": "مفيش اسم مستلم",
};

/**
 * Today's parcels, ticked and turned into the courier's sheets.
 *
 * Orders that cannot go yet are shown, greyed, with what is missing — so the
 * address gets fixed now, not when the courier's import rejects the row and
 * the parcel quietly misses a day.
 */
export function ReadyToShipForm({ ar, orders }: { ar: boolean; orders: ReadyOrder[] }) {
  const [state, action, pending] = useActionState<BatchState, FormData>(createBatchesAction, {});
  const shippable = useMemo(() => orders.filter((o) => o.problems.length === 0), [orders]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(shippable.map((o) => o.id)));

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const chosen = shippable.filter((o) => picked.has(o.id));
  const cod = chosen.reduce((sum, o) => sum + Number(o.codAmount), 0);

  return (
    <form action={action} className="space-y-3">
      <RequestIdField state={state} />
      {chosen.map((o) => (
        <input key={o.id} type="hidden" name="salesOrderId" value={o.id} />
      ))}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-100 text-start text-xs text-ink-500">
              <th className="py-2 pe-2">
                <input
                  type="checkbox"
                  aria-label={ar ? "الكل" : "All"}
                  checked={chosen.length === shippable.length && shippable.length > 0}
                  onChange={(e) =>
                    setPicked(e.target.checked ? new Set(shippable.map((o) => o.id)) : new Set())
                  }
                />
              </th>
              <th className="py-2 pe-3 text-start">{ar ? "الأوردر" : "Order"}</th>
              <th className="py-2 pe-3 text-start">{ar ? "المستلم" : "Recipient"}</th>
              <th className="py-2 pe-3 text-start">{ar ? "المنطقة" : "Area"}</th>
              <th className="py-2 pe-3 text-start">{ar ? "الفرع" : "Branch"}</th>
              <th className="py-2 pe-3 text-end">{ar ? "قطع" : "Pcs"}</th>
              <th className="py-2 text-end">{ar ? "يتحصّل" : "COD"}</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => {
              const blocked = o.problems.length > 0;
              return (
                <tr key={o.id} className={`border-b border-ink-50 ${blocked ? "text-ink-400" : ""}`}>
                  <td className="py-2 pe-2">
                    <input
                      type="checkbox"
                      disabled={blocked}
                      checked={!blocked && picked.has(o.id)}
                      onChange={() => toggle(o.id)}
                      aria-label={o.orderNumber}
                    />
                  </td>
                  <td className="py-2 pe-3 num text-xs" dir="ltr">{o.orderNumber}</td>
                  <td className="py-2 pe-3">
                    {o.recipient ?? "—"}
                    {o.phone && <span className="ms-2 num text-xs text-ink-400" dir="ltr">{o.phone}</span>}
                  </td>
                  <td className="py-2 pe-3">
                    {blocked ? (
                      <span className="text-xs text-bad">
                        {o.problems.map((p) => (ar ? PROBLEM_AR[p] ?? p : p)).join(" · ")}
                      </span>
                    ) : (
                      <>
                        {o.governorate} — {o.region}
                      </>
                    )}
                  </td>
                  <td className="py-2 pe-3 text-xs">{o.branch ? BRANCHES[o.branch] ?? o.branch : "—"}</td>
                  <td className="py-2 pe-3 num text-end">{o.pieces}</td>
                  <td className="py-2 num text-end">{Number(o.codAmount).toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      {state.success && <p className="text-sm text-good">{state.success}</p>}
      {state.batches && state.batches.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {state.batches.map((b) => (
            <a
              key={b.batchId}
              href={`/shipping/batches/${b.batchId}/manifest`}
              className="rounded-lg bg-good px-3 py-1.5 text-sm font-medium text-white"
            >
              {ar ? "نزّل شيت " : "Download "}
              {BRANCHES[b.branch] ?? b.branch} ({b.shipments})
            </a>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-600">
          {ar
            ? `${chosen.length} أوردر · يتحصّل ${cod.toLocaleString()} جنيه`
            : `${chosen.length} orders · ${cod.toLocaleString()} to collect`}
        </p>
        <button
          type="submit"
          disabled={pending || chosen.length === 0}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? (ar ? "بيتعمل…" : "Working…") : ar ? "اعمل شيت MG" : "Make MG sheets"}
        </button>
      </div>
    </form>
  );
}

/**
 * The courier's orders report, uploaded to bring its statuses back.
 *
 * Exported from MG's «تقرير الاوردرات». Reading the same report twice changes
 * nothing, so uploading the day's report every evening is safe.
 */
export function ReportUploadForm({ ar }: { ar: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(uploadReportAction, {});
  const [fileName, setFileName] = useState<string | null>(null);

  return (
    <form action={action} className="space-y-3">
      <RequestIdField state={state} />
      <label
        htmlFor="mg-report"
        className="flex cursor-pointer items-center justify-center rounded-xl border border-dashed border-ink-300 px-4 py-6 text-sm text-ink-600 hover:border-ink-400"
      >
        {fileName ??
          (ar
            ? "اختار ملف «تقرير الاوردرات» من موقع MG (تصدير Excel)"
            : "Choose MG's orders report (Export Excel)")}
      </label>
      <input
        id="mg-report"
        name="report"
        type="file"
        accept=".xlsx,.xls,.html,.htm"
        className="sr-only"
        onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
      />

      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      {state.success && <p className="text-sm text-good">{state.success}</p>}

      <button
        type="submit"
        disabled={pending || !fileName}
        className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? (ar ? "بيتقرا…" : "Reading…") : ar ? "حدّث الحالات" : "Update statuses"}
      </button>
    </form>
  );
}

export type ZoneGroup = { governorate: string; regions: { id: string; region: string; price: string }[] };

const small =
  "w-full rounded-lg border border-ink-200 bg-panel px-2 py-1.5 text-sm outline-none focus:border-rose-deep";

/**
 * The details an order is missing, filled in where they are noticed.
 *
 * Mostly website orders: the customer typed "Nasr City" and the courier knows
 * the place as «مدينة نصر», so somebody picks the courier's area once. What
 * the order already has is shown, and only what is changed is sent.
 */
export function DestinationForm({ ar, order, zones }: { ar: boolean; order: ReadyOrder; zones: ZoneGroup[] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(updateDestinationAction, {});
  const [governorate, setGovernorate] = useState(
    zones.some((z) => z.governorate === order.governorate) ? order.governorate ?? "" : "",
  );
  const regions = zones.find((z) => z.governorate === governorate)?.regions ?? [];

  return (
    <form action={action} className="grid gap-2 rounded-lg border border-ink-100 p-3 sm:grid-cols-6">
      <RequestIdField state={state} />
      <input type="hidden" name="salesOrderId" value={order.id} />
      <div className="sm:col-span-6 flex flex-wrap items-center gap-2 text-sm">
        <span className="num text-xs" dir="ltr">{order.orderNumber}</span>
        <span className="text-xs text-bad">
          {order.problems.map((p) => (ar ? PROBLEM_AR[p] ?? p : p)).join(" · ")}
        </span>
        {order.region && !zones.some((z) => z.regions.some((r) => r.region === order.region)) && (
          <span className="text-xs text-ink-500">
            {ar ? `العميل كتب: «${order.region}»` : `Customer wrote: «${order.region}»`}
          </span>
        )}
      </div>
      <input name="recipientName" defaultValue={order.recipient ?? ""} placeholder={ar ? "المستلم" : "Recipient"} className={small} />
      <input name="shippingPhone" defaultValue={order.phone ?? ""} placeholder={ar ? "التليفون" : "Phone"} dir="ltr" className={small} />
      <select className={small} value={governorate} onChange={(e) => setGovernorate(e.target.value)} aria-label={ar ? "المحافظة" : "Governorate"}>
        <option value="">{ar ? "المحافظة" : "Governorate"}</option>
        {zones.map((z) => <option key={z.governorate} value={z.governorate}>{z.governorate}</option>)}
      </select>
      <select name="courierZoneId" required className={small} disabled={!governorate} aria-label={ar ? "المنطقة" : "Area"} defaultValue="">
        <option value="">{ar ? "المنطقة" : "Area"}</option>
        {regions.map((r) => <option key={r.id} value={r.id}>{r.region}</option>)}
      </select>
      <input name="addressLine" defaultValue={order.addressLine ?? ""} placeholder={ar ? "العنوان بالتفصيل" : "Full address"} className={`${small} sm:col-span-2`} />
      <div className="sm:col-span-6 flex items-center gap-3">
        <button type="submit" disabled={pending} className="rounded-lg bg-ink-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
          {pending ? (ar ? "بيتحفظ…" : "Saving…") : ar ? "احفظ" : "Save"}
        </button>
        {state.error && <span className="text-xs text-bad">{state.error}</span>}
        {state.success && <span className="text-xs text-good">{state.success}</span>}
      </div>
    </form>
  );
}
