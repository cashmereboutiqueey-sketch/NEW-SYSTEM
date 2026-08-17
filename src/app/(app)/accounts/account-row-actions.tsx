"use client";

import { useActionState, useState } from "react";
import { updateAccountAction } from "./actions";
import type { FormState } from "@/components/entity-form";

const empty: FormState = {};

/**
 * Changing an account after it exists.
 *
 * The code, the type and the normal balance are absent on purpose — changing
 * a type would silently restate every report that has ever included the
 * account, and the entries already posted would come to mean something
 * different from what they meant when they were posted.
 *
 * What can change is the name, whether it still accepts postings, and which
 * cost pools it feeds. The last of those is the consequential one: moving an
 * account into the minute rate changes what every garment made afterwards is
 * costed at, so it says so rather than looking like a tick box.
 */
export function AccountRowActions({
  ar,
  id,
  code,
  nameAr,
  nameEn,
  isActive,
  postings,
  includeInMinuteRate,
  includeInBrandFixedPool,
}: {
  ar: boolean;
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  isActive: boolean;
  postings: number;
  includeInMinuteRate: boolean;
  includeInBrandFixedPool: boolean;
}) {
  const [state, action, pending] = useActionState(updateAccountAction, empty);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded border border-ink-200 px-2 py-0.5 text-[11px] text-ink-600 hover:border-ink-400"
      >
        {ar ? "عدّل" : "Edit"}
      </button>
    );
  }

  return (
    <form action={action} className="min-w-[18rem] space-y-2 py-1">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="poolFlags" value="1" />

      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-[11px] text-ink-500" htmlFor={`ar-${id}`}>
            {ar ? "الاسم بالعربي" : "Arabic name"}
          </label>
          <input
            id={`ar-${id}`} name="nameAr" defaultValue={nameAr}
            className="w-full rounded border border-ink-200 px-2 py-1 text-xs"
          />
        </div>
        <div>
          <label className="mb-1 block text-[11px] text-ink-500" htmlFor={`en-${id}`}>
            {ar ? "الاسم بالإنجليزي" : "English name"}
          </label>
          <input
            id={`en-${id}`} name="nameEn" defaultValue={nameEn}
            className="w-full rounded border border-ink-200 px-2 py-1 text-xs"
          />
        </div>
      </div>

      <label className="flex items-start gap-2 text-[11px]">
        <input
          type="checkbox" name="includeInMinuteRate"
          defaultChecked={includeInMinuteRate} className="mt-0.5"
        />
        <span>
          {ar ? "يدخل في تكلفة الدقيقة" : "Feeds the minute rate"}
          <span className="block text-ink-400">
            {ar
              ? "بيغيّر تكلفة كل قطعة تتصنّع بعد كده."
              : "Changes what every garment made afterwards is costed at."}
          </span>
        </span>
      </label>

      <label className="flex items-start gap-2 text-[11px]">
        <input
          type="checkbox" name="includeInBrandFixedPool"
          defaultChecked={includeInBrandFixedPool} className="mt-0.5"
        />
        <span>
          {ar ? "من مصاريف البراند الثابتة" : "Brand fixed cost"}
          <span className="block text-ink-400">
            {ar ? "بيدخل في نقطة التعادل والتسعير." : "Feeds break-even and pricing."}
          </span>
        </span>
      </label>

      {state.error && <p className="text-xs text-bad">{state.error}</p>}
      {state.success && <p className="text-xs text-good">{state.success}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-ink-900 px-2.5 py-1 text-[11px] text-white disabled:opacity-50"
        >
          {pending ? (ar ? "بيتحفظ…" : "Saving…") : ar ? "احفظ" : "Save"}
        </button>

        <button
          type="submit"
          name="retire"
          value={isActive ? "retire" : "activate"}
          disabled={pending}
          className="rounded border border-ink-300 px-2.5 py-1 text-[11px] text-ink-700 disabled:opacity-50"
        >
          {isActive ? (ar ? "أوقف الحساب" : "Retire") : ar ? "رجّعه" : "Reinstate"}
        </button>

        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded border border-ink-200 px-2.5 py-1 text-[11px] text-ink-500"
        >
          {ar ? "إلغاء" : "Cancel"}
        </button>
      </div>

      {isActive && postings > 0 && (
        <p className="text-[11px] text-ink-400">
          {ar
            ? `عليه ${postings} حركة، فمش هيتمسح — هيتوقف بس عن استقبال قيود جديدة.`
            : `${postings} postings refer to ${code}, so it is never deleted — retiring only stops new ones.`}
        </p>
      )}
    </form>
  );
}
