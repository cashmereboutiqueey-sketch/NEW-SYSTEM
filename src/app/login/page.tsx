import { redirect } from "next/navigation";
import { getSession, getPrefs } from "@/lib/session";
import { t } from "@/lib/i18n";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  const session = await getSession();
  if (session) redirect("/");

  const { locale } = await getPrefs();

  return (
    <main className="flex min-h-screen items-center justify-center bg-cream p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-ink-900 text-lg font-bold text-cream">
            C
          </div>
          <h1 className="text-xl font-semibold text-ink-900">
            {t("appName", locale)}
          </h1>
          <p className="mt-1 text-sm text-ink-500">{t("appTagline", locale)}</p>
        </div>

        <div className="card p-6 shadow-sm">
          <LoginForm locale={locale} />
        </div>

        <p className="mt-6 text-center text-xs text-ink-400">
          Cashmere Boutique · EGP
        </p>
      </div>
    </main>
  );
}
