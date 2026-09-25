"use client";

import { useActionState, useMemo, useState } from "react";
import { RequestIdField } from "@/components/request-id";
import { CustomerPicker } from "@/components/customer-picker";
import { takeOrderToMakeAction } from "./actions";
import type { FormState } from "@/components/entity-form";

const empty: FormState = {};
const field =
  "w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep";

export type MakeableVariant = {
  variantId: string;
  styleId: string;
  sku: string;
  label: string;
  retailPrice: string;
  /** On the shelf now. Zero is why this piece is on this form. */
  available: number;
  /** Whole garments the cloth on hand supports. */
  makeable: number;
  hasBom: boolean;
  hasOperations: boolean;
  /** The material that runs out first, for the sentence that names it. */
  limitedBy: { code: string; nameAr: string; nameEn: string; onHand: string; perUnit: string; uom: string } | null;
};

/**
 * Turning a message into something the factory will actually make.
 *
 * The verdict is shown before the order is priced, not after it is submitted.
 * Whoever is typing is in a conversation with a customer who is waiting, and
 * the one thing they need is the answer to "when" — which begins with whether
 * the cloth exists. Finding that out by pressing submit is finding it out too
 * late, in front of the customer.
 *
 * The run is offered, not assumed. A shop that wants the promise on the books
 * and the cut decided by the factory in the morning is doing something
 * reasonable, and the form should not argue with it.
 */
