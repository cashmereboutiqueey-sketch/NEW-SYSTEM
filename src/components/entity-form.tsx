"use client";

import { useActionState } from "react";
import type { Locale } from "@/lib/i18n";

/**
 * The shared shape of a data-entry form.
 *
 * Every master-data screen uses this rather than hand-rolling its own inputs,
 * so validation errors, pending state and the Arabic/English mirroring behave
 * identically everywhere. A form that behaves differently on each screen is
 * how data entry becomes a source of mistakes.
 */

export type FormState = { error?: string; success?: string };

export type Field =
  | {
      kind: "text" | "number" | "date";
      name: string;
      labelEn: string;
      labelAr: string;
      required?: boolean;
      placeholder?: string;
      defaultValue?: string | number | null;
      step?: string;
      min?: string;
      max?: string;
      /** Latin numerals and left-to-right, even in the Arabic layout. */
      ltr?: boolean;
      hintEn?: string;
      hintAr?: string;
      span?: 1 | 2 | 3;
    }
  | {
      kind: "select";
      name: string;
      labelEn: string;
      labelAr: string;
      required?: boolean;
      defaultValue?: string | null;
      options: { value: string; label: string }[];
      emptyLabel?: string;
      hintEn?: string;
      hintAr?: string;
      span?: 1 | 2 | 3;
    }
  | {
      kind: "checkbox";
      name: string;
      labelEn: string;
      labelAr: string;
      defaultChecked?: boolean;
      hintEn?: string;
      hintAr?: string;
      span?: 1 | 2 | 3;
    };

const input =
  "w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 " +
  "focus:border-ink-400 focus:outline-none focus:ring-1 focus:ring-ink-300";
const label = "mb-1 block text-xs font-medium text-ink-600";

export function EntityForm({
  locale,
  action,
  fields,
  hidden,
  submitEn,
  submitAr,
  columns = 3,
}: {
  locale: Locale;
  action: (prev: FormState, data: FormData) => Promise<FormState>;
  fields: Field[];
  hidden?: Record<string, string>;
  submitEn: string;
  submitAr: string;
  columns?: 1 | 2 | 3;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const ar = locale === "ar";
  const text = (en: string, arText: string) => (ar ? arText : en);

  const grid =
    columns === 1 ? "sm:grid-cols-1" : columns === 2 ? "sm:grid-cols-2" : "sm:grid-cols-3";

  return (
    <form action={formAction} className="space-y-4">
      {Object.entries(hidden ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}

      <div className={`grid gap-3 ${grid}`}>
        {fields.map((f) => {
          const span =
            f.span === 3 ? "sm:col-span-3" : f.span === 2 ? "sm:col-span-2" : "";
          const hint = f.hintEn ? text(f.hintEn, f.hintAr ?? f.hintEn) : null;

          if (f.kind === "checkbox") {
            return (
              <label
                key={f.name}
                className={`flex items-center gap-2 self-end pb-2 text-sm ${span}`}
              >
                <input
                  type="checkbox"
                  name={f.name}
                  defaultChecked={f.defaultChecked}
                  className="h-4 w-4 rounded border-ink-300"
                />
                <span>{text(f.labelEn, f.labelAr)}</span>
              </label>
            );
          }

          return (
            <div key={f.name} className={span}>
              <label className={label} htmlFor={f.name}>
                {text(f.labelEn, f.labelAr)}
                {f.required && <span className="ms-1 text-bad">*</span>}
              </label>

              {f.kind === "select" ? (
                <select
                  id={f.name}
                  name={f.name}
                  required={f.required}
                  defaultValue={f.defaultValue ?? ""}
                  className={input}
                >
                  {!f.required && <option value="">{f.emptyLabel ?? "—"}</option>}
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              ) : (
                <input
                  id={f.name}
                  name={f.name}
                  type={f.kind}
                  required={f.required}
                  placeholder={f.placeholder}
                  defaultValue={f.defaultValue ?? undefined}
                  step={f.step}
                  min={f.min}
                  max={f.max}
                  dir={f.ltr ? "ltr" : undefined}
                  className={`${input}${f.ltr ? " num" : ""}`}
                />
              )}

              {hint && <p className="mt-1 text-xs text-ink-400">{hint}</p>}
            </div>
          );
        })}
      </div>

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
        {pending ? text("Saving…", "جارٍ الحفظ…") : text(submitEn, submitAr)}
      </button>
    </form>
  );
}
