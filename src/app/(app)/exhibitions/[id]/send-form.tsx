"use client";

import { useActionState } from "react";
import { sendToExhibitionAction, type ExhibitionState } from "../actions";

const empty: ExhibitionState = {};

type Row = {
  variantId: string;
  sku: string;
  styleName: string;
  size: string;
  colour: string;
  available: string;
  untagged: string;
};

export function SendForm({
  exhibitionId,
  rows,
  ar,
}: {
  exhibitionId: string;
  rows: Row[];
  ar: boolean;
}) {
  const [state, action, pending] = useActionState(sendToExhibitionAction, empty);
  const today = new Date().toISOString().slice(0, 10);

  const sendable = rows.filter((r) => Number(r.available) > 0);

  if (sendable.length === 0) {
    return (
      <p className="py-4 text-sm text-ink-400">
        {ar
          ? "مفيش بضاعة متكوّدة جاهزة تخرج من المكان ده."
          : "There is no tagged stock available to send."}
      </p>
    );
  }

  return (
    <form action={action}>
      <input type="hidden" name="exhibitionId" value={exhibitionId} />

      <div className="mb-3 flex items-center gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-ink-600">{ar ? "تاريخ الخروج" : "Sent on"}</span>
          <input
            type="date"
            name="sendDate"
            defaultValue={today}
            dir="ltr"
            className="rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm outline-none focus:border-ink-500"
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
              <th className="px-2 py-2 text-start font-medium">{ar ? "اللون" : "Colour"}</th>
              <th className="px-2 py-2 text-end font-medium">{ar ? "متاح" : "Available"}</th>
              <th className="px-2 py-2 text-end font-medium">{ar ? "يروح" : "Send"}</th>
            </tr>
          </thead>
          <tbody>
            {sendable.map((r) => (
              <tr key={r.variantId} className="border-b border-ink-100">
                <td className="px-2 py-2 num text-xs" dir="ltr">{r.sku}</td>
                <td className="px-2 py-2">{r.styleName}</td>
                <td className="px-2 py-2">{r.size}</td>
                <td className="px-2 py-2">{r.colour}</td>
                <td className="px-2 py-2 text-end num">
                  {Number(r.available)}
                  {Number(r.untagged) > 0 && (
                    <span className="ms-2 text-xs text-warn">
                      {ar
                        ? `+${Number(r.untagged)} من غير باركود`
                        : `+${Number(r.untagged)} untagged`}
                    </span>
                  )}
                </td>
                <td className="px-2 py-2 text-end">
                  <input
                    type="number"
                    name={`qty_${r.variantId}`}
                    min={0}
                    max={Number(r.available)}
                    step={1}
                    // Deliberately blank: a pre-filled quantity is a quantity
                    // nobody chose.
                    placeholder="0"
                    dir="ltr"
                    className="w-20 rounded-lg border border-ink-200 bg-white px-2 py-1 text-end text-sm outline-none focus:border-ink-500"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? (ar ? "بيتبعت…" : "Sending…") : ar ? "ابعت للبازار" : "Send to bazaar"}
        </button>

        {state.error && <p className="text-sm text-bad">{state.error}</p>}
        {state.success && <p className="text-sm text-good">{state.success}</p>}
      </div>
    </form>
  );
}
