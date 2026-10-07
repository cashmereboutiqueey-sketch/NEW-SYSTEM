"use client";
import { cairoDateKey } from "@/lib/cairo-date";

import { useActionState, useState } from "react";
import { RequestIdField } from "@/components/request-id";
import {
  sellConsignedAction,
  returnConsignmentAction,
  type ConsignmentState,
} from "./actions";

const empty: ConsignmentState = {};
const small =
  "w-full rounded-lg border border-ink-200 bg-panel px-2 py-1.5 text-sm outline-none focus:border-rose-deep";

/**
 * Selling one, or giving it back.
 *
 * The split is shown before the sale is taken, because the number that
 * surprises people is not the price — it is how little of it is theirs.
 */
export function ItemActions({
  ar,
  item,
  customers,
  maySell,
  mayGiveCredit,
  mayReturn,
  seeValue,
}: {
  ar: boolean;
  item: {
    id: string;
    description: string;
    retailPrice: string;
    left: number;
    commissionPct: string | null;
  };
  customers: { id: string; name: string; phone: string | null }[];
  maySell: boolean;
  mayGiveCredit: boolean;
  mayReturn: boolean;
  /** Whether the split behind the sale may be shown, or only its total. */
  seeValue: boolean;
}) {
  const [panel, setPanel] = useState<null | "sell" | "return">(null);
  const [sellState, sell, selling] = useActionState(sellConsignedAction, empty);
  const [returnState, giveBack, returning] = useActionState(returnConsignmentAction, empty);
  const [price, setPrice] = useState(item.retailPrice);
  const [quantity, setQuantity] = useState("1");
  const [paidNow, setPaidNow] = useState("");
  const [partPayment, setPartPayment] = useState(false);
  const [customerId, setCustomerId] = useState("");

  const today = cairoDateKey();
  const total = Number(price || 0) * Number(quantity || 0);
  const commission = (total * Number(item.commissionPct)) / 100;
  const owner = total - commission;

  if (panel === "sell") {
    return (
      <form action={sell} className="min-w-[15rem] space-y-2">
        <RequestIdField state={sellState} />
        <input type="hidden" name="itemId" value={item.id} />
        <input type="hidden" name="saleDate" value={today} />

        <div className="grid grid-cols-2 gap-2">
          <input
            name="quantity"
            type="number"
            min="1"
            max={item.left}
            required
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            dir="ltr"
            className={`${small} text-end`}
          />
          <input
            name="soldPrice"
            type="number"
            min="0"
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            dir="ltr"
            className={`${small} text-end`}
          />
        </div>

        <select name="paymentMethod" className={small}>
          <option value="CASH">{ar ? "كاش" : "Cash"}</option>
          <option value="CARD">{ar ? "فيزا" : "Card"}</option>
          <option value="INSTAPAY">{ar ? "إنستاباي" : "InstaPay"}</option>
          <option value="BANK_TRANSFER">{ar ? "تحويل" : "Transfer"}</option>
        </select>

        <select name="customerId" value={customerId} onChange={(e) => setCustomerId(e.target.value)} className={small}>
          <option value="">{ar ? "بدون عميل" : "No customer"}</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        {mayGiveCredit && (
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={partPayment} onChange={(e) => setPartPayment(e.target.checked)} />
            {ar ? "العربون دلوقتي والباقي على العميل" : "Deposit now, balance on customer"}
          </label>
        )}
        {partPayment && (
          <div className="space-y-1">
            <input name="paidNow" type="number" min="0.01" max={total} step="0.01" required
              value={paidNow} onChange={(e) => setPaidNow(e.target.value)}
              placeholder={ar ? "المدفوع الآن" : "Paid now"} dir="ltr" className={small} />
            <p className="text-xs text-ink-500">
              {ar ? "الباقي عليه" : "Still owed"}: {Math.max(0, total - Number(paidNow || 0)).toFixed(2)}
            </p>
            {!customerId && <p className="text-xs text-bad">{ar ? "اختار العميل الأول" : "Choose a customer"}</p>}
          </div>
        )}

        <p className="rounded-lg bg-ink-100 px-2 py-1.5 text-[11px]">
          {ar ? "إجمالي" : "Total"} <span className="num">{total.toFixed(2)}</span>
          {seeValue && (
            <>
              {" · "}
              <span className="text-good">
                {ar ? "ليك" : "yours"} <span className="num">{commission.toFixed(2)}</span>
              </span>
              {" · "}
              <span className="text-warn">
                {ar ? "لصاحبها" : "theirs"} <span className="num">{owner.toFixed(2)}</span>
              </span>
            </>
          )}
        </p>

        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={selling || (partPayment && (!customerId || !paidNow))}
            className="rounded-lg bg-ink-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {selling ? "…" : ar ? "بيع" : "Sell"}
          </button>
          <button type="button" onClick={() => setPanel(null)} className="text-xs text-ink-500">
            {ar ? "رجوع" : "Back"}
          </button>
        </div>

        {sellState.error && <p className="text-xs text-bad">{sellState.error}</p>}
        {sellState.success && <p className="text-xs text-good">{sellState.success}</p>}
      </form>
    );
  }

  if (panel === "return") {
    return (
      <form action={giveBack} className="min-w-[13rem] space-y-2">
        <input type="hidden" name="itemId" value={item.id} />
        <input
          name="quantity"
          type="number"
          min="1"
          max={item.left}
          required
          defaultValue={item.left}
          dir="ltr"
          className={`${small} text-end`}
        />
        <input
          name="reason"
          placeholder={ar ? "السبب (اختياري)" : "Reason (optional)"}
          className={small}
        />
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={returning}
            className="rounded-lg border border-ink-300 px-3 py-1.5 text-xs text-ink-700 disabled:opacity-50"
          >
            {returning ? "…" : ar ? "رجّعها لصاحبها" : "Give back"}
          </button>
          <button type="button" onClick={() => setPanel(null)} className="text-xs text-ink-500">
            {ar ? "رجوع" : "Back"}
          </button>
        </div>
        {returnState.error && <p className="text-xs text-bad">{returnState.error}</p>}
      </form>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {maySell && (
        <button
          type="button"
          onClick={() => setPanel("sell")}
          className="rounded-lg bg-ink-900 px-2.5 py-1 text-xs font-medium text-white"
        >
          {ar ? "بيع" : "Sell"}
        </button>
      )}
      {mayReturn && (
        <button
          type="button"
          onClick={() => setPanel("return")}
          className="text-xs text-ink-500 underline"
        >
          {ar ? "رجّعها" : "Give back"}
        </button>
      )}
    </div>
  );
}
