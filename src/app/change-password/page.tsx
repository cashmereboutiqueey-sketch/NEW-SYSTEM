import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getPrefs } from "@/lib/session";
import { db } from "@/lib/db";
import { ChangePasswordForm } from "./form";

/**
 * Replacing a password somebody else chose.
 *
 * Deliberately outside the application shell. A person who has not yet made
 * the password their own should not be looking at the business while they do
 * it, and putting this inside the shell would mean the shell's own guard sent
 * them here again on every render.
 */
export default async function ChangePasswordPage() {
  const user = await requireUser();
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const account = await db.user.findUnique({
    where: { id: user.userId },
    select: { mustChangePassword: true },
  });

  // Reachable on purpose by somebody who simply wants to change theirs, but
  // there is nothing to say to a person who arrived here by accident.
  const forced = account?.mustChangePassword ?? false;

  return (
    <main className="flex min-h-screen items-center justify-center bg-ink-100 p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-lg font-semibold text-ink-900">
            {ar ? "غيّر كلمة السر" : "Change your password"}
          </h1>
          <p className="mt-1 text-sm text-ink-500">
            {forced
              ? ar
                ? "الباسورد اللي معاك حد تاني عارفه، فمش هتقدر تدخل قبل ما تغيّره."
                : "Somebody else chose this password, so it is not yours yet."
              : ar
                ? `مسجّل باسم ${user.name}`
                : `Signed in as ${user.name}`}
          </p>
        </div>

        <div className="card p-6 shadow-sm">
          <ChangePasswordForm ar={ar} forced={forced} />
        </div>

        {!forced && (
          <p className="mt-6 text-center text-sm">
            <a href="/" className="text-ink-500 underline">
              {ar ? "رجوع" : "Back"}
            </a>
          </p>
        )}
      </div>
    </main>
  );
}
