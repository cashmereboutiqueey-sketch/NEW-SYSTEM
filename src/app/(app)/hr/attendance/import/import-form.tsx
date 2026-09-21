"use client";

import { useActionState, useMemo, useState } from "react";
import { previewImportAction, commitImportAction, type PreviewState } from "../actions";
import type { FormState } from "@/components/entity-form";
import type { Locale } from "@/lib/i18n";
import {
  SAMPLE_CSV,
  SAMPLE_PAIRS_CSV,
  parseDelimited,
  sniffDateOrder,
  type DateOrder,
} from "@/core/attendance-import";

const emptyPreview: PreviewState = {};
const empty: FormState = {};

type Layout = "PUNCH_PER_ROW" | "PAIRS_PER_DAY";

/**
 * Loading a device file, in the order a person actually does it.
 *
 * Choose the file, say which column is which, look at what it found, and only
 * then import. The count is shown before anything is written because the
 * common disasters here are quiet ones — a file for the wrong month, a date
 * column read day-first when it was month-first — and they are obvious in a
 * summary and invisible in a table of numbers.
 *
 * Two shapes of file are read, and which one this is decides the whole of the
 * mapping, so it is the first question asked. The layout, the clock columns
 * and the date order are all guessed from the file and all overridable: the
 * guess is right for the ordinary export and the override is what saves the
 * unusual one.
 *
 * The file's text stays in the browser between the two steps and is sent again
 * on confirmation, where the server checks it hashes to what it counted. A
 * different file cannot be slipped in behind a preview somebody approved.
 */
