"use client";

import { useActionState, useState } from "react";
import { importMetaCsvAction } from "./actions";
import type { FormState } from "@/components/entity-form";
import type { Locale } from "@/lib/i18n";

const initial: FormState = {};

/**
 * Brings Meta spend in without waiting for API approval.
 *
 * Meta's Marketing API needs a reviewed app and a permission that can take
 * weeks to be granted, so the export is the path that works today. The file
 * is read in the browser and posted as text, which keeps the flow the same
 * whether it arrives from a file or a paste.
 */
export function MetaImportForm({ locale }: { locale: Locale }) {
  const [state, formAction, pending] = useActionState(importMetaCsvAction, initial);
  const [fileName, setFileName] = useState<string | null>(null);
  const ar = locale === "ar";

  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label
          htmlFor="meta-file"
          className="flex cursor-pointer items-center justify-center rounded-xl border border-dashed border-ink-300 px-4 py-6 text-sm text-ink-600 hover:border-ink-400"
        >
          {fileName ?? (ar ? "اختر ملف التقرير من Meta (CSV)" : "Choose the Meta report file (CSV)")}
        </label>
        <input
          id="meta-file"
          name="file"
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
        />
      </div>

      <details className="text-sm">
        <summary className="cursor-pointer text-ink-600">
          {ar ? "أو الصق محتوى التقرير" : "Or paste the report instead"}
        </summary>
        <textarea
          name="csv"
          rows={5}
          dir="ltr"
          placeholder="Campaign name,Day,Amount spent,Impressions,Link clicks"
          className="mt-2 w-full rounded-lg border border-ink-200 px-3 py-2 font-mono text-xs"
        />
      </details>

      <p className="text-xs text-ink-500">
        {ar
          ? "الحملة بتتطابق بالاسم بالظبط زي ما هو في Meta. اسم مش موجود بيتقال لك بدل ما يتعمل حملة جديدة بالغلط."
          : "Campaigns are matched by their exact Meta name. An unrecognised name is reported rather than created, so a typo does not split one campaign's spend in two."}
      </p>

      {state.error && (
        <p role="alert" className="rounded-lg bg-bad/10 px-3 py-2 text-sm text-bad">
          {state.error}
        </p>
      )}
      {state.success && (
        <p role="status" className="rounded-lg bg-good/10 px-3 py-2 text-sm text-good">
          {state.success}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? (ar ? "جارٍ الاستيراد…" : "Importing…") : (ar ? "استورد الإنفاق" : "Import spend")}
      </button>
    </form>
  );
}
