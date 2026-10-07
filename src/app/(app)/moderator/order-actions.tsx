"use client";
import { cairoDateKey } from "@/lib/cairo-date";

import { useActionState, useState } from "react";
import { RequestIdField } from "@/components/request-id";
import {
  addDepositAction,
  linkRunAction,
  startCustomOrderRunAction,
  markReadyAction,
  deliverAction,
  shipCustomOrderAction,
  cancelAction,
  type CustomOrderState,
} from "./order-lifecycle-actions";

const empty: CustomOrderState = {};
const small =
  "w-full rounded-lg border border-ink-200 bg-panel px-2 py-1.5 text-sm outline-none focus:border-rose-deep";

type Panel = null | "deposit" | "run" | "deliver" | "ship" | "cancel";

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
  mayStartRun,
  mayDeliver,
  mayReceive,
  incoming,
  canMarkReady,
  zones,
}: {
  ar: boolean;
  order: { id: string; status: string; atRisk: string; deposit: string; customerName: string; customerPhone: string | null; salesOrderNumber: string | null };
  channelId: string;
  runs: { id: string; label: string }[];
  mayHandleMoney: boolean;
  mayPlan: boolean;
  mayStartRun: boolean;
  mayDeliver: boolean;
  mayReceive: boolean;
  incoming: boolean;
  canMarkReady: boolean;
  zones: { governorate: string; regions: { id: string; region: string; price: string }[] }[];
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const [shippingCharge, setShippingCharge] = useState("0");
  const [depositState, depositAction, depositPending] = useActionState(addDepositAction, empty);
  const [runState, runAction, runPending] = useActionState(linkRunAction, empty);
  const [startState, startAction, startPending] = useActionState(startCustomOrderRunAction, empty);
  const [readyState, readyAction, readyPending] = useActionState(markReadyAction, empty);
  const [deliverState, deliverActionFn, deliverPending] = useActionState(deliverAction, empty);
  const [shipState, shipActionFn, shipPending] = useActionState(shipCustomOrderAction, empty);
  const [cancelState, cancelActionFn, cancelPending] = useActionState(cancelAction, empty);

  const today = cairoDateKey();
  const owing = Number(order.atRisk);

  const message =
    depositState.error ?? runState.error ?? startState.error ?? readyState.error ??
    deliverState.error ?? shipState.error ?? cancelState.error;
  const done =
    depositState.success ?? runState.success ?? startState.success ?? readyState.success ??
    deliverState.success ?? shipState.success ?? cancelState.success;

  if (panel === "deposit") {
    return (
      <form action={depositAction} className="min-w-[15rem] space-y-2">
        <RequestIdField state={depositState} />
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
          <option value="INSTAPAY">{ar ? "إنستاباي" : "InstaPay"}</option>
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
        <RequestIdField state={deliverState} />
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
          <option value="INSTAPAY">{ar ? "إنستاباي" : "InstaPay"}</option>
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

  if (panel === "ship") {
    return (
      <form action={shipActionFn} className="min-w-[17rem] space-y-2">
        <RequestIdField state={shipState} />
        <input type="hidden" name="customOrderId" value={order.id} />
        <input type="hidden" name="channelId" value={channelId} />
        <input type="hidden" name="shippedOn" value={today} />
        <p className="text-xs text-ink-600">{ar ? `باقي من ثمن القطعة ${owing.toFixed(2)} جنيه. المندوب هيحصّل الباقي ورسوم الشحن.` : `${owing.toFixed(2)} left on the garment. The courier collects this plus any shipping charge.`}</p>
        <label className="block text-xs text-ink-600">{ar ? "منطقة الشحن" : "Courier area"}</label>
        <select name="courierZoneId" required defaultValue="" className={small}
          onChange={(event) => {
            const picked = zones.flatMap((group) => group.regions).find((zone) => zone.id === event.target.value);
            setShippingCharge(picked?.price ?? "0");
          }}>
          <option value="">{ar ? "اختار المحافظة والمنطقة" : "Choose area"}</option>
          {zones.map((group) => (
            <optgroup key={group.governorate} label={group.governorate}>
              {group.regions.map((zone) => (
                <option key={zone.id} value={zone.id}>{zone.region} · {Number(zone.price).toFixed(2)}</option>
              ))}
            </optgroup>
          ))}
        </select>
        <label className="block text-xs text-ink-600">{ar ? "اسم المستلم" : "Recipient"}</label>
        <input name="recipientName" required defaultValue={order.customerName} className={small} />
        <label className="block text-xs text-ink-600">{ar ? "رقم التليفون" : "Phone"}</label>
        <input name="phone" type="tel" required defaultValue={order.customerPhone ?? ""} dir="ltr" className={small} />
        <input name="secondPhone" type="tel" placeholder={ar ? "رقم تاني (اختياري)" : "Second phone (optional)"} dir="ltr" className={small} />
        <label className="block text-xs text-ink-600">{ar ? "العنوان بالتفصيل" : "Full address"}</label>
        <input name="addressLine" required className={small} />
        <label className="block text-xs text-ink-600">{ar ? "الشحن اللي هيتحصّل من العميل" : "Shipping charged to customer"}</label>
        <input name="shippingAmount" type="number" min="0" step="0.01" required value={shippingCharge}
          onChange={(event) => setShippingCharge(event.target.value)} dir="ltr" className={small} />
        <p className="text-xs font-medium text-ink-700">{ar ? "المندوب هيحصّل" : "Courier collects"} {(owing + Number(shippingCharge || 0)).toFixed(2)}</p>
        <p className="text-[11px] text-ink-500">{ar ? "الأوردر هيظهر في صفحة الشحن للتسليم إلى Flextock بعد قبولها له. لو العميل حوّل قبل التسليم، صحّح التحصيل من التسويات." : "The order will appear on the shipping desk for Flextock handoff after acceptance. Reconcile a later transfer there."}</p>
        <Buttons ar={ar} pending={shipPending} onCancel={() => setPanel(null)} label={ar ? "جهّز للشحن" : "Book for shipping"} />
        {shipState.error && <p className="text-xs text-bad">{shipState.error}</p>}
      </form>
    );
  }

  if (panel === "cancel") {
    return (
      <form action={cancelActionFn} className="min-w-[15rem] space-y-2">
        <RequestIdField state={cancelState} />
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
              <option value="INSTAPAY">{ar ? "إنستاباي" : "InstaPay"}</option>
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

      {mayStartRun && order.status === "PENDING" && (
        <form action={startAction} className="inline">
          <RequestIdField state={startState} />
          <input type="hidden" name="customOrderId" value={order.id} />
          <button type="submit" disabled={startPending}
            className="rounded-lg border border-ink-300 px-2 py-1 text-xs font-medium text-ink-700 disabled:opacity-50">
            {ar ? "اعمل أمر إنتاج" : "Create run"}
          </button>
        </form>
      )}

      {mayPlan && order.status === "PENDING" && (
        <Chip onClick={() => setPanel("run")}>{ar ? "للإنتاج" : "To production"}</Chip>
      )}

      {mayReceive && order.status === "IN_PRODUCTION" && incoming && (
        <a href={`/goods-in?customOrderId=${encodeURIComponent(order.id)}`} className="rounded-lg border border-ink-300 px-2 py-1 text-xs font-medium text-ink-700">
          {ar ? "استلم من المصنع" : "Receive from factory"}
        </a>
      )}

      {mayDeliver && order.status === "IN_PRODUCTION" && canMarkReady && (
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

      {mayDeliver && order.status === "READY" && (
        <Chip onClick={() => setPanel("ship")}>{ar ? "طلّع شحن" : "Ship"}</Chip>
      )}

      {order.status === "SHIPPING" && order.salesOrderNumber && (
        <a href="/shipping" className="text-xs text-rose-deep underline">
          {ar ? `تابع ${order.salesOrderNumber} في الشحن` : `Track ${order.salesOrderNumber} in shipping`}
        </a>
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
