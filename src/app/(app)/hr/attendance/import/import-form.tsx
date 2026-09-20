"use client";

import { useActionState, useState } from "react";
import { previewImportAction, commitImportAction, type PreviewState } from "../actions";
import type { FormState } from "@/components/entity-form";
import type { Locale } from "@/lib/i18n";
import { SAMPLE_CSV } from "@/core/attendance-import";

const emptyPreview: PreviewState = {};
const empty: FormState = {};

/**
 * Loading a device file, in the order a person actually does it.
 *
 * Choose the file, say which column is which, look at what it found, and only
 * then import. The count is shown before anything is written because the
 * common disasters here are quiet ones — a file for the wrong month, a date
 * column read day-first when it was month-first — and they are obvious in a
 * summary and invisible in a table of numbers.
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
  const [headers, setHeaders] = useState<string[]>([]);

  const field =
    "rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep";
  const label = "mb-1 block text-xs text-ink-600";

  /** Reads the file in the browser: the header row is needed to offer a mapping. */
  async function onFile(file: File | undefined) {
    if (!file) return;
    const content = await file.text();
    setText(content);
    setFilename(file.name);

    const firstLine = content.replace(/^﻿/, "").split(/\r?\n/)[0] ?? "";
    const delimiter = [",", ";", "\t", "|"]
      .map((d) => ({ d, n: firstLine.split(d).length }))
      .sort((a, b) => b.n - a.n)[0].d;
    setHeaders(firstLine.split(delimiter).map((h) => h.trim().replace(/^"|"$/g, "")));
  }

  /** Picks the likeliest column, so the usual file needs no thought at all. */
  const guess = (...words: string[]) =>
    headers.find((h) => words.some((w) => h.toLowerCase().includes(w))) ?? "";

  const columnPicker = (name: string, labelText: string, chosen: string, required = false) => (
    <div>
      <label className={label} htmlFor={name}>
        {labelText}
      </label>
      <select id={name} name={name} required={required} defaultValue={chosen} className={`${field} min-w-44`}>
        {!required && <option value="">{ar ? "— بدون —" : "— none —"}</option>}
        {headers.map((h) => (
          <option key={h} value={h}>{h}</option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="space-y-4">
      <form action={previewAction} className="space-y-3">
        <input type="hidden" name="text" value={text} />
        <input type="hidden" name="filename" value={filename} />

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className={label} htmlFor="att-file">
              {ar ? "ملف الجهاز" : "Device file"}
            </label>
            <input
              id="att-file"
              type="file"
              accept=".csv,.txt,.tsv,text/csv,text/plain"
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
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(SAMPLE_CSV)}`}
            download="attendance-sample.csv"
            className="rounded-lg border border-ink-200 px-3 py-2 text-xs text-ink-700"
          >
            {ar ? "نزّل ملف نموذج" : "Download a sample file"}
          </a>
        </div>

        {headers.length > 0 && (
          <div className="rounded-lg border border-ink-200 p-3">
            <p className={label}>
              {ar
                ? "أي عمود فيه إيه — الأجهزة بتسمّي أعمدتها بطرق مختلفة"
                : "Which column is which — devices name their columns differently"}
            </p>
            <div className="flex flex-wrap items-end gap-3">
              {columnPicker("map_badge", ar ? "رقم البصمة" : "Badge", guess("badge", "user", "emp", "pin"), true)}
              {columnPicker("map_timestamp", ar ? "الوقت" : "Timestamp", guess("time", "date", "punch"), true)}
              {columnPicker("map_direction", ar ? "دخول/خروج" : "Direction", guess("direction", "status", "type", "in/out"))}
              {columnPicker("map_payload", ar ? "بيانات إضافية" : "Extra payload", "")}
            </div>
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

      {preview.preview && (
        <div className="rounded-lg border border-ink-200 p-3">
          <p className="mb-2 text-sm font-medium">
            {ar ? "قبل ما نستورد" : "Before anything is imported"}
          </p>

          <div className="mb-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {[
              [ar ? "كل السطور" : "Rows", preview.preview.totalRows, ""],
              [ar ? "سليمة" : "Valid", preview.preview.validRows, "text-good"],
              [ar ? "مكررة" : "Already stored", preview.preview.duplicateRows, "text-ink-500"],
              [ar ? "مرفوضة" : "Refused", preview.preview.invalidRows, preview.preview.invalidRows > 0 ? "text-bad" : ""],
              [
                ar ? "بصمات مش معروفة" : "Unknown badges",
                preview.preview.unknownBadges.length,
                preview.preview.unknownBadges.length > 0 ? "text-warn" : "",
              ],
            ].map(([labelText, value, tone]) => (
              <div key={String(labelText)} className="rounded-lg bg-ink-50 px-3 py-2">
                <p className="text-xs text-ink-500">{labelText}</p>
                <p className={`num text-lg font-semibold ${tone}`}>{value}</p>
              </div>
            ))}
          </div>

          {preview.preview.rangeFrom && (
            <p className="mb-2 text-xs text-ink-600">
              {ar ? "الملف بيغطي من" : "The file covers"}{" "}
              <span className="num" dir="ltr">{preview.preview.rangeFrom.slice(0, 10)}</span>{" "}
              {ar ? "إلى" : "to"}{" "}
              <span className="num" dir="ltr">{preview.preview.rangeTo?.slice(0, 10)}</span>
              {" — "}
              {ar ? "لو ده مش الشهر اللي قصده، ده الملف الغلط." : "if that is not the month you meant, this is the wrong file."}
            </p>
          )}

          {preview.preview.unknownBadges.length > 0 && (
            <p className="mb-2 rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">
              {ar
                ? `بصمات مالهاش موظف: ${preview.preview.unknownBadges.join("، ")}. هتتسجّل زي ما هي وتظهر في المراجعة عشان تربطها.`
                : `Badges with no employee: ${preview.preview.unknownBadges.join(", ")}. They are imported as they are and appear in the review queue to be linked.`}
            </p>
          )}

          {preview.preview.problems.length > 0 && (
            <div className="mb-3 max-h-40 overflow-y-auto rounded-lg border border-ink-100">
              <table className="w-full text-xs">
                <tbody>
                  {preview.preview.problems.map((p) => (
                    <tr key={p.rowNumber} className="border-b border-ink-100 last:border-0">
                      <td className="num px-2 py-1 text-ink-500">{ar ? "سطر" : "row"} {p.rowNumber}</td>
                      <td className="px-2 py-1 text-bad">{p.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <form action={commitAction}>
            <input type="hidden" name="importId" value={preview.preview.importId} />
            <input type="hidden" name="text" value={text} />
            <input type="hidden" name="rangeFrom" value={preview.preview.rangeFrom ?? ""} />
            <input type="hidden" name="rangeTo" value={preview.preview.rangeTo ?? ""} />
            <button
              type="submit"
              disabled={committing || preview.preview.validRows === 0}
              className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {committing
                ? (ar ? "بنستورد…" : "Importing…")
                : ar
                  ? `استورد ${preview.preview.validRows} بصمة`
                  : `Import ${preview.preview.validRows} punch(es)`}
            </button>
          </form>

          {commit.error && <p className="mt-2 text-sm text-bad">{commit.error}</p>}
          {commit.success && <p className="mt-2 text-sm text-good">{commit.success}</p>}
        </div>
      )}
    </div>
  );
}
