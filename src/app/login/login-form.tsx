"use client";

import { useActionState, useState } from "react";
import { loginAction, type LoginState } from "../actions";
import { t, type Locale } from "@/lib/i18n";

export function LoginForm({ locale }: { locale: Locale }) {
  const [showPassword, setShowPassword] = useState(false);
  const [state, formAction, pending] = useActionState<LoginState, FormData>(
    loginAction,
    {},
  );

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label
          htmlFor="email"
          className="mb-1.5 block text-sm font-medium text-ink-700"
        >
          {t("email", locale)}
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="username"
          dir="ltr"
          className="w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm text-ink-900 outline-none focus:border-rose-deep focus:ring-2 focus:ring-rose/60"
        />
      </div>

      <div>
        <label
          htmlFor="password"
          className="mb-1.5 block text-sm font-medium text-ink-700"
        >
          {t("password", locale)}
        </label>
        <input
          id="password"
          name="password"
          type={showPassword ? "text" : "password"}
          required
          autoComplete="current-password"
          dir="ltr"
          className="w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm text-ink-900 outline-none focus:border-rose-deep focus:ring-2 focus:ring-rose/60"
        />
        <button
          type="button"
          aria-controls="password"
          aria-pressed={showPassword}
          onClick={() => setShowPassword((visible) => !visible)}
          className="mt-2 text-sm font-medium text-rose-deep underline-offset-2 hover:underline focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-deep"
        >
          {showPassword ? t("hidePassword", locale) : t("showPassword", locale)}
        </button>
      </div>

      {state.error && (
        <p
          role="alert"
          className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad"
        >
          {t("invalidCredentials", locale)}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-ink-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-ink-800 disabled:opacity-60"
      >
        {pending ? t("loading", locale) : t("signIn", locale)}
      </button>
    </form>
  );
}