export function ImportForm({ locale }: { locale: Locale }) {
  const ar = locale === "ar";
  const [preview, previewAction, previewing] = useActionState(previewImportAction, emptyPreview);
  const [commit, commitAction, committing] = useActionState(commitImportAction, empty);

  const [text, setText] = useState("");
  const [filename, setFilename] = useState("");
  const [headerRow, setHeaderRow] = useState(1);
  const [layout, setLayout] = useState<Layout>("PUNCH_PER_ROW");
  const [dateOrder, setDateOrder] = useState<DateOrder>("DMY");
  const [dateColumn, setDateColumn] = useState("");

  const table = useMemo(
    () => (text ? parseDelimited(text, headerRow) : { headers: [], rows: [] }),
    [text, headerRow],
  );
  const headers = table.headers;

  const field =
    "rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep";
  const label = "mb-1 block text-xs text-ink-600";

  /** Picks the likeliest column, so the usual file needs no thought at all. */
  const guess = (...words: string[]) =>
    headers.find((h) => words.some((w) => h.toLowerCase().includes(w))) ?? "";

  /**
   * Clock columns, in the order the device prints them.
   *
   * Matched by number rather than by position: `Clock In 1` belongs with
   * `Clock Out 1` wherever the export happens to put it, and a device that
   * prints five pairs and a device that prints one are then the same file.
   */
  const clockPairs = useMemo(() => {
    const ins: { n: string; h: string }[] = [];
    const outs = new Map<string, string>();
    for (const h of headers) {
      const t = h.toLowerCase().replace(/[._-]+/g, " ");
      const m = /^(?:clock\s*)?(in|out)\s*(\d*)$/.exec(t) ?? /^(?:clock\s*)?(in|out)\s*(\d*)\b/.exec(t);
      if (!m) continue;
      const n = m[2] || "1";
      if (m[1] === "in") ins.push({ n, h });
      else outs.set(n, h);
    }
    ins.sort((a, b) => Number(a.n) - Number(b.n));
    return ins.map((i) => ({ in: i.h, out: outs.get(i.n) ?? "" }));
  }, [headers]);

  /** Reads the file in the browser: the headers are needed to offer a mapping. */
  async function onFile(file: File | undefined) {
    if (!file) return;
    const content = await file.text();
    setText(content);
    setFilename(file.name);

    // Guessed once from the file, then left alone, so a deliberate change on
    // screen is not undone by a re-render.
    const parsed = parseDelimited(content, 1);
    const lower = parsed.headers.map((h) => h.toLowerCase());
    const looksPaired = lower.some((h) => /\b(in|out)\s*\d*$/.test(h.replace(/[._-]+/g, " ")));
    setLayout(looksPaired ? "PAIRS_PER_DAY" : "PUNCH_PER_ROW");

    const dateIdx = lower.findIndex((h) => h.includes("date") || h.includes("time"));
    const chosen = dateIdx >= 0 ? parsed.headers[dateIdx] : "";
    setDateColumn(chosen);
    if (dateIdx >= 0) {
      const sniffed = sniffDateOrder(parsed.rows.map((r) => r[dateIdx] ?? "").slice(0, 200));
      if (sniffed) setDateOrder(sniffed);
    }
  }

  const columnPicker = (
    name: string,
    labelText: string,
    chosen: string,
    required = false,
    onChange?: (v: string) => void,
    value?: string,
  ) => (
    <div>
      <label className={label} htmlFor={name}>
        {labelText}
      </label>
      <select
        id={name}
        name={name}
        required={required}
        {...(onChange ? { value, onChange: (e) => onChange(e.target.value) } : { defaultValue: chosen })}
        className={`${field} min-w-40`}
      >
        {!required && <option value="">{ar ? "— بدون —" : "— none —"}</option>}
        {headers.map((h) => (
          <option key={h} value={h}>{h}</option>
        ))}
      </select>
    </div>
  );

  const paired = layout === "PAIRS_PER_DAY";
  const p = preview.preview;

  return (
    <div className="space-y-4">
      <form action={previewAction} className="space-y-3">
        <input type="hidden" name="text" value={text} />
        <input type="hidden" name="filename" value={filename} />
        <input type="hidden" name="layout" value={layout} />
        <input type="hidden" name="dateOrder" value={dateOrder} />
        <input type="hidden" name="headerRow" value={headerRow} />

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className={label} htmlFor="att-file">
              {ar ? "ملف الجهاز" : "Device file"}
            </label>
            <input
              id="att-file"
              type="file"
              accept=".csv,.txt,.tsv,text/csv,text/plain,text/tab-separated-values"
              onChange={(e) => void onFile(e.target.files?.[0])}
              className="block text-xs file:me-2 file:rounded-lg file:border-0 file:bg-ink-900 file:px-2.5 file:py-1.5 file:text-xs file:text-white"
            />
          </div>
          <div>
            <label className={label} htmlFor="att-device">
              {ar ? "اسم الجهاز" : "Device"}
            </label>
            <input
              id="att-device"
              name="deviceId"
              required
              placeholder={ar ? "مثلاً: بوابة ١" : "e.g. GATE-1"}
              className={`${field} w-40`}
              dir="ltr"
            />
          </div>
          <a
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(paired ? SAMPLE_PAIRS_CSV : SAMPLE_CSV)}`}
            download={paired ? "attendance-sample-days.csv" : "attendance-sample-punches.csv"}
            className="rounded-lg border border-ink-200 px-3 py-2 text-xs text-ink-700"
          >
            {ar ? "نزّل ملف نموذج" : "Download a sample file"}
          </a>
        </div>

        {text && (
          <div className="rounded-lg border border-ink-200 p-3">
            <p className={label}>
              {ar ? "الملف ده شكله إيه" : "What shape this file is"}
            </p>
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <span className={label}>{ar ? "كل سطر فيه إيه" : "Each row is"}</span>
                <div className="flex gap-3 text-sm">
                  {(
                    [
                      ["PUNCH_PER_ROW", ar ? "بصمة واحدة" : "one punch"],
                      ["PAIRS_PER_DAY", ar ? "يوم كامل بدخول وخروج" : "a day, with clock in/out"],
                    ] as [Layout, string][]
                  ).map(([value, text_]) => (
                    <label key={value} className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        name="layout-choice"
                        checked={layout === value}
                        onChange={() => setLayout(value)}
                      />
                      {text_}
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className={label} htmlFor="att-order">
                  {ar ? "ترتيب التاريخ" : "Date order"}
                </label>
                <select
                  id="att-order"
                  value={dateOrder}
                  onChange={(e) => setDateOrder(e.target.value as DateOrder)}
                  className={field}
                  dir="ltr"
                >
                  <option value="DMY">{ar ? "يوم/شهر/سنة — 16/09/2026" : "day/month/year — 16/09/2026"}</option>
                  <option value="MDY">{ar ? "شهر/يوم/سنة — 9/16/2026" : "month/day/year — 9/16/2026"}</option>
                  <option value="YMD">{ar ? "سنة-شهر-يوم — 2026-09-16" : "year-month-day — 2026-09-16"}</option>
                </select>
              </div>

              <div>
                <label className={label} htmlFor="att-header-row">
                  {ar ? "سطر أسماء الأعمدة" : "Header line"}
                </label>
                <input
                  id="att-header-row"
                  type="number"
                  min={1}
                  max={50}
                  value={headerRow}
                  onChange={(e) => setHeaderRow(Math.max(1, Number(e.target.value) || 1))}
                  className={`${field} w-20`}
                  dir="ltr"
                />
              </div>
            </div>

            <p className="mt-2 text-xs text-ink-500">
              {ar
                ? "ترتيب التاريخ اتخمّن من الملف نفسه. لو غلط، البصمات هتتحط في شهر تاني — راجعه."
                : "The date order is guessed from the file itself. Get it wrong and the punches land in a different month, so check it."}
            </p>
          </div>
        )}

        {headers.length > 0 && (
          <div className="rounded-lg border border-ink-200 p-3">
            <p className={label}>
              {ar
                ? "أي عمود فيه إيه — الأجهزة بتسمّي أعمدتها بطرق مختلفة"
                : "Which column is which — devices name their columns differently"}
            </p>
            <div className="flex flex-wrap items-end gap-3">
              {columnPicker("map_badge", ar ? "رقم البصمة" : "Badge", guess("badge", "user", "emp", "ac-no", "pin"), true)}

              {!paired && (
                <>
                  {columnPicker("map_timestamp", ar ? "الوقت" : "Timestamp", guess("time", "date", "punch"), true)}
                  {columnPicker("map_direction", ar ? "دخول/خروج" : "Direction", guess("direction", "status", "type", "in/out"))}
                </>
              )}

              {paired &&
                columnPicker(
                  "map_date",
                  ar ? "التاريخ" : "Date",
                  dateColumn,
                  true,
                  setDateColumn,
                  dateColumn,
                )}

              {columnPicker("map_payload", ar ? "بيانات إضافية" : "Extra payload", "")}
            </div>

            {paired && (
              <div className="mt-3 border-t border-ink-100 pt-3">
                <p className={label}>
                  {ar
                    ? "أعمدة الدخول والخروج — الجهاز بيطبع أكتر من مرة في اليوم"
                    : "The clock in and clock out columns — the device prints more than one pair a day"}
                </p>
                <div className="space-y-2">
                  {Array.from({ length: Math.max(clockPairs.length, 1) }).map((_, i) => (
                    <div key={i} className="flex flex-wrap items-end gap-3">
                      <span className="num mb-2 text-xs text-ink-400">{i + 1}</span>
                      {columnPicker(`map_in_${i}`, ar ? "دخول" : "Clock in", clockPairs[i]?.in ?? "")}
                      {columnPicker(`map_out_${i}`, ar ? "خروج" : "Clock out", clockPairs[i]?.out ?? "")}
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-xs text-ink-500">
                  {ar
                    ? "خروج وقته أبكر من الدخول اللي معاه بيتحسب تاني يوم الصبح — ورديات الليل."
                    : "An out earlier on the clock than the in it closes is read as the next morning, which is what a night shift is."}
                </p>
              </div>
            )}

            {table.rows.length > 0 && (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-ink-500">
                  {ar ? "أول ٣ سطور من الملف" : "The first 3 lines of the file"}
                </summary>
                <div className="mt-2 max-h-40 overflow-auto rounded-lg border border-ink-100">
                  <table className="w-full text-[11px]" dir="ltr">
                    <thead>
                      <tr className="bg-ink-50">
                        {headers.map((h) => (
                          <th key={h} className="whitespace-nowrap px-2 py-1 text-start font-medium">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {table.rows.slice(0, 3).map((r, i) => (
                        <tr key={i} className="border-t border-ink-100">
                          {headers.map((h, c) => (
                            <td key={h} className="whitespace-nowrap px-2 py-1 text-ink-600">{r[c] ?? ""}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </div>
        )}

        <button
          type="submit"
          disabled={previewing || !text}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {previewing ? (ar ? "بنقرأ…" : "Reading…") : ar ? "اقرأ الملف" : "Read the file"}
        </button>

        {preview.error && <p className="text-sm text-bad">{preview.error}</p>}
      </form>

      {p && (
        <div className="rounded-lg border border-ink-200 p-3">
          <p className="mb-2 text-sm font-medium">
            {ar ? "قبل ما نستورد" : "Before anything is imported"}
          </p>

          <div className="mb-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {[
              [ar ? "سطور الملف" : "Rows in file", p.totalRows, ""],
              [ar ? "بصمات جديدة" : "New punches", p.validRows, "text-good"],
              [ar ? "متسجّلة قبل كده" : "Already stored", p.duplicateRows, "text-ink-500"],
              [ar ? "أيام فاضية" : "Empty days", p.emptyRows, "text-ink-500"],
              [ar ? "مرفوضة" : "Refused", p.invalidRows, p.invalidRows > 0 ? "text-bad" : ""],
              [
                ar ? "بصمات مش معروفة" : "Unknown badges",
                p.unknownBadges.length,
                p.unknownBadges.length > 0 ? "text-warn" : "",
              ],
            ].map(([labelText, value, tone]) => (
              <div key={String(labelText)} className="rounded-lg bg-ink-50 px-3 py-2">
                <p className="text-xs text-ink-500">{labelText}</p>
                <p className={`num text-lg font-semibold ${tone}`}>{value}</p>
              </div>
            ))}
          </div>

          {p.rangeFrom && (
            <p className="mb-2 text-xs text-ink-600">
              {ar ? "الملف بيغطي من" : "The file covers"}{" "}
              <span className="num" dir="ltr">{p.rangeFrom.slice(0, 10)}</span>{" "}
              {ar ? "إلى" : "to"}{" "}
              <span className="num" dir="ltr">{p.rangeTo?.slice(0, 10)}</span>
              {" — "}
              {ar
                ? "لو ده مش الشهر اللي قصده، يبقى ترتيب التاريخ أو الملف نفسه غلط."
                : "if that is not the month you meant, either the date order or the file is wrong."}
            </p>
          )}

          {p.unknownBadges.length > 0 && (
            <p className="mb-2 rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">
              {ar
                ? `بصمات مالهاش موظف: ${p.unknownBadges.join("، ")}. هتتسجّل زي ما هي وتظهر في المراجعة عشان تربطها.`
                : `Badges with no employee: ${p.unknownBadges.join(", ")}. They are imported as they are and appear in the review queue to be linked.`}
            </p>
          )}

          {p.problems.length > 0 && (
            <div className="mb-3 max-h-40 overflow-y-auto rounded-lg border border-ink-100">
              <table className="w-full text-xs">
                <tbody>
                  {p.problems.map((problem, i) => (
                    <tr key={`${problem.rowNumber}-${i}`} className="border-b border-ink-100 last:border-0">
                      <td className="num px-2 py-1 text-ink-500">{ar ? "سطر" : "line"} {problem.rowNumber}</td>
                      <td className="px-2 py-1 text-bad">{problem.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <form action={commitAction}>
            <input type="hidden" name="importId" value={p.importId} />
            <input type="hidden" name="text" value={text} />
            <input type="hidden" name="rangeFrom" value={p.rangeFrom ?? ""} />
            <input type="hidden" name="rangeTo" value={p.rangeTo ?? ""} />
            <button
              type="submit"
              disabled={committing || p.validRows === 0}
              className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {committing
                ? (ar ? "بنستورد…" : "Importing…")
                : ar
                  ? `استورد ${p.validRows} بصمة`
                  : `Import ${p.validRows} punch(es)`}
            </button>
          </form>

          {commit.error && <p className="mt-2 text-sm text-bad">{commit.error}</p>}
          {commit.success && <p className="mt-2 text-sm text-good">{commit.success}</p>}
        </div>
      )}
    </div>
  );
}
