import { cairoInstant, CAIRO } from "./attendance";

/**
 * Reading a device export, whatever the device calls its columns.
 *
 * No vendor is named here and none should be. A fingerprint reader exports a
 * table; which column holds the badge and which the timestamp is a mapping the
 * operator gives once and the import batch keeps, so a file read wrongly can
 * be explained afterwards rather than argued about.
 *
 * Two shapes of export exist in the wild and both are read here:
 *
 * - **A punch per row** — badge, one timestamp, sometimes a direction. The
 *   rawest thing a reader can produce.
 * - **A day per row, with paired clock columns** — badge, a date, then
 *   `Clock In 1`, `Clock Out 1`, `Clock In 2` … across the row. This is what
 *   the attendance software bundled with most readers prints, and it is a day
 *   already assembled rather than the punches themselves. It is unpivoted back
 *   into punches on the way in, so nothing downstream knows the difference and
 *   the engine here, not the device's, decides what the day amounts to.
 *
 * Pure, and the only thing that understands a file at all. A device API added
 * later produces the same rows and everything downstream is unchanged.
 *
 * The CSV splitter here is deliberately its own: there is one in the marketing
 * module, being rewritten elsewhere, and attendance should not stop working
 * because a campaign report changed shape.
 */

/**
 * Which number in `03/04/2026` is the month.
 *
 * Never inferred silently. The convention here is day-first, but the software
 * that ships with these readers is usually American and prints month-first,
 * and the two readings of the same file differ by months of somebody's pay.
 */
export type DateOrder = "DMY" | "MDY" | "YMD";

/** A pair of clock columns: one arrival and the departure that closes it. */
export type ClockPair = {
  in: string;
  out?: string | null;
};

export type ColumnMapping = {
  /** Defaults to a punch per row, which is what every mapping stored before this was. */
  layout?: "PUNCH_PER_ROW" | "PAIRS_PER_DAY";
  /** Header of the badge or user id column. Required in both layouts. */
  badge: string;
  /** How a slash-separated date is read. Defaults to day-first. */
  dateOrder?: DateOrder;
  /** Which line of the file holds the headers. 1 unless the export has a title. */
  headerRow?: number;

  /* A punch per row */
  /** Header of the timestamp column. */
  timestamp?: string;
  /** In/out, where the device records a direction at all. */
  direction?: string | null;

  /* A day per row */
  /** Header of the date column, the times living in their own columns beside it. */
  date?: string;
  /** Clock in/out column pairs, in the order the device prints them. */
  pairs?: ClockPair[];

  /** Where the device writes its own identity, if the file carries it. */
  device?: string | null;
  /** A column kept verbatim alongside the punch, for disputes. */
  payload?: string | null;
};

export type ParsedTable = {
  headers: string[];
  rows: string[][];
};

/** Splits one line, honouring quotes so a comma inside a field survives. */
function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (line[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells.map((c) => c.trim());
}

/**
 * Reads a delimited export into a table.
 *
 * The delimiter is detected rather than assumed: these files come off devices
 * configured by whoever installed them, and a semicolon export read as commas
 * produces one enormous column and a page of meaningless errors.
 *
 * `headerRow` exists because some of this software prints a report title, a
 * department and a date range above the table. Which line the headers are on
 * is asked rather than guessed — a wrong guess reads a title as column names
 * and every row afterwards is refused for reasons that make no sense.
 */
export function parseDelimited(text: string, headerRow = 1): ParsedTable {
  const lines = text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);

  const start = Math.max(0, Math.floor(headerRow) - 1);
  if (lines.length <= start) return { headers: [], rows: [] };

  const candidates = [",", ";", "\t", "|"];
  const delimiter = candidates
    .map((d) => ({ d, count: splitLine(lines[start], d).length }))
    .sort((a, b) => b.count - a.count)[0].d;

  const headers = splitLine(lines[start], delimiter);
  const rows = lines.slice(start + 1).map((l) => splitLine(l, delimiter));
  return { headers, rows };
}

type DateParts = { year: number; month: number; day: number };
type TimeParts = { hour: number; minute: number; second: number };

function validDate(year: number, month: number, day: number): DateParts | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Rejects the 31st of a thirty-day month rather than rolling it into the
  // next one, which would move a punch a day without saying so.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** Two digits is this century: these readers were not installed in 1998. */
