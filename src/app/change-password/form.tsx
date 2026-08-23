"use client";

import { useActionState, useState } from "react";
import { changePasswordAction, type ChangePasswordState } from "./actions";

const empty: ChangePasswordState = {};
const field =
  "w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm text-ink-900 outline-none focus:border-rose-deep focus:ring-2 focus:ring-rose/60";

export function ChangePasswordForm({ ar, forced }: { ar: boolean; forced: boolean }) {
  const [state, action, pending] = useActionState(changePasswordAction, empty);
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");

  const tooShort = next.length > 0 && next.length < 10;
  const noSymbol = next.length > 0 && !/[^a-zA-Z]/.test(next);
  const mismatch = confirm.length > 0 && next !== confirm;

  return (
    <form action={action} className="space-y-3" dir="rtl">
      <label className="block text-sm">
        <span className="mb-1 block text-ink-600">
          {forced
            ? ar ? "الباسورد اللي اتداهولك" : "The password you were given"
            : ar ? "الباسورد الحالي" : "Current password"}
        </span>
        <input
          type="password"
          name="currentPassword"
          required
          autoComplete="current-password"
          dir="ltr"
          className={field}
        />
      </label>

      <label className="block text-sm">
        <span className="mb-1 block text-ink-600">{ar ? "الباسورد الجديد" : "New password"}</span>
        <input
          type="password"
          name="newPassword"
          required
          autoComplete="new-password"
          dir="ltr"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className={field}
        />
      </label>

      <label className="block text-sm">
        <span className="mb-1 block text-ink-600">{ar ? "أكّده تاني" : "Confirm it"}</span>
        <input
          type="password"
          name="confirmPassword"
          required
          autoComplete="new-password"
          dir="ltr"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className={field}
        />
      </label>

      {/* Said while they type rather than after they submit. */}
      {tooShort && (
        <p className="text-xs text-warn">
          {ar ? "لازم ١٠ حروف على الأقل." : "At least 10 characters."}
        </p>
      )}
      {!tooShort && noSymbol && (
        <p className="text-xs text-warn">
          {ar ? "لازم رقم أو رمز على الأقل." : "At least one number or symbol."}
        </p>
      )}
      {mismatch && (
        <p className="text-xs text-bad">
          {ar ? "التأكيد مش زيه." : "That does not match."}
        </p>
      )}

      {state.error && (
        <p role="alert" className="rounded-lg bg-bad/10 px-3 py-2 text-sm text-bad">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending || tooShort || noSymbol || mismatch || !next}
        className="w-full rounded-lg bg-ink-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40"
      >
        {pending ? (ar ? "…" : "…") : ar ? "احفظ وادخل" : "Save and continue"}
      </button>
    </form>
  );
}
