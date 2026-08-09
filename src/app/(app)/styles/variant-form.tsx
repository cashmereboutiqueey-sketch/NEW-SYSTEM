"use client";

import { useActionState, useState } from "react";
import { generateVariantsAction } from "./actions";
import type { FormState } from "@/components/entity-form";
import type { Locale } from "@/lib/i18n";

const initial: FormState = {};

/**
 * Builds the SKUs for a style.
 *
 * Colours and sizes are picked as sets and every combination is generated,
 * because that is how a garment range is actually decided — "this dress in
 * black and cream, medium to extra large" — not one SKU at a time.
 */
export function VariantForm({
  locale,
  styleId,
  styleCode,
  colours,
  sizes,
  existing,
}: {
  locale: Locale;
  styleId: string;
  styleCode: string;
  colours: { id: string; code: string; nameEn: string; nameAr: string; hex: string | null }[];
  sizes: { id: string; code: string; nameEn: string; nameAr: string }[];
  existing: Set<string>;
}) {
  const [state, formAction, pending] = useActionState(generateVariantsAction, initial);
  const [pickedColours, setPickedColours] = useState<string[]>([]);
  const [pickedSizes, setPickedSizes] = useState<string[]>([]);
  const ar = locale === "ar";

  const toggle = (list: string[], set: (v: string[]) => void, id: string) =>
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const chosenColours = colours.filter((c) => pickedColours.includes(c.id));
  const chosenSizes = sizes.filter((s) => pickedSizes.includes(s.id));

  // Shown before anything is written, so the range is checked before it is
  // created rather than after.
  const preview = chosenColours.flatMap((c) =>
    chosenSizes.map((s) => ({
      sku: `${styleCode}-${c.code}-${s.code}`,
      isNew: !existing.has(`${styleCode}-${c.code}-${s.code}`),
    })),
  );
  const newCount = preview.filter((p) => p.isNew).length;

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="styleId" value={styleId} />
      {pickedColours.map((id) => (
        <input key={id} type="hidden" name="colorCodeIds" value={id} />
      ))}
      {pickedSizes.map((id) => (
        <input key={id} type="hidden" name="sizeCodeIds" value={id} />
      ))}

      <div>
        <p className="mb-1.5 text-xs font-medium text-ink-600">
          {ar ? "الألوان" : "Colours"}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {colours.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => toggle(pickedColours, setPickedColours, c.id)}
              className={
                "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm " +
                (pickedColours.includes(c.id)
                  ? "border-ink-900 bg-ink-900 text-white"
                  : "border-ink-200 text-ink-700")
              }
            >
              {c.hex && (
                <span
                  aria-hidden
                  className="h-3 w-3 rounded-full border border-ink-300"
                  style={{ backgroundColor: c.hex }}
                />
              )}
              {ar ? c.nameAr : c.nameEn}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-1.5 text-xs font-medium text-ink-600">
          {ar ? "المقاسات" : "Sizes"}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {sizes.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => toggle(pickedSizes, setPickedSizes, s.id)}
              className={
                "rounded-lg border px-3 py-1.5 text-sm " +
                (pickedSizes.includes(s.id)
                  ? "border-ink-900 bg-ink-900 text-white"
                  : "border-ink-200 text-ink-700")
              }
            >
              {s.code}
            </button>
          ))}
        </div>
      </div>

      {preview.length > 0 && (
        <div className="rounded-lg border border-ink-200 bg-ink-50/50 p-3">
          <p className="mb-2 text-xs text-ink-600">
            {ar
              ? `${preview.length} تركيبة — منها ${newCount} جديدة`
              : `${preview.length} combinations — ${newCount} of them new`}
          </p>
          <div className="flex flex-wrap gap-1">
            {preview.slice(0, 24).map((p) => (
              <code
                key={p.sku}
                dir="ltr"
                className={
                  "rounded px-1.5 py-0.5 text-xs " +
                  (p.isNew ? "bg-white text-ink-700" : "bg-ink-100 text-ink-400 line-through")
                }
              >
                {p.sku}
              </code>
            ))}
            {preview.length > 24 && (
              <span className="text-xs text-ink-400">
                +{preview.length - 24} {ar ? "أخرى" : "more"}
              </span>
            )}
          </div>
        </div>
      )}

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
        disabled={pending || newCount === 0}
        className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
      >
        {pending
          ? (ar ? "جارٍ الإنشاء…" : "Creating…")
          : ar
            ? `أنشئ ${newCount} كود`
            : `Create ${newCount} SKUs`}
      </button>
    </form>
  );
}
