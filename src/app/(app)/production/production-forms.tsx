"use client";

import { useActionState, useState } from "react";
import {
  createProductionOrderAction,
  confirmProductionOrderAction,
  issueForOrderAction,
  completeProductionOrderAction,
} from "./actions";
import type { FormState } from "@/components/entity-form";
import { RequestIdField } from "@/components/request-id";
import type { Locale } from "@/lib/i18n";

const initial: FormState = {};
const field =
  "rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm text-ink-900 " +
  "focus:border-rose-deep focus:outline-none focus:ring-1 focus:ring-rose";
const label = "mb-1 block text-xs font-medium text-ink-600";
const button =
  "rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40";

function Result({ state }: { state: FormState }) {
  return (
    <>
      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      {state.success && <p className="text-sm text-good">{state.success}</p>}
    </>
  );
}

/* ------------------------------------------------------------------ raise */

export function NewOrderForm({
  locale,
  styles,
  today,
}: {
  locale: Locale;
  styles: { id: string; code: string; name: string; smv: string; hasBom: boolean }[];
  today: string;
}) {
  const [state, formAction, pending] = useActionState(createProductionOrderAction, initial);
  const [styleId, setStyleId] = useState(styles[0]?.id ?? "");
  const ar = locale === "ar";

  const style = styles.find((s) => s.id === styleId);

  return (
    <form action={formAction} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <label className={label} htmlFor="styleId">{ar ? "الموديل" : "Style"}</label>
          <select
            id="styleId" name="styleId" required value={styleId}
            onChange={(e) => setStyleId(e.target.value)}
            className={`${field} w-full`}
          >
            {styles.map((s) => (
              <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="plannedQty">{ar ? "الكمية" : "Quantity"}</label>
          <input
            id="plannedQty" name="plannedQty" type="number" step="1" min="1" required
            dir="ltr" className={`${field} num w-full`}
          />
        </div>
        <div>
          <label className={label} htmlFor="orderDate">{ar ? "تاريخ الأمر" : "Order date"}</label>
          <input
            id="orderDate" name="orderDate" type="date" required defaultValue={today}
            dir="ltr" className={`${field} w-full`}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className={label} htmlFor="plannedStart">{ar ? "بداية مخططة" : "Planned start"}</label>
          <input id="plannedStart" name="plannedStart" type="date" dir="ltr" className={`${field} w-full`} />
        </div>
        <div>
          <label className={label} htmlFor="plannedFinish">{ar ? "نهاية مخططة" : "Planned finish"}</label>
          <input id="plannedFinish" name="plannedFinish" type="date" dir="ltr" className={`${field} w-full`} />
        </div>
        <div>
          <label className={label} htmlFor="notes">{ar ? "ملاحظات" : "Notes"}</label>
          <input id="notes" name="notes" type="text" className={`${field} w-full`} />
        </div>
      </div>

      {style && !style.hasBom && (
        <p className="text-sm text-bad">
          {ar
            ? "الموديل ده لسه مالوش مكونات. ضيف الخامات والعمليات من صفحة الموديلات الأول."
            : "This style has no bill of materials yet. Add its materials and operations from the styles page first."}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending || (style && !style.hasBom)} className={button}>
          {pending ? (ar ? "جارٍ…" : "Working…") : ar ? "افتح أمر إنتاج" : "Raise the order"}
        </button>
        {style && (
          <span className="text-xs text-ink-400">
            {ar ? "دقائق الموديل" : "SMV"} <span className="num">{style.smv}</span>
          </span>
        )}
      </div>

      <Result state={state} />
    </form>
  );
}

/* ---------------------------------------------------------------- confirm */

export function ConfirmOrderForm({
  locale,
  productionOrderId,
  periods,
}: {
  locale: Locale;
  productionOrderId: string;
  periods: { id: string; label: string; rate: string }[];
}) {
  const [state, formAction, pending] = useActionState(confirmProductionOrderAction, initial);
  const ar = locale === "ar";

  if (periods.length === 0) {
    return (
      <p className="text-sm text-bad">
        {ar
          ? "محتاج تحسب تكلفة الدقيقة لشهر واحد على الأقل قبل ما تأكّد الأمر."
          : "A minute rate has to be calculated for at least one month before an order can be confirmed."}
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="productionOrderId" value={productionOrderId} />
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className={label} htmlFor={`mr-${productionOrderId}`}>
            {ar ? "شهر تكلفة الدقيقة" : "Minute-rate period"}
          </label>
          <select
            id={`mr-${productionOrderId}`} name="minuteRatePeriodId" required
            className={`${field} min-w-56`}
          >
            {periods.map((p) => (
              <option key={p.id} value={p.id}>{p.label} — {p.rate}</option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={pending} className={button}>
          {pending ? (ar ? "جارٍ…" : "Working…") : ar ? "أكّد وجمّد التكلفة" : "Confirm and freeze the cost"}
        </button>
      </div>
      <p className="text-xs text-ink-500">
        {ar
          ? "التأكيد بيجمّد تكلفة الوحدة على سعر الشهر ده. مش هتتغير بعد كده مهما اتغيرت الأسعار."
          : "Confirming freezes the unit cost at this month's rate. It will not move again, whatever prices do later."}
      </p>
      <Result state={state} />
    </form>
  );
}

/* ------------------------------------------------------------------ issue */

export function IssueMaterialForm({
  locale,
  productionOrderId,
  entityId,
  today,
  locations,
  materials,
}: {
  locale: Locale;
  productionOrderId: string;
  entityId: string;
  today: string;
  locations: { id: string; label: string }[];
  materials: {
    id: string; code: string; name: string; uom: string;
    /** What the BOM says this run needs, waste included. */
    planned: string;
    /** Already issued against this order. */
    issued: string;
    onHand: string;
  }[];
}) {
  const [state, formAction, pending] = useActionState(issueForOrderAction, initial);
  const [materialId, setMaterialId] = useState(materials[0]?.id ?? "");
  const ar = locale === "ar";

  const m = materials.find((x) => x.id === materialId);
  const outstanding = m ? Number(m.planned) - Number(m.issued) : 0;
  const short = m != null && outstanding > Number(m.onHand);

  return (
    <form action={formAction} className="space-y-3">
      <RequestIdField state={state} />
      <input type="hidden" name="productionOrderId" value={productionOrderId} />
      <input type="hidden" name="entityId" value={entityId} />

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className={label} htmlFor={`mat-${productionOrderId}`}>
            {ar ? "الخامة" : "Material"}
          </label>
          <select
            id={`mat-${productionOrderId}`} name="materialId" required value={materialId}
            onChange={(e) => setMaterialId(e.target.value)}
            className={`${field} min-w-56`}
          >
            {materials.map((x) => (
              <option key={x.id} value={x.id}>{x.code} — {x.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor={`q-${productionOrderId}`}>
            {ar ? "الكمية" : "Quantity"}
          </label>
          <input
            id={`q-${productionOrderId}`} name="quantity" type="number" step="0.01" min="0.01"
            required
            // Defaults to what is still owed to the order rather than the
            // whole plan, so issuing twice does not silently double-cut.
            defaultValue={outstanding > 0 ? outstanding.toFixed(2) : ""}
            key={materialId}
            dir="ltr" className={`${field} num w-32`}
          />
          {m && (
            <p className="mt-1 text-xs text-ink-400">
              {ar ? "المطلوب" : "needs"} <span className="num">{m.planned}</span> {m.uom}
              {Number(m.issued) > 0 && (
                <> · {ar ? "اتصرف" : "issued"} <span className="num">{m.issued}</span></>
              )}
              {" · "}
              {ar ? "بالمخزن" : "on hand"} <span className="num">{m.onHand}</span>
            </p>
          )}
        </div>
        <div>
          <label className={label} htmlFor={`pc-${productionOrderId}`}>
            {ar ? "قطع مقصوصة" : "Pieces cut"}
          </label>
          <input
            id={`pc-${productionOrderId}`} name="piecesCut" type="number" step="1" min="0"
            dir="ltr" className={`${field} num w-28`}
          />
        </div>
        <div>
          <label className={label} htmlFor={`loc-${productionOrderId}`}>
            {ar ? "من مخزن" : "From"}
          </label>
          <select id={`loc-${productionOrderId}`} name="locationId" required className={`${field} min-w-44`}>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </div>
        <div>
          <label className={label} htmlFor={`id-${productionOrderId}`}>
            {ar ? "التاريخ" : "Date"}
          </label>
          <input
            id={`id-${productionOrderId}`} name="issueDate" type="date" required
            defaultValue={today} dir="ltr" className={field}
          />
        </div>
        <button type="submit" disabled={pending} className={button}>
          {pending ? (ar ? "جارٍ…" : "Working…") : ar ? "اصرف للإنتاج" : "Issue to the floor"}
        </button>
      </div>

      {short && m && (
        <p className="text-sm text-warn">
          {ar
            ? `المخزن فيه ${m.onHand} ${m.uom} بس، والأمر محتاج ${outstanding.toFixed(2)}.`
            : `Only ${m.onHand} ${m.uom} on hand, and this order still needs ${outstanding.toFixed(2)}.`}
        </p>
      )}

      <Result state={state} />
    </form>
  );
}

/* --------------------------------------------------------------- complete */

type Output = { variantId: string; goodQty: number };

/**
 * Receiving a run's output, and closing it.
 *
 * The output is entered as a size curve because that is how a run actually
 * comes off the line — thirty black mediums, twelve cream extra-larges. Every
 * garment costs the same whatever its size, so this decides how the output is
 * labelled and counted, never what it cost.
 *
 * A run can deliver in parts: with "close the run" unticked the garments go
 * into stock and the order stays open for the rest.
 *
 * Material still owed to the garments being received is issued from here, in
 * the same command as the receipt. Issuing used to be a separate form above
 * this one, and a run received without it was refused with "not enough
 * material was issued" — correct, and a dead end for anyone who cuts first
 * and records afterwards, which on a small floor is everyone. The quantity
 * offered is what the frozen standard needs; it can be changed to what was
 * really used, and a real shortfall still needs its reason.
 */
export function CompleteOrderForm({
  locale,
  productionOrderId,
  entityId,
  plannedQty,
  goodSoFar,
  rejectedSoFar,
  materials,
  canApproveShortfall,
  today,
  locations,
  variants,
}: {
  locale: Locale;
  productionOrderId: string;
  entityId: string;
  plannedQty: number;
  /** Good garments already received on earlier deliveries. */
  goodSoFar: number;
  /** Rejects already recorded on earlier deliveries; they consumed fabric too. */
  rejectedSoFar: number;
  materials: {
    id: string; code: string; name: string; uom: string;
    /** Waste-free standard per garment, from the run's frozen bill. */
    perGarment: string;
    issued: string;
    onHand: string;
  }[];
  /** Whether this person may let a run through on less material than it made. */
  canApproveShortfall: boolean;
  today: string;
  locations: { id: string; label: string }[];
  variants: { id: string; sku: string; label: string }[];
}) {
  const [state, formAction, pending] = useActionState(completeProductionOrderAction, initial);
  const [outputs, setOutputs] = useState<Output[]>([]);
  const [close, setClose] = useState(true);
  const [rejected, setRejected] = useState(0);
  // Only what the person typed; everything else follows the output as it changes.
  const [edited, setEdited] = useState<Record<string, string>>({});
  const ar = locale === "ar";

  const setQty = (variantId: string, goodQty: number) =>
    setOutputs((prev) => {
      const rest = prev.filter((o) => o.variantId !== variantId);
      return goodQty > 0 ? [...rest, { variantId, goodQty }] : rest;
    });

  const good = outputs.reduce((s, o) => s + o.goodQty, 0);
  const qtyOf = (variantId: string) =>
    outputs.find((o) => o.variantId === variantId)?.goodQty ?? "";

  // Everything the run will have made once this receipt is in, rejects
  // included — the same count the server checks issued material against.
  const made = goodSoFar + good + rejectedSoFar + rejected;
  const lines = materials.map((m) => {
    const needed = Number(m.perGarment) * made;
    // Rounded up to the hundredth, so the offer is never a hair short of what
    // the check requires.
    const missing = Math.max(0, Math.ceil((needed - Number(m.issued)) * 100 - 1e-6) / 100);
    const value = edited[m.id] ?? (missing > 0 ? missing.toFixed(2) : "");
    return { ...m, needed, missing, value };
  });
  const toIssue = lines
    .filter((l) => Number(l.value) > 0)
    .map((l) => ({ materialId: l.id, quantity: l.value }));

  return (
    <form action={formAction} className="space-y-3">
      <RequestIdField state={state} />
      <input type="hidden" name="productionOrderId" value={productionOrderId} />
      <input type="hidden" name="entityId" value={entityId} />
      <input type="hidden" name="outputs" value={JSON.stringify(outputs)} />
      <input type="hidden" name="issueNow" value={JSON.stringify(toIssue)} />

      <div>
        <p className={label}>{ar ? "الخارج من الخط، لكل مقاس" : "Off the line, by SKU"}</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {variants.map((v) => (
            <label
              key={v.id}
              className="flex items-center gap-2 rounded-lg border border-ink-200 px-3 py-2"
            >
              <span className="flex-1 text-sm">
                <code dir="ltr" className="text-xs text-ink-500">{v.sku}</code>
                <span className="ms-2 text-ink-600">{v.label}</span>
              </span>
              <input
                type="number" step="1" min="0" value={qtyOf(v.id)}
                onChange={(e) => setQty(v.id, Number(e.target.value))}
                dir="ltr" className={`${field} num w-20`}
              />
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className={label} htmlFor={`rej-${productionOrderId}`}>
            {ar ? "مرفوض" : "Rejected"}
          </label>
          <input
            id={`rej-${productionOrderId}`} name="rejectedQty" type="number" step="1" min="0"
            value={rejected}
            onChange={(e) => setRejected(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            dir="ltr" className={`${field} num w-24`}
          />
        </div>
        <div>
          <label className={label} htmlFor={`min-${productionOrderId}`}>
            {ar ? "دقائق فعلية" : "Actual minutes"}
          </label>
          <input
            id={`min-${productionOrderId}`} name="actualTotalMinutes" type="number" step="0.01" min="0"
            placeholder={ar ? "اختياري" : "optional"}
            dir="ltr" className={`${field} num w-32`}
          />
        </div>
        <div>
          <label className={label} htmlFor={`cl-${productionOrderId}`}>
            {ar ? "إلى مخزن" : "Into"}
          </label>
          <select id={`cl-${productionOrderId}`} name="locationId" required className={`${field} min-w-44`}>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </div>
        <div>
          <label className={label} htmlFor={`cd-${productionOrderId}`}>
            {ar ? "التاريخ" : "Date"}
          </label>
          <input
            id={`cd-${productionOrderId}`} name="completedDate" type="date" required
            defaultValue={today} dir="ltr" className={field}
          />
        </div>

        <label className="flex items-center gap-2 self-center text-sm">
          <input
            type="checkbox" name="close" checked={close}
            onChange={(e) => setClose(e.target.checked)}
            className="h-4 w-4 rounded border-ink-300"
          />
          <span>{ar ? "اقفل الأمر بعد الاستلام ده" : "Close the run after this"}</span>
        </label>

        <div className="ms-auto text-end">
          <p className="text-xs text-ink-500">{ar ? "إجمالي سليم" : "Good total"}</p>
          <p className="num text-lg font-semibold">
            {good}
            {goodSoFar > 0 && (
              <span className="ms-1 text-xs font-normal text-ink-500">
                {ar ? `+ ${goodSoFar} قبل كده` : `+ ${goodSoFar} earlier`}
              </span>
            )}
          </p>
        </div>

        <button
          type="submit"
          disabled={pending || (good === 0 && !(close && goodSoFar > 0))}
          className={button}
        >
          {pending
            ? (ar ? "جارٍ…" : "Working…")
            : close
              ? (ar ? "اقفل الأمر" : "Close the run")
              : (ar ? "استلم في المخزن" : "Receive into stock")}
        </button>
      </div>

      {made > 0 && lines.some((l) => l.needed > 0) && (
        <div className="rounded-lg border border-ink-200 p-3">
          <p className={label}>
            {ar ? "الخامات للقطع دي — بتتصرف مع الاستلام" : "Material for these garments — issued with the receipt"}
          </p>
          <div className="space-y-2">
            {lines.map((l) => (
              <div key={l.id} className="flex flex-wrap items-center gap-3 text-sm">
                <span className="min-w-40">
                  <code dir="ltr" className="text-xs text-ink-500">{l.code}</code>
                  <span className="ms-2 text-ink-600">{l.name}</span>
                </span>
                <span className="text-xs text-ink-500">
                  {ar ? "اتصرف" : "issued"} <span className="num">{l.issued}</span>
                  {" / "}
                  {ar ? "المعيار" : "standard"} <span className="num">{l.needed.toFixed(2)}</span> {l.uom}
                </span>
                <label className="flex items-center gap-2">
                  <span className="text-xs text-ink-600">{ar ? "اصرف دلوقتي" : "Issue now"}</span>
                  <input
                    type="number" step="0.01" min="0" value={l.value}
                    onChange={(e) => setEdited((prev) => ({ ...prev, [l.id]: e.target.value }))}
                    dir="ltr" className={`${field} num w-28`}
                  />
                </label>
                {Number(l.value) > Number(l.onHand) && (
                  <span className="text-xs text-warn">
                    {ar ? `المخزن فيه ${l.onHand} بس` : `only ${l.onHand} on hand`}
                  </span>
                )}
              </div>
            ))}
          </div>
          {toIssue.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <label className="text-xs text-ink-600" htmlFor={`il-${productionOrderId}`}>
                {ar ? "من مخزن" : "From"}
              </label>
              <select id={`il-${productionOrderId}`} name="issueLocationId" className={`${field} min-w-44`}>
                {locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.label}</option>)}
              </select>
              <p className="text-xs text-ink-500">
                {ar
                  ? "الصرف والاستلام بيتموا مع بعض، أو مايتمش ولا واحد. لو القماش الفعلي كان أقل، اكتب الرقم الحقيقي."
                  : "Issue and receipt happen together or not at all. If less was really used, enter the real figure."}
              </p>
            </div>
          )}
        </div>
      )}

      {canApproveShortfall && (
        <div>
          <label className={label} htmlFor={`sf-${productionOrderId}`}>
            {ar ? "سبب القماش الناقص (لو فيه)" : "Why less material was issued (if it was)"}
          </label>
          <input
            id={`sf-${productionOrderId}`} name="shortfallReason" type="text"
            placeholder={
              ar
                ? "سيبها فاضية إلا لو السيستم رفض الاستلام بسبب نقص خامات"
                : "Leave blank unless the receipt was refused for missing material"
            }
            className={`${field} w-full`}
          />
        </div>
      )}

      {close && good + goodSoFar > 0 && good + goodSoFar !== plannedQty && (
        <p className="text-sm text-ink-500">
          {ar
            ? `الأمر كان لـ ${plannedQty} وخرج ${good + goodSoFar}. الفرق بيتسجّل كما هو.`
            : `The order was for ${plannedQty} and ${good + goodSoFar} came off. The difference is recorded as it stands.`}
        </p>
      )}

      <Result state={state} />
    </form>
  );
}
