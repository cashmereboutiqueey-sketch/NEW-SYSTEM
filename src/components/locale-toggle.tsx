"use client";

import { useTransition } from "react";
import { setLocaleAction } from "@/app/actions";
import { Icon } from "./icon";
import type { Locale } from "@/lib/i18n";

export function LocaleToggle({ locale }: { locale: Locale }) {
  const [pending, startTransition] = useTransition();
  const next: Locale = locale === "ar" ? "en" : "ar";

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        const data = new FormData();
        data.set("locale", next);
        startTransition(() => {
          void setLocaleAction(data);
        });
      }}
      title={next === "ar" ? "العربية" : "English"}
      className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs font-medium text-ink-600 transition hover:bg-ink-100 disabled:opacity-60"
    >
      <Icon name="globe" className="h-3.5 w-3.5" />
      {next === "ar" ? "ع" : "EN"}
    </button>
  );
}
