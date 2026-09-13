"use client";

import { useActionState, useState } from "react";
import { uploadImageAction } from "./actions";
import type { FormState } from "@/components/entity-form";

const empty: FormState = {};

/** Above this a photograph is shrunk in the browser before it is sent. */
const SHRINK_ABOVE_BYTES = 1.5 * 1024 * 1024;
/** Longest edge after shrinking: a till tile and a label, not a print. */
const MAX_EDGE_PX = 2000;

/**
 * A phone photograph, made small enough to send.
 *
 * Photos straight off a phone are routinely 3 to 8MB, and uploads travel as a
 * server action whose body has a hard ceiling — anything over it never reaches
 * the code that would explain the problem, and the page simply falls over.
 * Asking a shop owner to resize a picture before attaching it is asking them
 * to stop using the feature, so the browser does it.
 *
 * Returns the original when shrinking is unavailable or would not help, and
 * lets the server's own size check speak for anything that still is too big.
 */
async function shrinkPhoto(file: File): Promise<File> {
  if (file.size <= SHRINK_ABOVE_BYTES || typeof createImageBitmap !== "function") {
    return file;
  }
  try {
    // from-image, so a portrait taken on a phone is not stored lying down.
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85),
    );
    if (!blob || blob.size >= file.size) return file;

    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", {
      type: "image/jpeg",
    });
  } catch {
    return file;
  }
}

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
  const [shrinking, setShrinking] = useState(false);

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
          onChange={async (e) => {
            // Held before the await: React does not keep the event's target
            // for code that runs after it.
            const input = e.currentTarget;
            const file = input.files?.[0];
            if (!file) {
              setPreview(null);
              return;
            }
            setShrinking(true);
            const ready = await shrinkPhoto(file);
            if (ready !== file) {
              // Put the smaller file in the input, so the form sends it.
              const dt = new DataTransfer();
              dt.items.add(ready);
              input.files = dt.files;
            }
            setShrinking(false);
            setPreview(URL.createObjectURL(ready));
          }}
          className="block w-full text-xs file:me-2 file:rounded-lg file:border-0 file:bg-ink-900 file:px-2.5 file:py-1.5 file:text-xs file:text-white"
        />

        {shrinking && (
          <p className="text-xs text-ink-500">{ar ? "بنصغّر الصورة…" : "Making the photo smaller…"}</p>
        )}

        {preview && !shrinking && (
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
              ? "JPEG أو PNG أو WebP. صور الموبايل الكبيرة بتتصغّر لوحدها."
              : "JPEG, PNG or WebP. Large phone photos are shrunk automatically."}
          </p>
        )}
      </div>
    </form>
  );
}
