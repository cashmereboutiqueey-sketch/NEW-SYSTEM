"use client";

import { useActionState, useState } from "react";
import {
  setRoleAction,
  setActiveAction,
  resetPasswordAction,
  unlockAction,
  type UserState,
} from "./actions";

const empty: UserState = {};
const small =
  "w-full rounded-lg border border-ink-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-ink-500";

type Panel = null | "role" | "password";

/**
 * What can be done to one account.
 *
 * The two moves that could lock the business out of its own system — switching
 * off the last owner, or your own account — are not offered at all. Showing a
 * button that will only produce an error teaches people to ignore errors, and
 * these are the errors that matter most.
 */
export function UserActions({
  ar,
  user,
  isSelf,
  isLastOwner,
  roles,
}: {
  ar: boolean;
  user: { id: string; name: string; role: string; isActive: boolean; isLocked: boolean };
  isSelf: boolean;
  isLastOwner: boolean;
  roles: { role: string; label: string }[];
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const [roleState, roleAction, rolePending] = useActionState(setRoleAction, empty);
  const [activeState, activeAction, activePending] = useActionState(setActiveAction, empty);
  const [pwState, pwAction, pwPending] = useActionState(resetPasswordAction, empty);
  const [unlockState, unlockActionFn, unlockPending] = useActionState(unlockAction, empty);

  const message =
    roleState.error ?? activeState.error ?? pwState.error ?? unlockState.error;

  if (panel === "role") {
    return (
      <form action={roleAction} className="min-w-[12rem] space-y-2">
        <input type="hidden" name="userId" value={user.id} />
        <select name="role" defaultValue={user.role} className={small}>
          {roles.map((r) => (
            <option key={r.role} value={r.role}>{r.label}</option>
          ))}
        </select>
        <Buttons
          ar={ar} pending={rolePending} onBack={() => setPanel(null)}
          label={ar ? "غيّر" : "Change"}
        />
        {roleState.error && <p className="text-xs text-bad">{roleState.error}</p>}
      </form>
    );
  }

  if (panel === "password") {
    return (
      <form action={pwAction} className="min-w-[13rem] space-y-2">
        <input type="hidden" name="userId" value={user.id} />
        <input
          name="password" type="text" required minLength={10} dir="ltr"
          placeholder={ar ? "باسورد مؤقت" : "Temporary password"}
          className={`${small} num`}
        />
        <input
          name="confirmPassword" type="text" required minLength={10} dir="ltr"
          placeholder={ar ? "أكّده" : "Confirm"}
          className={`${small} num`}
        />
        <p className="text-[11px] text-ink-400">
          {ar
            ? "هيتجبر يغيّره أول ما يدخل."
            : "They must replace it on first sign-in."}
        </p>
        <Buttons
          ar={ar} pending={pwPending} onBack={() => setPanel(null)}
          label={ar ? "غيّر الباسورد" : "Reset"}
        />
        {pwState.error && <p className="text-xs text-bad">{pwState.error}</p>}
      </form>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {!isSelf && (
        <button
          type="button"
          onClick={() => setPanel("role")}
          className="rounded-lg border border-ink-300 px-2 py-1 text-xs text-ink-700"
        >
          {ar ? "الدور" : "Role"}
        </button>
      )}

      <button
        type="button"
        onClick={() => setPanel("password")}
        className="rounded-lg border border-ink-300 px-2 py-1 text-xs text-ink-700"
      >
        {ar ? "باسورد" : "Password"}
      </button>

      {user.isLocked && (
        <form action={unlockActionFn} className="inline">
          <input type="hidden" name="userId" value={user.id} />
          <button
            type="submit"
            disabled={unlockPending}
            className="rounded-lg bg-ink-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            {ar ? "افتحه" : "Unlock"}
          </button>
        </form>
      )}

      {/* Switching off yourself, or the last owner, is not offered. Both are
          unrecoverable without a database console. */}
      {!isSelf && !(user.isActive && isLastOwner) && (
        <form action={activeAction} className="inline">
          <input type="hidden" name="userId" value={user.id} />
          <input type="hidden" name="isActive" value={String(!user.isActive)} />
          <button
            type="submit"
            disabled={activePending}
            className={
              "text-xs underline disabled:opacity-50 " +
              (user.isActive ? "text-ink-400" : "text-good")
            }
          >
            {user.isActive ? (ar ? "اقفله" : "Switch off") : (ar ? "رجّعه" : "Switch on")}
          </button>
        </form>
      )}

      {message && <p className="w-full text-xs text-bad">{message}</p>}
    </div>
  );
}

function Buttons({
  ar,
  pending,
  onBack,
  label,
}: {
  ar: boolean;
  pending: boolean;
  onBack: () => void;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-ink-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
      >
        {pending ? "…" : label}
      </button>
      <button type="button" onClick={onBack} className="text-xs text-ink-500">
        {ar ? "رجوع" : "Back"}
      </button>
    </div>
  );
}
