"use client";

import { useActionState, useState } from "react";
import {
  sellConsignedAction,
  returnConsignmentAction,
  type ConsignmentState,
} from "./actions";

const empty: ConsignmentState = {};
const small =
  "w-full rounded-lg border border-ink-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-ink-500";

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
  mayReturn,
}: {
  ar: boolean;
  item: {
    id: string;
    description: string;
    retailPrice: string;
    left: number;
    commissionPct: string;
  };
  customers: { id: string; name: string; phone: string | null }[];
  maySell: boolean;
  mayReturn: boolean;
}) {
  const [panel, setPanel] = useState<null | "sell" | "return">(null);
  const [sellState, sell, selling] = useActionState(sellConsignedAction, empty);
  const [returnState, giveBack, returning] = useActionState(returnConsignmentAction, empty);
  const [price, setPrice] = useState(item.retailPrice);
  const [quantity, setQuantity] = useState("1");

  const today = new Date().toISOString().slice(0, 10);
  const total = Number(price || 0) * Number(quantity || 0);
  const commission = (total * Number(item.commissionPct)) / 100;
  const owner = total - commission;

  if (panel === "sell") {
    return (
      <form action={sell} className="min-w-[15rem] space-y-2">
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

        <select name="customerId" className={small}>
          <option value="">{ar ? "بدون عميل" : "No customer"}</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        <p className="rounded-lg bg-ink-100 px-2 py-1.5 text-[11px]">
          {ar ? "إجمالي" : "Total"} <span className="num">{total.toFixed(2)}</span>
          {" · "}
          <span className="text-good">
            {ar ? "ليك" : "yours"} <span className="num">{commission.toFixed(2)}</span>
          </span>
          {" · "}
          <span className="text-warn">
            {ar ? "لصاحبها" : "theirs"} <span className="num">{owner.toFixed(2)}</span>
          </span>
        </p>

        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={selling}
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
