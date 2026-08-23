"use client";

import { useActionState } from "react";
import { openExhibitionAction, type ExhibitionState } from "./actions";

const empty: ExhibitionState = {};

export function OpenExhibitionForm({
  sources,
  ar,
}: {
  sources: { id: string; name: string }[];
  ar: boolean;
}) {
  const [state, action, pending] = useActionState(openExhibitionAction, empty);

  const today = new Date().toISOString().slice(0, 10);
  const inThree = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);

  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <label className="text-sm">
        <span className="mb-1 block text-ink-600">{ar ? "اسم البازار" : "Name"}</span>
        <input
          name="nameAr"
          required
          placeholder={ar ? "بازار الساحل" : "North Coast Bazaar"}
          className="w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep"
        />
      </label>

      <label className="text-sm">
        <span className="mb-1 block text-ink-600">
          {ar ? "الاسم بالإنجليزي" : "English name"}
        </span>
        <input
          name="nameEn"
          dir="ltr"
          className="w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep"
        />
      </label>

      <label className="text-sm">
        <span className="mb-1 block text-ink-600">{ar ? "المكان" : "City"}</span>
        <input
          name="city"
          className="w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep"
        />
      </label>

      <label className="text-sm">
        <span className="mb-1 block text-ink-600">
          {ar ? "البضاعة هتخرج من" : "Stock comes from"}
        </span>
        <select
          name="parentLocationId"
          required
          className="w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep"
        >
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>

      <label className="text-sm">
        <span className="mb-1 block text-ink-600">{ar ? "يفتح يوم" : "Opens"}</span>
        <input
          type="date"
          name="opensAt"
          defaultValue={today}
          required
          dir="ltr"
          className="w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep"
        />
      </label>

      <label className="text-sm">
        <span className="mb-1 block text-ink-600">{ar ? "يقفل يوم" : "Closes"}</span>
        <input
          type="date"
          name="closesAt"
          defaultValue={inThree}
          required
          dir="ltr"
          className="w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep"
        />
      </label>

      <div className="sm:col-span-2 lg:col-span-3 flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? (ar ? "بيفتح…" : "Opening…") : ar ? "افتح البازار" : "Open bazaar"}
        </button>

        {state.error && <p className="text-sm text-bad">{state.error}</p>}
        {state.success && <p className="text-sm text-good">{state.success}</p>}
      </div>
    </form>
  );
}