export function MakeToOrderForm({
  ar,
  entityId,
  customers,
  variants,
  locations,
  mayPlan,
}: {
  ar: boolean;
  entityId: string;
  customers: { id: string; name: string; phone: string | null }[];
  variants: MakeableVariant[];
  locations: { id: string; name: string }[];
  /** Whether this person may commit the factory, not merely promise a customer. */
  mayPlan: boolean;
}) {
  const [state, action, pending] = useActionState(takeOrderToMakeAction, empty);
  const [customerId, setCustomerId] = useState("");
  const [variantId, setVariantId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [price, setPrice] = useState("");
  const [deposit, setDeposit] = useState("");

  const today = new Date().toISOString().slice(0, 10);
  const inTwoWeeks = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);

  const byId = useMemo(() => new Map(variants.map((v) => [v.variantId, v])), [variants]);
  const chosen = variantId ? byId.get(variantId) : undefined;

  const qty = Number(quantity || 0);
  const total = (Number(price || 0) * qty) || 0;
  const held = Number(deposit || 0);
  const uncovered = Math.max(0, total - held);

  const enough = chosen ? chosen.makeable >= qty && qty > 0 : false;
  const blocked = chosen && (!chosen.hasBom || !chosen.hasOperations);

  const onPick = (id: string) => {
    setVariantId(id);
    const v = byId.get(id);
    if (v && !price) setPrice(v.retailPrice);
  };

  return (
    <form action={action} className="space-y-4">
      <RequestIdField state={state} />
      <input type="hidden" name="entityId" value={entityId} />
      <input type="hidden" name="orderDate" value={today} />

      <div className="grid gap-3 lg:grid-cols-3">
        <label className="text-sm lg:col-span-2">
          <span className="mb-1 block text-ink-600">{ar ? "المطلوب" : "What they asked for"}</span>
          <select
            name="variantId"
            required
            value={variantId}
            onChange={(e) => onPick(e.target.value)}
            className={field}
          >
            <option value="">{ar ? "اختار القطعة…" : "Pick the piece…"}</option>
            {variants.map((v) => (
              <option key={v.variantId} value={v.variantId}>
                {v.sku} · {v.label}
                {v.makeable > 0
                  ? ar ? ` — القماش يكفي ${v.makeable}` : ` — cloth makes ${v.makeable}`
                  : ar ? " — مفيش قماش" : " — no cloth"}
              </option>
            ))}
          </select>
        </label>

        <div className="text-sm">
          <span className="mb-1 block text-ink-600">{ar ? "الزبون" : "Customer"}</span>
          {/* A moderator knows the number from the chat and nothing else, and
              the person is usually not on file yet — the order is the first
              thing they ever bought. */}
          <CustomerPicker
            ar={ar}
            people={customers}
            value={customerId}
            onChange={(id) => setCustomerId(id)}
            name="customerId"
            required
          />
        </div>
      </div>

      {/* ------------------------------------------------- the fabric verdict */}
      {chosen && (
        <div
          className={`rounded-lg px-3 py-2.5 text-sm ${
            blocked
              ? "bg-warn/10 text-warn"
              : enough
                ? "bg-good/10 text-good"
                : "bg-bad/10 text-bad"
          }`}
        >
          {blocked ? (
            <span>
              {!chosen.hasBom
                ? ar
                  ? "الموديل ده مالوش مكونات في النظام، فمينفعش يتعمله أمر إنتاج. سجّل الأوردر واظبط المكونات الأول."
                  : "This style has no bill of materials, so no run can be raised. Take the order and set the bill up first."
                : ar
                  ? "الموديل ده مالوش عمليات، يعني مفيش وقت تصنيع محسوب، فمينفعش يتعمله أمر إنتاج."
                  : "This style has no operations, so it has no SMV and no run can be raised."}
            </span>
          ) : enough ? (
            <span>
              {ar
                ? `القماش الموجود يكفي ${chosen.makeable} قطعة — يعني ${qty} تمام.`
                : `The cloth on hand makes ${chosen.makeable} — so ${qty} is fine.`}
            </span>
          ) : (
            <span>
              {ar
                ? `القماش الموجود يكفي ${chosen.makeable} قطعة بس، وانت طالب ${qty}.`
                : `The cloth on hand makes only ${chosen.makeable}, and you are asking for ${qty}.`}
              {chosen.limitedBy && (
                <>
                  {" "}
                  {ar
                    ? `اللي بيخلص الأول: ${chosen.limitedBy.nameAr} (${chosen.limitedBy.code}) — فيه ${chosen.limitedBy.onHand} ${chosen.limitedBy.uom}، والقطعة بتاخد ${chosen.limitedBy.perUnit}.`
                    : `${chosen.limitedBy.nameEn} (${chosen.limitedBy.code}) runs out first — ${chosen.limitedBy.onHand} ${chosen.limitedBy.uom} on hand, ${chosen.limitedBy.perUnit} a garment.`}
                </>
              )}
              {" "}
              {ar
                ? "تقدر تسجّل الأوردر برضه، بس من غير أمر إنتاج لحد ما القماش يتشترى."
                : "You can still take the order, but no run until the cloth is bought."}
            </span>
          )}
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-4">
        <label className="text-sm">
          <span className="mb-1 block text-ink-600">{ar ? "العدد" : "Quantity"}</span>
          <input
            name="quantity" type="number" min={1} required
            value={quantity} onChange={(e) => setQuantity(e.target.value)}
            className={field} dir="ltr"
          />
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-ink-600">{ar ? "سعر القطعة" : "Price each"}</span>
          <input
            name="agreedUnitPrice" type="number" step="0.01" min={0} required
            value={price} onChange={(e) => setPrice(e.target.value)}
            className={field} dir="ltr"
          />
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-ink-600">{ar ? "عربون" : "Deposit"}</span>
          <input
            name="depositAmount" type="number" step="0.01" min={0}
            value={deposit} onChange={(e) => setDeposit(e.target.value)}
            className={field} dir="ltr" placeholder="0"
          />
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-ink-600">{ar ? "العربون اتدفع إزاي" : "Deposit by"}</span>
          <select name="depositMethod" className={field} defaultValue="CASH">
            <option value="CASH">{ar ? "كاش" : "Cash"}</option>
            <option value="CARD">{ar ? "فيزا" : "Card"}</option>
            <option value="INSTAPAY">InstaPay</option>
            <option value="BANK_TRANSFER">{ar ? "تحويل بنكي" : "Bank transfer"}</option>
          </select>
        </label>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <label className="text-sm">
          <span className="mb-1 block text-ink-600">{ar ? "هيستلمها منين" : "Collected from"}</span>
          <select name="locationId" required className={field}>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-ink-600">{ar ? "موعد التسليم" : "Promised for"}</span>
          <input
            name="promisedDate" type="date" min={today} defaultValue={inTwoWeeks}
            className={field} dir="ltr"
          />
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-ink-600">{ar ? "ملاحظات" : "Notes"}</span>
          <input
            name="notes" className={field}
            placeholder={ar ? "مقاس خاص، لون، أي كلام اتقال" : "Alterations, colour, anything agreed"}
          />
        </label>
      </div>

      {total > 0 && (
        <p className="text-xs text-ink-600">
          {ar ? "الإجمالي" : "Total"} <span className="num">{total.toFixed(2)}</span>
          {" · "}
          {held > 0 ? (
            <>
              {ar ? "عربون" : "deposit"} <span className="num">{held.toFixed(2)}</span>
              {" · "}
              {ar ? "الباقي عند الاستلام" : "on collection"}{" "}
              <span className="num">{uncovered.toFixed(2)}</span>
            </>
          ) : (
            <span className="text-warn">
              {ar
                ? "من غير عربون — لو العميل مجاش، القطعة دي محدش تاني طالبها."
                : "No deposit — if they do not come back, nobody else asked for this piece."}
            </span>
          )}
        </p>
      )}

      {mayPlan ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox" name="raiseRun"
            defaultChecked
            disabled={!enough || !!blocked}
            className="h-4 w-4"
          />
          <span className={!enough || blocked ? "text-ink-400" : ""}>
            {ar
              ? "اعمل أمر إنتاج في المصنع على طول"
              : "Raise the production run at the factory now"}
          </span>
        </label>
      ) : (
        <p className="text-xs text-ink-500">
          {ar
            ? "الأوردر هيتسجّل كوعد. أمر الإنتاج بيعمله حد من الإنتاج."
            : "The order is recorded as a promise. Somebody in production raises the run."}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending
            ? ar ? "بنسجّل…" : "Taking…"
            : ar ? "سجّل الأوردر" : "Take the order"}
        </button>
        {state.error && <span className="text-sm text-bad">{state.error}</span>}
        {state.success && <span className="text-sm text-good">{state.success}</span>}
      </div>
    </form>
  );
}
