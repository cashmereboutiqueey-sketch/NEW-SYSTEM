"use client";

import { useActionState, useState } from "react";
import {
  addDepositAction,
  linkRunAction,
  markReadyAction,
  deliverAction,
  cancelAction,
  type CustomOrderState,
} from "./actions";

const empty: CustomOrderState = {};
const small =
  "w-full rounded-lg border border-ink-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-ink-500";

type Panel = null | "deposit" | "run" | "deliver" | "cancel";

/**
 * What can be done to one order, given where it has got to.
 *
 * Only the moves that make sense are offered: a piece cannot be handed over
 * before it is made, and a run cannot be attached to something already
 * cancelled. Showing a button that will only produce an error is how people
 * learn to ignore errors.
 */
export function OrderActions({
  ar,
  order,
  channelId,
  runs,
  mayHandleMoney,
  mayPlan,
  mayDeliver,
}: {
  ar: boolean;
  order: { id: string; status: string; atRisk: string; deposit: string };
  channelId: string;
  runs: { id: string; label: string }[];
  mayHandleMoney: boolean;
  mayPlan: boolean;
  mayDeliver: boolean;
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const [depositState, depositAction, depositPending] = useActionState(addDepositAction, empty);
  const [runState, runAction, runPending] = useActionState(linkRunAction, empty);
  const [readyState, readyAction, readyPending] = useActionState(markReadyAction, empty);
  const [deliverState, deliverActionFn, deliverPending] = useActionState(deliverAction, empty);
  const [cancelState, cancelActionFn, cancelPending] = useActionState(cancelAction, empty);

  const today = new Date().toISOString().slice(0, 10);
  const owing = Number(order.atRisk);

  const message =
    depositState.error ?? runState.error ?? readyState.error ??
    deliverState.error ?? cancelState.error;
  const done =
    depositState.success ?? runState.success ?? readyState.success ??
    deliverState.success ?? cancelState.success;

  if (panel === "deposit") {
    return (
      <form action={depositAction} className="min-w-[15rem] space-y-2">
        <input type="hidden" name="customOrderId" value={order.id} />
        <input type="hidden" name="paidOn" value={today} />
        <input
          name="amount" type="number" step="0.01" min="0" max={owing} required dir="ltr"
          placeholder={ar ? `لحد ${owing.toFixed(2)}` : `up to ${owing.toFixed(2)}`}
          className={`${small} text-end`}
        />
        <select name="method" className={small}>
          <option value="CASH">{ar ? "كاش" : "Cash"}</option>
          <option value="CARD">{ar ? "فيزا" : "Card"}</option>
          <option value="BANK_TRANSFER">{ar ? "تحويل" : "Transfer"}</option>
          <option value="WALLET">{ar ? "محفظة" : "Wallet"}</option>
        </select>
        <Buttons ar={ar} pending={depositPending} onCancel={() => setPanel(null)} label={ar ? "استلم" : "Take"} />
        {depositState.error && <p className="text-xs text-bad">{depositState.error}</p>}
      </form>
    );
  }

  if (panel === "run") {
    return (
      <form action={runAction} className="min-w-[15rem] space-y-2">
        <input type="hidden" name="customOrderId" value={order.id} />
        {runs.length === 0 ? (
          <p className="text-xs text-ink-500">
            {ar
              ? "مفيش أمر إنتاج متاح للموديل ده. اعمل واحد من شاشة الإنتاج الأول."
              : "No free run for this style. Raise one on the production screen first."}
          </p>
        ) : (
          <select name="productionOrderId" required className={small}>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>{r.label}</option>
            ))}
          </select>
        )}
        <Buttons
          ar={ar} pending={runPending} onCancel={() => setPanel(null)}
          label={ar ? "اربط" : "Attach"} disabled={runs.length === 0}
        />
        {runState.error && <p className="text-xs text-bad">{runState.error}</p>}
      </form>
    );
  }

  if (panel === "deliver") {
    return (
      <form action={deliverActionFn} className="min-w-[15rem] space-y-2">
        <input type="hidden" name="customOrderId" value={order.id} />
        <input type="hidden" name="deliveredOn" value={today} />
        <input type="hidden" name="channelId" value={channelId} />
        <p className="text-xs text-ink-600">
          {ar ? `باقي عليه ${owing.toFixed(2)}` : `${owing.toFixed(2)} still to pay`}
        </p>
        <input
          name="payNow" type="number" step="0.01" min="0" max={owing} dir="ltr"
          placeholder={ar ? "بيدفع كام دلوقتي" : "Paying now"}
          defaultValue={owing.toFixed(2)}
          className={`${small} text-end`}
        />
        <select name="method" className={small}>
          <option value="CASH">{ar ? "كاش" : "Cash"}</option>
          <option value="CARD">{ar ? "فيزا" : "Card"}</option>
          <option value="BANK_TRANSFER">{ar ? "تحويل" : "Transfer"}</option>
          <option value="WALLET">{ar ? "محفظة" : "Wallet"}</option>
        </select>
        <p className="text-[11px] text-ink-400">
          {ar
            ? "اللي مايتدفعش دلوقتي هيتحط على حساب الزبون."
            : "Anything left goes on the customer's account."}
        </p>
        <Buttons ar={ar} pending={deliverPending} onCancel={() => setPanel(null)} label={ar ? "سلّم" : "Deliver"} />
        {deliverState.error && <p className="text-xs text-bad">{deliverState.error}</p>}
      </form>
    );
  }

  if (panel === "cancel") {
    return (
      <form action={cancelActionFn} className="min-w-[15rem] space-y-2">
        <input type="hidden" name="customOrderId" value={order.id} />
        <input type="hidden" name="cancelledOn" value={today} />
        <input
          name="reason" required
          placeholder={ar ? "السبب" : "Reason"}
          className={small}
        />
        {Number(order.deposit) > 0 && (
          <>
            <p className="text-[11px] text-warn">
              {ar
                ? `هيترجّع عربون ${Number(order.deposit).toFixed(2)}`
                : `${Number(order.deposit).toFixed(2)} deposit will be returned`}
            </p>
            <select name="refundMethod" className={small}>
              <option value="CASH">{ar ? "كاش" : "Cash"}</option>
              <option value="BANK_TRANSFER">{ar ? "تحويل" : "Transfer"}</option>
              <option value="CARD">{ar ? "فيزا" : "Card"}</option>
              <option value="WALLET">{ar ? "محفظة" : "Wallet"}</option>
            </select>
          </>
        )}
        <Buttons ar={ar} pending={cancelPending} onCancel={() => setPanel(null)} label={ar ? "الغِ" : "Cancel order"} />
        {cancelState.error && <p className="text-xs text-bad">{cancelState.error}</p>}
      </form>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {mayHandleMoney && owing > 0 && (
        <Chip onClick={() => setPanel("deposit")}>{ar ? "عربون" : "Deposit"}</Chip>
      )}

      {mayPlan && order.status === "PENDING" && (
        <Chip onClick={() => setPanel("run")}>{ar ? "للإنتاج" : "To production"}</Chip>
      )}

      {mayPlan && order.status === "IN_PRODUCTION" && (
        <form action={readyAction} className="inline">
          <input type="hidden" name="customOrderId" value={order.id} />
          <button
            type="submit"
            disabled={readyPending}
            className="rounded-lg border border-ink-300 px-2 py-1 text-xs font-medium text-ink-700 disabled:opacity-50"
          >
            {ar ? "جاهز" : "Ready"}
          </button>
        </form>
      )}

      {mayDeliver && order.status === "READY" && (
        <Chip onClick={() => setPanel("deliver")} strong>
          {ar ? "تسليم" : "Deliver"}
        </Chip>
      )}

      {mayHandleMoney && (
        <button
          type="button"
          onClick={() => setPanel("cancel")}
          className="text-xs text-ink-400 underline"
        >
          {ar ? "إلغاء" : "Cancel"}
        </button>
      )}

      {message && <p className="w-full text-xs text-bad">{message}</p>}
      {done && <p className="w-full text-xs text-good">{done}</p>}
    </div>
  );
}

function Chip({
  children,
  onClick,
  strong,
}: {
  children: React.ReactNode;
  onClick: () => void;
  strong?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "rounded-lg px-2 py-1 text-xs font-medium " +
        (strong
          ? "bg-ink-900 text-white"
          : "border border-ink-300 text-ink-700")
      }
    >
      {children}
    </button>
  );
}

function Buttons({
  ar,
  pending,
  onCancel,
  label,
  disabled,
}: {
  ar: boolean;
  pending: boolean;
  onCancel: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="submit"
        disabled={pending || disabled}
        className="rounded-lg bg-ink-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
      >
        {pending ? "…" : label}
      </button>
      <button type="button" onClick={onCancel} className="text-xs text-ink-500">
        {ar ? "رجوع" : "Back"}
      </button>
    </div>
  );
}
