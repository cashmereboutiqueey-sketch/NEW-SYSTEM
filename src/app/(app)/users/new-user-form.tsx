"use client";

import { useActionState, useState } from "react";
import { createUserAction, type UserState } from "./actions";

const empty: UserState = {};
const field =
  "w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep";

/** A temporary password nobody has to invent under pressure. */
function suggest(): string {
  const words = ["نيلة", "قطن", "حرير", "كتان", "صوف"];
  void words;
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  const bytes = new Uint32Array(12);
  crypto.getRandomValues(bytes);
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export function NewUserForm({
  ar,
  roles,
}: {
  ar: boolean;
  roles: { role: string; label: string; permissionCount: number }[];
}) {
  const [state, action, pending] = useActionState(createUserAction, empty);
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("POS_CASHIER");

  const chosen = roles.find((r) => r.role === role);

  return (
    <form action={action} className="grid gap-3 lg:grid-cols-3">
      <label className="text-sm">
        <span className="mb-1 block text-ink-600">{ar ? "الاسم" : "Name"}</span>
        <input name="name" required className={field} />
      </label>

      <label className="text-sm">
        <span className="mb-1 block text-ink-600">{ar ? "الإيميل" : "Email"}</span>
        <input name="email" type="email" required dir="ltr" className={field} />
      </label>

      <label className="text-sm">
        <span className="mb-1 block text-ink-600">{ar ? "الدور" : "Role"}</span>
        <select
          name="role"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className={field}
        >
          {roles.map((r) => (
            <option key={r.role} value={r.role}>
              {r.label}
            </option>
          ))}
        </select>
      </label>

      <div className="lg:col-span-3">
        {chosen && (
          <p className="text-xs text-ink-500">
            {role === "OWNER" ? (
              <span className="text-warn">
                {ar
                  ? "المالك بيوصل لكل حاجة في النظام — المرتبات، الأرباح، الإعدادات، وحسابات الناس."
                  : "An owner reaches everything: salaries, profit, settings and other people's accounts."}
              </span>
            ) : (
              <>
                {ar
                  ? `الدور ده بيفتح ${chosen.permissionCount} صلاحية.`
                  : `This role opens ${chosen.permissionCount} permissions.`}
              </>
            )}
          </p>
        )}
      </div>

      <label className="text-sm">
        <span className="mb-1 block text-ink-600">
          {ar ? "باسورد مؤقت" : "Temporary password"}
        </span>
        <input
          name="password"
          required
          minLength={10}
          dir="ltr"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={`${field} num`}
        />
      </label>

      <label className="text-sm">
        <span className="mb-1 block text-ink-600">{ar ? "أكّده" : "Confirm"}</span>
        <input
          name="confirmPassword"
          required
          minLength={10}
          dir="ltr"
          className={`${field} num`}
        />
      </label>

      <div className="flex items-end">
        <button
          type="button"
          onClick={() => setPassword(suggest())}
          className="rounded-lg border border-ink-300 px-3 py-2 text-xs text-ink-700"
        >
          {ar ? "اقترح واحد" : "Suggest one"}
        </button>
      </div>

      <input type="hidden" name="locale" value="ar" />

      <div className="lg:col-span-3 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? (ar ? "بيتعمل…" : "Creating…") : ar ? "اعمل الحساب" : "Create account"}
        </button>

        {state.error && <p className="text-sm text-bad">{state.error}</p>}
        {state.success && <p className="text-sm text-good">{state.success}</p>}
      </div>
    </form>
  );
}
