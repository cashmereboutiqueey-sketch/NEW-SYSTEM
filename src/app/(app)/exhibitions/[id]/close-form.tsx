"use client";

import { useActionState, useState } from "react";
import { closeExhibitionAction, type ExhibitionState } from "../actions";

const empty: ExhibitionState = {};

type Row = {
  variantId: string;
  sku: string;
  styleName: string;
  size: string;
  colour: string;
  expected: string;
  unitCost: string;
};

/**
 * The count sheet.
 *
 * The counted boxes start blank rather than pre-filled with what the books
 * expect. A screen that fills in the expected number and asks somebody to
 * confirm it gets confirmed without anybody opening a box, which is precisely
 * the failure this whole feature exists to prevent.
 *
 * The shortfall is shown live as they type, because a number that only appears
 * after submitting is a number nobody checked.
 */
export function CloseForm({
  exhibitionId,
  rows,
  approvers,
  threshold,
  ar,
}: {
  exhibitionId: string;
  rows: Row[];
  approvers: { id: string; name: string }[];
  threshold: string;
  ar: boolean;
}) {
  const [state, action, pending] = useActionState(closeExhibitionAction, empty);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const today = new Date().toISOString().slice(0, 10);

  let missingQty = 0;
  let missingValue = 0;
  for (const r of rows) {
    const typed = counts[r.variantId];
    // Untouched lines are treated as uncounted, which the server records as
    // missing. Showing it that way here keeps the two ends honest.
    const counted = typed === undefined || typed === "" ? 0 : Number(typed);
    const gap = Number(r.expected) - counted;
    if (gap > 0) {
      missingQty += gap;
      missingValue += gap * Number(r.unitCost);
    }
  }

  const needsApproval = missingValue > Number(threshold);

  if (rows.length === 0) {
    return (
      <form action={action} className="flex items-center gap-3">
        <input type="hidden" name="exhibitionId" value={exhibitionId} />
        <input type="hidden" name="closeDate" value={today} />
        <p className="text-sm text-ink-500">
          {ar
            ? "مفيش بضاعة على الاستاند، فالقفل هنا إجراء شكلي."
            : "There is nothing on the stand, so closing is a formality."}
        </p>
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {ar ? "اقفل" : "Close"}
        </button>
        {state.error && <p className="text-sm text-bad">{state.error}</p>}
        {state.success && <p className="text-sm text-good">{state.success}</p>}
      </form>
    );
  }

  return (
    <form action={action}>
      <input type="hidden" name="exhibitionId" value={exhibitionId} />

      <div className="mb-3">
        <label className="text-sm">
          <span className="mb-1 block text-ink-600">{ar ? "تاريخ القفل" : "Closed on"}</span>
          <input
            type="date"
            name="closeDate"
            defaultValue={today}
            dir="ltr"
            className="rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep"
          />
        </label>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-200 text-ink-500">
              <th className="px-2 py-2 text-start font-medium">SKU</th>
              <th className="px-2 py-2 text-start font-medium">{ar ? "الموديل" : "Style"}</th>
              <th className="px-2 py-2 text-start font-medium">{ar ? "المقاس" : "Size"}</th>
              <th className="px-2 py-2 text-end font-medium">{ar ? "المفروض" : "Expected"}</th>
              <th className="px-2 py-2 text-end font-medium">{ar ? "عدّيت كام" : "Counted"}</th>
              <th className="px-2 py-2 text-end font-medium">{ar ? "الفرق" : "Gap"}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const typed = counts[r.variantId];
              const counted = typed === undefined || typed === "" ? null : Number(typed);
              const gap = counted === null ? null : counted - Number(r.expected);
              return (
                <tr key={r.variantId} className="border-b border-ink-100">
                  <td className="px-2 py-2 num text-xs" dir="ltr">{r.sku}</td>
                  <td className="px-2 py-2">{r.styleName}</td>
                  <td className="px-2 py-2">{r.size}</td>
                  <td className="px-2 py-2 text-end num">{Number(r.expected)}</td>
                  <td className="px-2 py-2 text-end">
                    <input
                      type="number"
                      name={`count_${r.variantId}`}
                      min={0}
                      step={1}
                      value={typed ?? ""}
                      onChange={(e) =>
                        setCounts((c) => ({ ...c, [r.variantId]: e.target.value }))
                      }
                      placeholder="—"
                      dir="ltr"
                      className="w-20 rounded-lg border border-ink-200 bg-panel px-2 py-1 text-end text-sm outline-none focus:border-rose-deep"
                    />
                  </td>
                  <td className="px-2 py-2 text-end num">
                    {gap === null ? (
                      <span className="text-ink-300">—</span>
                    ) : gap === 0 ? (
                      <span className="text-good">0</span>
                    ) : (
                      <span className={gap < 0 ? "text-bad" : "text-warn"}>
                        {gap > 0 ? `+${gap}` : gap}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {missingQty > 0 && (
        <p className="mt-3 rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">
          {ar
            ? `ناقص ${missingQty} قطعة بتكلفة ${missingValue.toFixed(2)} جنيه — هتتقيد خسارة.`
            : `${missingQty} pieces missing, costing ${missingValue.toFixed(2)} — this will be written off.`}
        </p>
      )}

      {needsApproval && (
        <label className="mt-3 block text-sm">
          <span className="mb-1 block text-ink-600">
            {ar
              ? `النقص أكبر من حد الـ ${Number(threshold).toFixed(0)} جنيه، فمحتاج حد تاني يوافق`
              : `The shortfall is over the ${Number(threshold).toFixed(0)} limit and needs a second approver`}
          </span>
          <select
            name="approvedByUserId"
            required
            className="rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep"
          >
            <option value="">{ar ? "اختار حد" : "Choose"}</option>
            {approvers.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="mt-3 block text-sm">
        <span className="mb-1 block text-ink-600">{ar ? "ملاحظات" : "Notes"}</span>
        <input
          name="notes"
          placeholder={ar ? "حصل إيه؟" : "What happened?"}
          className="w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep"
        />
      </label>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending
            ? ar ? "بيتقفل…" : "Closing…"
            : ar ? "اقفل وسوّي" : "Close and reconcile"}
        </button>

        {state.error && <p className="text-sm text-bad">{state.error}</p>}
        {state.success && <p className="text-sm text-good">{state.success}</p>}
      </div>
    </form>
  );
}