function fullYear(value: number): number {
  return value < 100 ? 2000 + value : value;
}

/**
 * Reads a bare date, in the order the operator said the file uses.
 *
 * An ISO-looking date is read as ISO whatever the order says, because
 * `2026-09-16` has only one possible reading. Everything else follows the
 * stated order and is refused when it does not fit, rather than quietly
 * swapping day and month to make it fit.
 */
export function parseDeviceDate(value: string, order: DateOrder = "DMY"): DateParts | null {
  const text = value.trim();
  if (!text) return null;

  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (m) return validDate(+m[1], +m[2], +m[3]);

  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(text);
  if (m) {
    const year = fullYear(+m[3]);
    if (order === "MDY") return validDate(year, +m[1], +m[2]);
    return validDate(year, +m[2], +m[1]);
  }

  return null;
}

/** Reads a bare clock reading. `9:05`, `09:05:00`, `5:05 PM`. */
export function parseDeviceTime(value: string): TimeParts | null {
  const text = value.trim();
  if (!text) return null;

  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([APap][Mm])?$/.exec(text);
  if (!m) return null;

  let hour = +m[1];
  const meridiem = m[4]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || +m[2] > 59) return null;

  return { hour, minute: +m[2], second: m[3] ? +m[3] : 0 };
}

/**
 * Looks at a column of dates and says which order it must be in.
 *
 * Only ever used to preselect the choice on screen. A file where every day is
 * the twelfth or lower is genuinely ambiguous and this says so by returning
 * nothing, rather than picking one and being wrong half the time.
 */
export function sniffDateOrder(values: string[]): DateOrder | null {
  let iso = 0;
  let firstOverTwelve = 0;
  let secondOverTwelve = 0;

  for (const value of values) {
    const text = value.trim();
    if (!text) continue;
    if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(text)) {
      iso += 1;
      continue;
    }
    const m = /^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/.exec(text);
    if (!m) continue;
    if (+m[1] > 12) firstOverTwelve += 1;
    if (+m[2] > 12) secondOverTwelve += 1;
  }

  // Both cannot be a month, so a file that shows each is not a date column at
  // all and nothing here can rescue it.
  if (firstOverTwelve > 0 && secondOverTwelve > 0) return null;
  if (secondOverTwelve > 0) return "MDY";
  if (firstOverTwelve > 0) return "DMY";
  if (iso > 0) return "YMD";
  return null;
}

/**
 * Turns what a device wrote into an instant.
 *
 * Devices are configured by hand and their date formats follow whoever set
 * them up, so several shapes are accepted. The order of a slash-separated date
 * is the operator's to state; day-first is the default because it is the
 * convention here.
 *
 * The reading is wall-clock local to the device, which stands in Cairo.
 */
export function parseDeviceTimestamp(
  value: string,
  timeZone: string = CAIRO,
  order: DateOrder = "DMY",
): Date | null {
  const text = value.trim();
  if (!text) return null;

  // A date with no time at all is not a punch: it names a day, and a day is
  // not a moment somebody arrived.
  const split = /^(\S+)[T ]+(.+)$/.exec(text);
  if (!split) return null;

  const date = parseDeviceDate(split[1], order);
  const time = parseDeviceTime(split[2]);
  if (!date || !time) return null;

  return cairoInstant(date.year, date.month, date.day, time.hour, time.minute, time.second, timeZone);
}

/**
 * `row` is which line of the table produced this, counted from the first line
 * below the headers. One line yields several verdicts in the paired layout, so
 * a verdict's position in the list is not its position in the file, and a
 * refusal that cannot be pointed at a line is a refusal nobody can act on.
 */
export type RowVerdict =
  | { kind: "valid"; row: number; badge: string; punchedAt: Date; direction: string | null; raw: Record<string, string> }
  | { kind: "invalid"; row: number; reason: string; raw: Record<string, string> }
  | { kind: "duplicate"; row: number; badge: string; punchedAt: Date; raw: Record<string, string> }
  | { kind: "empty"; row: number; badge: string; raw: Record<string, string> };

export type ClassifiedImport = {
  verdicts: RowVerdict[];
  /** Lines of the file below the header, whatever each one produced. */
  totalRows: number;
  validRows: number;
  duplicateRows: number;
  invalidRows: number;
  /** Days the device printed with no clock reading on them at all. */
  emptyRows: number;
  /** Badges the file carries that match no employee. Distinct, not a count of rows. */
  unknownBadges: string[];
  rangeFrom: Date | null;
  rangeTo: Date | null;
};

