"use client";

import { useActionState, useState } from "react";
import { quickSwitchAction, type QuickSwitchState } from "@/app/(app)/quick-switch/actions";

const field = "w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep";

export function QuickSwitch({
  ar, cashiers, currentUserId,
}: {
  ar: boolean;
  cashiers: { id: string; name: string }[];
  currentUserId: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<QuickSwitchState, FormData>(quickSwitchAction, {});
  if (cashiers.length === 0) return null;

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className="rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs font-medium text-ink-700 hover:border-rose-deep">
        {ar ? "بدّل البائع" : "Switch cashier"}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/50 p-4">
          <div role="dialog" aria-modal="true" aria-label={ar ? "بدّل البائع" : "Switch cashier"}
            className="w-full max-w-sm rounded-2xl bg-panel p-5 shadow-xl">
            <h2 className="text-lg font-semibold text-ink-900">{ar ? "مين هيشتغل دلوقتي؟" : "Who is working now?"}</h2>
            <p className="mt-1 text-xs text-ink-500">
              {ar ? "اختار حسابك واكتب رمزك. كل بيعة بعدها هتتسجل باسمك." : "Choose your account and enter your PIN. New sales will be recorded in your name."}
            </p>
            <form action={action} className="mt-4 space-y-3">
              <label className="block text-sm text-ink-700">
                {ar ? "البائع" : "Cashier"}
                <select name="userId" defaultValue={currentUserId} className={`mt-1 ${field}`} required>
                  {!cashiers.some((cashier) => cashier.id === currentUserId) && <option value="">{ar ? "اختار" : "Choose"}</option>}
                  {cashiers.map((cashier) => <option key={cashier.id} value={cashier.id}>{cashier.name}</option>)}
                </select>
              </label>
              <label className="block text-sm text-ink-700">
                {ar ? "الرمز الشخصي" : "Personal PIN"}
                <input name="pin" type="password" inputMode="numeric" pattern="[0-9]{6}" maxLength={6}
                  autoComplete="off" required className={`mt-1 ${field} num`} />
              </label>
              {state.error && <p role="alert" className="text-xs text-bad">{state.error}</p>}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setOpen(false)} className="rounded-lg px-3 py-2 text-sm text-ink-500">
                  {ar ? "رجوع" : "Cancel"}
                </button>
                <button type="submit" disabled={pending} className="rounded-lg bg-ink-900 px-4 py-2 text-sm text-white disabled:opacity-50">
                  {pending ? "…" : ar ? "ابدأ باسمي" : "Continue as me"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
