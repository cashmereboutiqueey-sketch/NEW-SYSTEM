"use client";

import { useActionState, useState } from "react";
import { RequestIdField } from "@/components/request-id";
import { previewAction, commitAction, type OpeningState } from "./actions";
import type { FormState } from "@/components/entity-form";
import { OPENING_TEMPLATE_HEADER } from "@/core/opening-balance";

const emptyPreview: OpeningState = {};
const empty: FormState = {};
const field =
  "w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep";

type Typed = { kind: string; code: string; location: string; quantity: string; unitCost: string };

const blank = (): Typed => ({ kind: "GARMENT", code: "", location: "", quantity: "", unitCost: "" });

/**
 * Counting what is already there, before anything is written.
 *
 * Two ways in, because a stocktake produces both: a spreadsheet for the
 * hundreds of lines somebody walked the rails with, and a few typed rows for
 * what turns up in a cupboard afterwards. They meet at the same preview, so
 * the second is checked exactly as hard as the first.
 *
 * Nothing posts on this screen. The preview is where a wrong file is caught,
 * because after posting it is a journal entry and putting that right is a
 * reversal rather than an edit.
 */
export function OpeningForm({
  ar,
  entities,
  locations,
  template,
}: {
  ar: boolean;
  entities: { id: string; label: string }[];
  locations: { code: string; label: string; entityId: string }[];
  /** A file already filled with every code the shop has, so nothing is typed twice. */
  template: string;
}) {
  const [state, action, pending] = useActionState(previewAction, emptyPreview);
  const [commit, commitFormAction, committing] = useActionState(commitAction, empty);

  const [text, setText] = useState("");
  const [filename, setFilename] = useState("");
  const [rows, setRows] = useState<Typed[]>([blank()]);
  const [ratio, setRatio] = useState("40");
  const today = new Date().toISOString().slice(0, 10);

  const setRow = (i: number, patch: Partial<Typed>) =>
    setRows((prev) => prev.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  const typed = rows.filter((r) => r.code.trim() && r.quantity.trim());
  const p = state.preview;

  return (
    <div className="space-y-4">
      <form action={action} className="space-y-4">
        <RequestIdField state={state} />
        <input type="hidden" name="text" value={text} />
        <input type="hidden" name="filename" value={filename} />
        <input type="hidden" name="rows" value={text.trim() ? "" : JSON.stringify(typed)} />

        <div className="grid gap-3 lg:grid-cols-4">
          <label className="text-sm">
            <span className="mb-1 block text-ink-600">{ar ? "دفاتر مين" : "Whose books"}</span>
            <select name="entityId" required className={field}>
              {entities.map((e) => (
                <option key={e.id} value={e.id}>{e.label}</option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-ink-600">{ar ? "بتاريخ" : "As at"}</span>
            <input name="asOfDate" type="date" defaultValue={today} required className={field} dir="ltr" />
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-ink-600">
              {ar ? "التكلفة ≈ % من سعر البيع" : "Cost ≈ % of the selling price"}
            </span>
            <input
              name="retailCostRatio" type="number" min={1} max={100} step="1"
              value={ratio} onChange={(e) => setRatio(e.target.value)}
              className={field} dir="ltr"
            />
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-ink-600">{ar ? "ملاحظة" : "Note"}</span>
            <input name="notes" className={field} placeholder={ar ? "جرد يوم كذا" : "Stocktake of…"} />
          </label>
        </div>

        <p className="rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">
          {ar
            ? "لو كتبت التكلفة في الملف، بتتاخد زي ما هي. لو سبتها فاضية، النظام بيدوّر على آخر تكلفة اتحسبت للموديل، ولو مالقاش بيقدّرها من سعر البيع بالنسبة اللي فوق — وبيعلّم السطر إن ده تقدير."
            : "A cost typed in the file is used as it stands. Left blank, the last costing for that style is used; failing that it is estimated from the selling price at the ratio above — and the line is marked as an estimate."}
        </p>

        {/* ------------------------------------------------------- the file */}
        <div className="rounded-lg border border-ink-200 p-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <span className="mb-1 block text-xs text-ink-600">{ar ? "ملف الجرد" : "The counted file"}</span>
              <input
                type="file"
                accept=".csv,.txt,text/csv,text/plain"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setText(await file.text());
                  setFilename(file.name);
                }}
                className="block text-xs file:me-2 file:rounded-lg file:border-0 file:bg-ink-900 file:px-2.5 file:py-1.5 file:text-xs file:text-white"
              />
            </div>
            <a
              href={`data:text/csv;charset=utf-8,${encodeURIComponent(template)}`}
              download="opening-stock.csv"
              className="rounded-lg border border-ink-200 px-3 py-2 text-xs text-ink-700"
            >
              {ar ? "نزّل قالب بكل أكوادك" : "Download a template with every code"}
            </a>
            {filename && (
              <span className="text-xs text-good">
                {ar ? "اتحمّل" : "loaded"} <span dir="ltr">{filename}</span>
              </span>
            )}
          </div>
          <p className="mt-2 text-xs text-ink-500" dir="ltr">
            {OPENING_TEMPLATE_HEADER}
          </p>
        </div>

        {/* ------------------------------------------------------ typed rows */}
        {!text.trim() && (
          <div className="rounded-lg border border-ink-200 p-3">
            <p className="mb-2 text-xs text-ink-600">
              {ar ? "أو اكتبهم هنا سطر سطر" : "Or type them a line at a time"}
            </p>
            <div className="space-y-2">
              {rows.map((r, i) => (
                <div key={i} className="flex flex-wrap items-end gap-2">
                  <select
                    value={r.kind}
                    onChange={(e) => setRow(i, { kind: e.target.value })}
                    className={`${field} w-28`}
                  >
                    <option value="GARMENT">{ar ? "قطعة" : "Garment"}</option>
                    <option value="FABRIC">{ar ? "خامة" : "Fabric"}</option>
                  </select>
                  <input
                    value={r.code} onChange={(e) => setRow(i, { code: e.target.value })}
                    placeholder={ar ? "الكود / SKU" : "Code / SKU"}
                    className={`${field} w-44`} dir="ltr"
                  />
                  <select
                    value={r.location}
                    onChange={(e) => setRow(i, { location: e.target.value })}
                    className={`${field} w-44`}
                  >
                    <option value="">{ar ? "المكان…" : "Where…"}</option>
                    {locations.map((l) => (
                      <option key={l.code} value={l.code}>{l.label}</option>
                    ))}
                  </select>
                  <input
                    value={r.quantity} onChange={(e) => setRow(i, { quantity: e.target.value })}
                    placeholder={ar ? "الكمية" : "Qty"} type="number" step="0.01" min="0"
                    className={`${field} w-24`} dir="ltr"
                  />
                  <input
                    value={r.unitCost} onChange={(e) => setRow(i, { unitCost: e.target.value })}
                    placeholder={ar ? "التكلفة" : "Cost"} type="number" step="0.01" min="0"
                    className={`${field} w-28`} dir="ltr"
                  />
                  {rows.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setRows((prev) => prev.filter((_, n) => n !== i))}
                      className="text-xs text-ink-400 underline"
                    >
                      {ar ? "شيل" : "remove"}
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setRows((prev) => [...prev, blank()])}
              className="mt-2 rounded-lg border border-ink-200 px-3 py-1.5 text-xs text-ink-700"
            >
              {ar ? "زوّد سطر" : "Add a line"}
            </button>
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending || (!text.trim() && typed.length === 0)}
            className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {pending ? (ar ? "بنعدّ…" : "Counting…") : ar ? "اعرض الجرد" : "Count it up"}
          </button>
          {state.error && <span className="text-sm text-bad">{state.error}</span>}
        </div>
      </form>

      {/* ---------------------------------------------------------- preview */}
      {p && (
        <div className="rounded-lg border border-ink-200 p-3">
          <p className="mb-2 text-sm font-medium">
            {ar ? `${p.number} — قبل ما يتقيّد` : `${p.number} — before it is posted`}
          </p>

          <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {[
              [ar ? "سطور اتقبلت" : "Lines accepted", String(p.acceptedLines), "text-good"],
              [ar ? "اترفضت" : "Refused", String(p.refusedLines), p.refusedLines > 0 ? "text-bad" : ""],
              [ar ? "قيمة المخزون" : "Stock value", Number(p.totalValue).toFixed(2), ""],
              [
                ar ? "منها بالتقدير" : "of that, estimated",
                Number(p.estimatedValue).toFixed(2),
                Number(p.estimatedValue) > 0 ? "text-warn" : "",
              ],
            ].map(([label, v, tone]) => (
              <div key={label} className="rounded-lg bg-ink-50 px-3 py-2">
                <p className="text-xs text-ink-500">{label}</p>
                <p className={`num text-lg font-semibold ${tone}`}>{v}</p>
              </div>
            ))}
          </div>

          {p.estimatedLines > 0 && (
            <p className="mb-2 rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">
              {ar
                ? `${p.estimatedLines} سطر محدش يعرف تكلفته، فاتقدّرت من سعر البيع. الأرباح على البضاعة دي هتفضل تقديرية لحد ما تتباع وتتعوّض ببضاعة متكلّفة صح — والنظام بيعلّمها كده.`
                : `${p.estimatedLines} lines had no known cost and were estimated from the selling price. Margins on that stock stay estimates until it sells through, and the system keeps saying so.`}
            </p>
          )}

          {p.problems.length > 0 && (
            <div className="mb-3 max-h-48 overflow-y-auto rounded-lg border border-ink-100">
              <table className="w-full text-xs">
                <tbody>
                  {p.problems.map((problem, i) => (
                    <tr key={`${problem.rowNumber}-${i}`} className="border-b border-ink-100 last:border-0">
                      <td className="num px-2 py-1 text-ink-500">{ar ? "سطر" : "row"} {problem.rowNumber}</td>
                      <td className="px-2 py-1 text-bad">{problem.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <form action={commitFormAction}>
            <RequestIdField state={commit} />
            <input type="hidden" name="batchId" value={p.batchId} />
            <button
              type="submit"
              disabled={committing || p.acceptedLines === 0}
              className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {committing
                ? (ar ? "بنقيّد…" : "Posting…")
                : ar
                  ? `قيّد ${p.acceptedLines} سطر`
                  : `Post ${p.acceptedLines} line(s)`}
            </button>
            <p className="mt-2 text-xs text-ink-500">
              {ar
                ? "بعد القيد دي حركة في الدفاتر — تعديلها بيبقى قيد عكسي مش مسح."
                : "Once posted this is in the books: correcting it is a reversing entry, not an edit."}
            </p>
          </form>

          {commit.error && <p className="mt-2 text-sm text-bad">{commit.error}</p>}
          {commit.success && <p className="mt-2 text-sm text-good">{commit.success}</p>}
        </div>
      )}
    </div>
  );
}