export type ClassifyInput = {
  table: ParsedTable;
  mapping: ColumnMapping;
  /** Badges that map to an employee today. */
  knownBadges: Set<string>;
  /** `${badge}|${isoTimestamp}` already stored for this device. */
  existingKeys: Set<string>;
  timeZone?: string;
};

/** The key a punch is unique by, mirroring the database's own index. */
export function punchKey(badge: string, punchedAt: Date): string {
  return `${badge}|${punchedAt.toISOString()}`;
}

function orderName(order: DateOrder): string {
  if (order === "MDY") return "month-first";
  if (order === "YMD") return "year-first";
  return "day-first";
}

/**
 * Sorts every row into what it is, before anything is written.
 *
 * Duplicates are counted within the file as well as against what is stored,
 * because a device that exports an overlapping window twice in one file is
 * ordinary and the second copy is not a new punch.
 *
 * An unknown badge is not an error and never a reason to refuse a row: it is
 * stored, surfaced, and resolved by linking it to an employee. A punch thrown
 * away for being unrecognised is an hour of somebody's day thrown away with it.
 *
 * In the paired layout one line yields several verdicts, one per clock reading
 * it carries, so the counts below are punches while `totalRows` stays lines. A
 * line with a date and no readings is `empty`, not refused: the device prints
 * a row for every day in the range whether anybody came in or not, and calling
 * those errors would bury the real ones.
 */
