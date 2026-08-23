"use client";

import { useActionState, useState } from "react";
import type { FormState } from "@/components/entity-form";

const empty: FormState = {};
const field =
  "w-full rounded-lg border border-ink-200 bg-panel px-2 py-1.5 text-sm outline-none focus:border-rose-deep";

export type InlineField = {
  name: string;
  label: string;
  type?: "text" | "number" | "select";
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
  step?: string;
  min?: string;
  options?: { value: string; label: string }[];
  /** Sits beside its neighbour rather than on its own row. */
  half?: boolean;
  hint?: string;
};

/**
 * Adding the thing that is not in the list.
 *
 * Cost categories, colours, sizes and units were seeded once and had no way in
 * afterwards, so anybody who needed one that did not exist simply stopped —
 * or filed what they were doing under the nearest wrong heading, which is how
 * a cost pool quietly stops meaning anything.
 *
 * It opens where the person is standing rather than sending them to a
 * settings page, because whatever they were filling in does not survive the
 * trip. Once added, `revalidatePath` re-renders the list around it and the new
 * value is selectable in the same breath.
 *
 * Deliberately its own form, placed beside the one it feeds rather than
 * inside it: nesting forms is invalid HTML and submits the wrong one.
 */
export function AddInline({
  ar,
  title,
  fields,
  action,
  hidden,
  label,
}: {
  ar: boolean;
  title: string;
  fields: InlineField[];
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  /** Values the form needs but nobody types, such as which entity. */
  hidden?: Record<string, string>;
  label?: string;
}) {
  const [state, submit, pending] = useActionState(action, empty);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-ink-300 px-2.5 py-1 text-xs font-medium text-ink-700"
      >
        {label ?? (ar ? "+ ضيف" : "+ Add")}
      </button>
    );
  }

  return (
    <form action={submit} className="rounded-lg border border-ink-300 bg-panel p-3">
      <p className="mb-2 text-xs font-medium text-ink-700">{title}</p>

      {Object.entries(hidden ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}

      <div className="grid gap-2 sm:grid-cols-2">
        {fields.map((f) => (
          <label
            key={f.name}
            className={"block text-xs " + (f.half ? "" : "sm:col-span-2")}
          >
            <span className="mb-1 block text-ink-500">{f.label}</span>

            {f.type === "select" ? (
              <select
                name={f.name}
                required={f.required}
                defaultValue={f.defaultValue}
                className={field}
              >
                {(f.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                name={f.name}
                type={f.type === "number" ? "number" : "text"}
                required={f.required}
                placeholder={f.placeholder}
                defaultValue={f.defaultValue}
                step={f.step}
                min={f.min}
                dir={f.type === "number" ? "ltr" : undefined}
                className={field}
              />
            )}

            {f.hint && <span className="mt-0.5 block text-[11px] text-ink-400">{f.hint}</span>}
          </label>
        ))}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-ink-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {pending ? "…" : ar ? "ضيف" : "Add"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-ink-500">
          {ar ? "رجوع" : "Back"}
        </button>
      </div>

      {state.error && <p className="mt-2 text-xs text-bad">{state.error}</p>}
      {state.success && <p className="mt-2 text-xs text-good">{state.success}</p>}
    </form>
  );
}
