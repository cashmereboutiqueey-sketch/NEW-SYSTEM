import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { t } from "@/lib/i18n";
import { Sidebar } from "@/components/sidebar";
import { EntitySwitcher } from "@/components/entity-switcher";
import { LocaleToggle } from "@/components/locale-toggle";
import { Icon } from "@/components/icon";
import { logoutAction } from "../actions";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  // Somebody handed this person their password — a new account, or a reset.
  // Nothing in here is reachable until they replace it, because a password
  // two people know makes the name on every journal line a guess.
  //
  // Checked here rather than in `requireUser` so /change-password, which sits
  // outside this layout, can still be reached; guarding it there would send
  // the user in a circle.
  const account = await db.user.findUnique({
    where: { id: user.userId },
    select: { mustChangePassword: true },
  });
  if (account?.mustChangePassword) redirect("/change-password");

  const { locale, scope } = await getPrefs();

  return (
    <div className="app-shell flex h-screen overflow-hidden bg-cream">
      <Sidebar locale={locale} scope={scope} />

      <div className="app-column flex min-w-0 flex-1 flex-col">
        {/* app-header is what print.css hides. Without it the person signed in
            prints across the top of every garment label and invoice. */}
        <header className="app-header flex items-center gap-3 border-b border-ink-200 bg-panel px-5 py-3">
          <EntitySwitcher current={scope} locale={locale} />

          <div className="ms-auto flex items-center gap-3">
            <LocaleToggle locale={locale} />

            <div className="flex items-center gap-2 border-s border-ink-200 ps-3">
              <div className="text-end leading-tight">
                <p className="text-sm font-medium text-ink-800">{user.name}</p>
                <p className="text-[11px] text-ink-400">{user.role}</p>
              </div>
              <form action={logoutAction}>
                <button
                  type="submit"
                  title={t("signOut", locale)}
                  className="rounded-lg p-2 text-ink-400 transition hover:bg-ink-100 hover:text-ink-700"
                >
                  <Icon name="logout" className="h-4 w-4 flip-rtl" />
                </button>
              </form>
            </div>
          </div>
        </header>

        <main className="app-main flex-1 overflow-y-auto p-5">{children}</main>
      </div>
    </div>
  );
}
