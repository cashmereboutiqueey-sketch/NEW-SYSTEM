"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { Icon } from "./icon";
import { navigation, isShipped } from "@/lib/navigation";
import { t, type Locale } from "@/lib/i18n";
import type { EntityScope } from "@/lib/session";

export function Sidebar({
  locale,
  scope,
}: {
  locale: Locale;
  scope: EntityScope;
}) {
  const pathname = usePathname();

  return (
    <nav
      aria-label={t("appName", locale)}
      className="flex h-full w-60 shrink-0 flex-col border-e border-ink-200 bg-white"
    >
      <div className="flex items-center gap-2.5 border-b border-ink-200 px-4 py-3.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink-900 text-sm font-bold text-cashmere-200">
          C
        </span>
        <span className="text-sm font-semibold text-ink-900">
          {t("appName", locale)}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        {navigation.map((section) => {
          const visible = section.items.filter((i) => i.scopes.includes(scope));
          if (visible.length === 0) return null;

          return (
            <div key={section.key} className="mb-4">
              <h2 className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-400">
                {t(section.key, locale)}
              </h2>
              <ul className="space-y-0.5">
                {visible.map((item) => {
                  const shipped = isShipped(item);
                  const active = pathname === item.href;

                  if (!shipped) {
                    return (
                      <li key={item.href}>
                        <span
                          title={`${t("comingInPhase", locale)} ${item.phase}`}
                          className="flex cursor-not-allowed items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm text-ink-300"
                        >
                          <Icon name={item.icon} className="h-4 w-4 shrink-0" />
                          <span className="truncate">{t(item.key, locale)}</span>
                          <span className="ms-auto rounded bg-ink-100 px-1.5 text-[10px] font-medium text-ink-400">
                            P{item.phase}
                          </span>
                        </span>
                      </li>
                    );
                  }

                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        className={clsx(
                          "flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm transition",
                          active
                            ? "bg-ink-900 font-medium text-white"
                            : "text-ink-600 hover:bg-ink-100 hover:text-ink-900",
                        )}
                      >
                        <Icon name={item.icon} className="h-4 w-4 shrink-0" />
                        <span className="truncate">{t(item.key, locale)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