export function classifyImport(input: ClassifyInput): ClassifiedImport {
  const { table, mapping } = input;
  const order = mapping.dateOrder ?? "DMY";
  const lower = table.headers.map((h) => h.trim().toLowerCase());
  const indexOf = (header: string | null | undefined) =>
    header ? lower.indexOf(header.trim().toLowerCase()) : -1;

  const badgeIdx = indexOf(mapping.badge);
  const payloadIdx = indexOf(mapping.payload);

  const verdicts: RowVerdict[] = [];
  const unknown = new Set<string>();
  const seen = new Set(input.existingKeys);
  let from: Date | null = null;
  let to: Date | null = null;

  const rawOf = (cells: string[]) => {
    const raw: Record<string, string> = {};
    table.headers.forEach((h, i) => {
      raw[h] = cells[i] ?? "";
    });
    return payloadIdx >= 0 ? { ...raw, _payload: cells[payloadIdx] ?? "" } : raw;
  };

  /** Files one punch, or says why it is not a new one. */
  const accept = (
    row: number,
    badge: string,
    punchedAt: Date,
    direction: string | null,
    raw: Record<string, string>,
  ) => {
    const key = punchKey(badge, punchedAt);
    if (seen.has(key)) {
      verdicts.push({ kind: "duplicate", row, badge, punchedAt, raw });
      return;
    }
    seen.add(key);
    if (!input.knownBadges.has(badge)) unknown.add(badge);
    if (!from || punchedAt < from) from = punchedAt;
    if (!to || punchedAt > to) to = punchedAt;
    verdicts.push({ kind: "valid", row, badge, punchedAt, direction, raw });
  };

  const paired = mapping.layout === "PAIRS_PER_DAY";
  const timeIdx = paired ? -1 : indexOf(mapping.timestamp);
  const dirIdx = paired ? -1 : indexOf(mapping.direction);
  const dateIdx = paired ? indexOf(mapping.date) : -1;
  const pairIdx = paired
    ? (mapping.pairs ?? []).map((p) => ({ in: indexOf(p.in), out: indexOf(p.out) }))
    : [];

  table.rows.forEach((cells, index) => {
    const row = index + 1;
    const raw = rawOf(cells);

    if (badgeIdx < 0) {
      verdicts.push({ kind: "invalid", row, reason: "The badge column is not mapped.", raw });
      return;
    }
    const badge = (cells[badgeIdx] ?? "").trim();
    if (!badge) {
      verdicts.push({ kind: "invalid", row, reason: "No badge number on this row.", raw });
      return;
    }

    if (!paired) {
      if (timeIdx < 0) {
        verdicts.push({ kind: "invalid", row, reason: "The timestamp column is not mapped.", raw });
        return;
      }
      const punchedAt = parseDeviceTimestamp(cells[timeIdx] ?? "", input.timeZone, order);
      if (!punchedAt) {
        verdicts.push({
          kind: "invalid",
          row,
          reason: `Could not read "${cells[timeIdx] ?? ""}" as a ${orderName(order)} date and time.`,
          raw,
        });
        return;
      }
      accept(row, badge, punchedAt, dirIdx >= 0 ? (cells[dirIdx] ?? "").trim() || null : null, raw);
      return;
    }

    if (dateIdx < 0 || pairIdx.length === 0) {
      verdicts.push({ kind: "invalid", row, reason: "The date or clock columns are not mapped.", raw });
      return;
    }

    const date = parseDeviceDate(cells[dateIdx] ?? "", order);
    if (!date) {
      verdicts.push({
        kind: "invalid",
        row,
        reason: `Could not read "${cells[dateIdx] ?? ""}" as a ${orderName(order)} date.`,
        raw,
      });
      return;
    }

    let produced = 0;
    for (const pair of pairIdx) {
      const inText = pair.in >= 0 ? (cells[pair.in] ?? "") : "";
      const outText = pair.out >= 0 ? (cells[pair.out] ?? "") : "";
      if (!inText.trim() && !outText.trim()) continue;

      const inTime = parseDeviceTime(inText);
      const outTime = parseDeviceTime(outText);

      if (inText.trim() && !inTime) {
        verdicts.push({ kind: "invalid", row, reason: `Could not read "${inText}" as a time.`, raw });
        continue;
      }
      if (outText.trim() && !outTime) {
        verdicts.push({ kind: "invalid", row, reason: `Could not read "${outText}" as a time.`, raw });
        continue;
      }

      if (inTime) {
        produced += 1;
        accept(
          row,
          badge,
          cairoInstant(date.year, date.month, date.day, inTime.hour, inTime.minute, inTime.second, input.timeZone),
          "IN",
          raw,
        );
      }
      if (outTime) {
        // A departure earlier on the clock than the arrival it closes happened
        // after midnight. The device prints a night shift on the day it began,
        // and reading 04:05 as that same morning turns a worked night into
        // minus sixteen hours.
        const nextDay =
          inTime !== null &&
          outTime.hour * 60 + outTime.minute < inTime.hour * 60 + inTime.minute;
        produced += 1;
        accept(
          row,
          badge,
          cairoInstant(
            date.year,
            date.month,
            date.day + (nextDay ? 1 : 0),
            outTime.hour,
            outTime.minute,
            outTime.second,
            input.timeZone,
          ),
          "OUT",
          raw,
        );
      }
    }

    if (produced === 0) verdicts.push({ kind: "empty", row, badge, raw });
  });

  return {
    verdicts,
    totalRows: table.rows.length,
    validRows: verdicts.filter((v) => v.kind === "valid").length,
    duplicateRows: verdicts.filter((v) => v.kind === "duplicate").length,
    invalidRows: verdicts.filter((v) => v.kind === "invalid").length,
    emptyRows: verdicts.filter((v) => v.kind === "empty").length,
    unknownBadges: [...unknown].sort(),
    rangeFrom: from,
    rangeTo: to,
  };
}

/** The sample file offered on the import screen, a punch to a row. */
export const SAMPLE_CSV = [
  "device_id,badge_id,timestamp,direction",
  "GATE-1,1001,2026-09-20 08:58,IN",
  "GATE-1,1001,2026-09-20 17:04,OUT",
  "GATE-1,1002,2026-09-20 09:26,IN",
  "GATE-1,1002,2026-09-20 17:01,OUT",
  "GATE-1,1003,2026-09-20 20:00,IN",
  "GATE-1,1003,2026-09-21 04:05,OUT",
  "",
].join("\n");

/**
 * The other sample: a day to a row, as the attendance software bundled with
 * these readers prints it. Month-first, because that software usually is.
 */
export const SAMPLE_PAIRS_CSV = [
  "Emp No.,AC-No.,Name,Date,Clock In 1,Clock Out 1,Clock In 2,Clock Out 2,Total in time",
  "21,21,21,9/12/2026,07:47,17:07,,,09:20",
  "21,21,21,9/13/2026,08:30,,,,",
  "21,21,21,9/14/2026,07:42,16:47,,,09:05",
  "21,21,21,9/15/2026,,,,,",
  "21,21,21,9/16/2026,09:17,18:11,,,08:54",
  "",
].join("\n");
