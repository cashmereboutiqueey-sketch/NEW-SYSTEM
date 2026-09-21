"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "./sidebar";
import type { Role } from "@/core/permissions";
import type { Locale } from "@/lib/i18n";
import type { EntityScope } from "@/lib/session";

/**
 * The sidebar on a phone.
 *
 * On a narrow screen the fixed sidebar took a quarter of the width and pushed
 * every table off the edge, which made the marketing screens meant for phones
 * — Today, approvals, uploading a shoot — unusable there. Below `md` it opens
 * from a labelled Menu button instead, and closes itself after navigating.
 */
export function MobileMenu({ locale, scope, role }: { locale: Locale; scope: EntityScope; role: Role }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <div className="md:hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="mobile-menu"
        onClick={() => setOpen((o) => !o)}
        className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm font-medium text-ink-700"
      >
        {locale === "ar" ? "القائمة" : "Menu"}
      </button>
      {open && (
        <div id="mobile-menu" className="fixed inset-0 z-50 flex">
          <div className="h-full shadow-xl">
            <Sidebar locale={locale} scope={scope} role={role} />
          </div>
          <button
            type="button"
            aria-label={locale === "ar" ? "اقفل القائمة" : "Close menu"}
            onClick={() => setOpen(false)}
            className="h-full flex-1 bg-ink-950/40"
          />
        </div>
      )}
    </div>
  );
}
