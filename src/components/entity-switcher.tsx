"use client";

import { useTransition } from "react";
import clsx from "clsx";
import { setEntityScopeAction } from "@/app/actions";
import { t, type Locale } from "@/lib/i18n";
import type { EntityScope } from "@/lib/session";

const OPTIONS: { scope: EntityScope; key: "factory" | "brand" | "group" }[] = [
  { scope: "FACTORY", key: "factory" },
  { scope: "BRAND", key: "brand" },
  { scope: "GROUP", key: "group" },
];

/**
 * The entity lens. Everything downstream — navigation, reports, totals — is
 * scoped by this. Factory and Brand are separate books; Group shows both with
 * intercompany transactions eliminated.
 */
export function EntitySwitcher({
  current,
  locale,
}: {
  current: EntityScope;
  locale: Locale;
}) {
  const [pending, startTransition] = useTransition();

  function select(scope: EntityScope) {
    if (scope === current) return;
    const data = new FormData();
    data.set("scope", scope);
    startTransition(() => {
      void setEntityScopeAction(data);
    });
  }

  return (
    <div
      role="group"
      aria-label={t("switchEntity", locale)}
      className={clsx(
        "inline-flex rounded-lg border border-ink-200 bg-ink-100 p-0.5",
        pending && "opacity-60",
      )}
    >
      {OPTIONS.map((opt) => {
        const active = opt.scope === current;
        return (
          <button
            key={opt.scope}
            type="button"
            onClick={() => select(opt.scope)}
            aria-pressed={active}
            className={clsx(
              "rounded-[6px] px-3 py-1.5 text-sm font-medium transition",
              active
                ? "bg-white text-ink-900 shadow-sm"
                : "text-ink-500 hover:text-ink-800",
            )}
          >
            {t(opt.key, locale)}
          </button>
        );
      })}
    </div>
  );
}
