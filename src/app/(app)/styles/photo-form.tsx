"use client";

import { useActionState, useState } from "react";
import { uploadImageAction } from "./actions";
import type { FormState } from "@/components/entity-form";

const empty: FormState = {};

/**
 * The photograph the till shows.
 *
 * A preview appears before anything is uploaded, because the most common
 * mistake with a product photo is attaching the wrong file, and finding that
 * out on the shop floor is expensive.
 */
export function PhotoForm({
  ar,
  styleId,
  variantId,
  current,
  label,
  compact,
}: {
  ar: boolean;
  styleId?: string;
  variantId?: string;
  current: string | null;
  label?: string;
  compact?: boolean;
}) {
  const [state, action, pending] = useActionState(uploadImageAction, empty);
  const [preview, setPreview] = useState<string | null>(null);

  const shown = preview ?? current;

  return (
    <form action={action} className={compact ? "flex items-center gap-2" : "space-y-2"}>
      {styleId && <input type="hidden" name="styleId" value={styleId} />}
      {variantId && <input type="hidden" name="variantId" value={variantId} />}

      <div
        className={
          compact
            ? "h-12 w-9 shrink-0 overflow-hidden rounded border border-ink-200 bg-ink-100"
            : "aspect-[3/4] w-40 overflow-hidden rounded-lg border border-ink-200 bg-ink-100"
        }
      >
        {shown ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={shown} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[10px] text-ink-300">
            {ar ? "مفيش صورة" : "no photo"}
          </div>
        )}
      </div>

      <div className={compact ? "" : "space-y-2"}>
        {label && !compact && (
          <p className="text-xs text-ink-600">{label}</p>
        )}

        <input
          type="file"
          name="photo"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => {
            const file = e.target.files?.[0];
            setPreview(file ? URL.createObjectURL(file) : null);
          }}
          className="block w-full text-xs file:me-2 file:rounded-lg file:border-0 file:bg-ink-900 file:px-2.5 file:py-1.5 file:text-xs file:text-white"
        />

        {preview && (
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-ink-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {pending ? (ar ? "بيترفع…" : "Uploading…") : ar ? "احفظ الصورة" : "Save photo"}
          </button>
        )}

        {state.error && <p className="text-xs text-bad">{state.error}</p>}
        {state.success && <p className="text-xs text-good">{state.success}</p>}

        {!compact && (
          <p className="text-[11px] text-ink-400">
            {ar
              ? "JPEG أو PNG أو WebP، لحد 5 ميجا."
              : "JPEG, PNG or WebP, up to 5MB."}
          </p>
        )}
      </div>
    </form>
  );
}
