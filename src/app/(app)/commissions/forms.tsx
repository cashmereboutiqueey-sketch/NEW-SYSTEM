"use client";

import { useActionState, useState } from "react";
import { RequestIdField } from "@/components/request-id";
import { setRateAction, endRateAction, settleAction } from "./actions";
import type { FormState } from "@/components/entity-form";

const empty: FormState = {};
const field =
  "w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep";

/**
 * Putting somebody on a rate, from a day.
 *
 * Both halves are offered and either may be left at zero, because a shop that
 * pays ten pounds a piece and a shop that pays two per cent are both ordinary
 * and a form that insists on one of them teaches the wrong thing about what
 * the rate is.
 */
export function RateForm({
  ar,
  users,
}: {
  ar: boolean;
  users: { id: string; name: string; role: string }[];
}) {
  const [state, action, pending] = useActionState(setRateAction, empty);
  const [perPiece, setPerPiece] = useState("10");
  const [percent, setPercent] = useState("0");
  const today = new Date().toISOString().slice(0, 10);

  return (
    <form action={action} className="space-y-3">
      <RequestIdField state={state} />
      <div className="grid gap-3 lg:grid-cols-4">
        <label className="text-sm lg:col-span-2">
          <span className="mb-1 block text-ink-600">{ar ? "مين" : "Who"}</span>
          <select name="userId" required className={field}>
            <option value="">{ar ? "اختار…" : "Pick…"}</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.name} · {u.role}</option>
            ))}
          </select>
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-ink-600">{ar ? "للقطعة (جنيه)" : "Per piece (EGP)"}</span>
          <input
            name="perPieceAmount" type="number" step="0.01" min={0}
            value={perPiece} onChange={(e) => setPerPiece(e.target.value)}
            className={field} dir="ltr"
          />
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-ink-600">{ar ? "نسبة من الصافي (%)" : "Percent of net (%)"}</span>
          <input
            name="percentOfNet" type="number" step="0.01" min={0} max={100}
            value={percent} onChange={(e) => setPercent(e.target.value)}
            className={field} dir="ltr"
          />
        </label>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <label className="text-sm">
          <span className="mb-1 block text-ink-600">{ar ? "ساري من" : "From"}</span>
          <input name="effectiveFrom" type="date" defaultValue={today} required className={field} dir="ltr" />
        </label>
        <label className="text-sm lg:col-span-2">
          <span className="mb-1 block text-ink-600">{ar ? "ملاحظة" : "Note"}</span>
          <input name="notes" className={field} placeholder={ar ? "اتفقنا على إيه" : "What was agreed"} />
        </label>
      </div>

      <p className="text-xs text-ink-500">
        {ar
          ? "النسبة بتتحسب على صافي الأوردر بعد الخصم وقبل الشحن — الشحن فلوس الشركة الشحن مش بيعة."
          : "The percentage is taken on the order's net: after discount, before shipping — a further parcel is not a better sale."}
      </p>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? (ar ? "بنسجّل…" : "Saving…") : ar ? "ثبّت الرات" : "Set the rate"}
        </button>
        {state.error && <span className="text-sm text-bad">{state.error}</span>}
        {state.success && <span className="text-sm text-good">{state.success}</span>}
      </div>
    </form>
  );
}

/** Paying somebody what the lines say, and clearing the debt. */
export function SettleForm({
  ar,
  userId,
  name,
  owed,
}: {
  ar: boolean;
  userId: string;
  name: string;
  owed: string;
}) {
  const [state, action, pending] = useActionState(settleAction, empty);
  const [open, setOpen] = useState(false);
  const today = new Date().toISOString().slice(0, 10);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-ink-200 px-2.5 py-1 text-xs font-medium text-ink-800"
      >
        {ar ? "ادفعله" : "Pay"}
      </button>
    );
  }

  return (
    <form action={action} className="min-w-[14rem] space-y-2">
      <RequestIdField state={state} />
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="paidOn" value={today} />

      <p className="text-xs text-ink-600">
        {ar ? `${name} — ` : `${name} — `}
        <span className="num font-semibold">{Number(owed).toFixed(2)}</span>
      </p>

      <select name="method" className={`${field} text-xs`} defaultValue="CASH">
        <option value="CASH">{ar ? "كاش" : "Cash"}</option>
        <option value="INSTAPAY">InstaPay</option>
        <option value="BANK_TRANSFER">{ar ? "تحويل بنكي" : "Bank transfer"}</option>
      </select>

      <input name="notes" className={`${field} text-xs`} placeholder={ar ? "ملاحظة" : "Note"} />

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-ink-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {pending ? (ar ? "بندفع…" : "Paying…") : ar ? "ادفع الكل" : "Pay it all"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-ink-500"
        >
          {ar ? "سيبك" : "Cancel"}
        </button>
      </div>

      {state.error && <p className="text-xs text-bad">{state.error}</p>}
      {state.success && <p className="text-xs text-good">{state.success}</p>}
    </form>
  );
}

/** Taking somebody off commission from a day, earnings untouched. */
export function EndRateForm({ ar, userId }: { ar: boolean; userId: string }) {
  const [state, action, pending] = useActionState(endRateAction, empty);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <form action={action} className="flex items-center gap-1.5">
      <RequestIdField state={state} />
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="lastDay" value={today} />
      <button
        type="submit"
        disabled={pending}
        title={ar ? "يقف من النهاردة. اللي اتكسب قبل كده زي ما هو." : "Stops today. What was already earned is untouched."}
        className="text-xs text-ink-500 underline disabled:opacity-50"
      >
        {pending ? (ar ? "…" : "…") : ar ? "وقّف" : "End"}
      </button>
      {state.error && <span className="text-xs text-bad">{state.error}</span>}
    </form>
  );
}
