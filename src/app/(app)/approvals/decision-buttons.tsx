"use client";

import { useActionState, useState } from "react";
import {
  approveExpenseAction,
  rejectExpenseAction,
  approvePurchaseOrderAction,
  rejectPurchaseOrderAction,
  approvePayrollAction,
  type ApprovalState,
} from "./actions";

const empty: ApprovalState = {};

type Kind = "expense" | "purchaseOrder" | "payroll";

const FIELD: Record<Kind, string> = {
  expense: "expenseId",
  purchaseOrder: "purchaseOrderId",
  payroll: "payrollRunId",
};

/**
 * Yes or send it back.
 *
 * Something the person looking at it raised themselves is shown greyed with
 * the reason, rather than as a button that will refuse them. A refusal they
 * could have predicted teaches them to click through refusals they could not.
 */
export function DecisionButtons({
  ar,
  kind,
  id,
  isOwn,
  approveOnly,
}: {
  ar: boolean;
  kind: Kind;
  id: string;
  isOwn: boolean;
  approveOnly?: boolean;
}) {
  const approveFn =
    kind === "expense"
      ? approveExpenseAction
      : kind === "purchaseOrder"
        ? approvePurchaseOrderAction
        : approvePayrollAction;

  const rejectFn =
    kind === "expense" ? rejectExpenseAction : rejectPurchaseOrderAction;

  const [approveState, approve, approving] = useActionState(approveFn, empty);
  const [rejectState, sendBack, rejecting] = useActionState(rejectFn, empty);
  const [showReason, setShowReason] = useState(false);
  const [showOverride, setShowOverride] = useState(false);

  // Approving something you raised yourself. Refused outright until now,
  // which left a one-person shop with an inbox nothing could clear. It is
  // allowed with a stated reason, and the audit entry says an override
  // happened rather than recording an ordinary approval.
  if (isOwn) {
    if (!showOverride) {
      return (
        <div className="text-xs">
          <span className="text-ink-400">
            {ar ? "انت اللي طلبتها — المفروض حد تاني" : "yours — somebody else should sign"}
          </span>
          <button
            type="button"
            onClick={() => setShowOverride(true)}
            className="ms-2 text-ink-500 underline"
          >
            {ar ? "اعتمدها بنفسك" : "approve it yourself"}
          </button>
        </div>
      );
    }

    return (
      <form action={approve} className="min-w-[14rem] space-y-2">
        <input type="hidden" name={FIELD[kind]} value={id} />
        <input
          name="overrideReason"
          required
          placeholder={ar ? "ليه بتعتمدها بنفسك؟" : "Why are you approving your own?"}
          className="w-full rounded-lg border border-warn px-2 py-1.5 text-sm outline-none"
        />
        <p className="text-[11px] text-warn">
          {ar
            ? "هيتسجّل إنك اعتمدت طلبك بنفسك، بالسبب ده."
            : "This is recorded as approving your own, with that reason."}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={approving}
            className="rounded-lg bg-warn px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {approving ? "…" : ar ? "اعتمد" : "Approve"}
          </button>
          <button
            type="button"
            onClick={() => setShowOverride(false)}
            className="text-xs text-ink-500"
          >
            {ar ? "رجوع" : "Back"}
          </button>
        </div>
        {approveState.error && <p className="text-xs text-bad">{approveState.error}</p>}
      </form>
    );
  }

  if (showReason) {
    return (
      <form action={sendBack} className="min-w-[13rem] space-y-2">
        <input type="hidden" name={FIELD[kind]} value={id} />
        <input
          name="reason"
          required
          placeholder={ar ? "السبب — هيشوفه صاحبها" : "Reason — they will see it"}
          className="w-full rounded-lg border border-ink-200 px-2 py-1.5 text-sm outline-none focus:border-ink-500"
        />
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={rejecting}
            className="rounded-lg bg-bad px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {rejecting ? "…" : ar ? "رجّعها" : "Send back"}
          </button>
          <button
            type="button"
            onClick={() => setShowReason(false)}
            className="text-xs text-ink-500"
          >
            {ar ? "رجوع" : "Back"}
          </button>
        </div>
        {rejectState.error && <p className="text-xs text-bad">{rejectState.error}</p>}
      </form>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <form action={approve} className="inline">
        <input type="hidden" name={FIELD[kind]} value={id} />
        <button
          type="submit"
          disabled={approving}
          className="rounded-lg bg-ink-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {approving ? "…" : ar ? "اعتمد" : "Approve"}
        </button>
      </form>

      {!approveOnly && (
        <button
          type="button"
          onClick={() => setShowReason(true)}
          className="text-xs text-ink-500 underline"
        >
          {ar ? "رجّعها" : "Send back"}
        </button>
      )}

      {approveState.error && (
        <p className="w-full text-xs text-bad">{approveState.error}</p>
      )}
      {approveState.success && (
        <p className="w-full text-xs text-good">{approveState.success}</p>
      )}
    </div>
  );
}
