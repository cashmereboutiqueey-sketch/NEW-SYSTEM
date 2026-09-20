import { cairoInstant, CAIRO } from "./attendance";

/**
 * Reading a device export, whatever the device calls its columns.
 *
 * No vendor is named here and none should be. A fingerprint reader exports a
 * table; which column holds the badge and which the timestamp is a mapping the
 * operator gives once and the import batch keeps, so a file read wrongly can
 * be explained afterwards rather than argued about.
 *
 * Pure, and the only thing that understands a file at all. A device API added
 * later produces the same rows and everything downstream is unchanged.
 *
 * The CSV splitter here is deliberately its own: there is one in the marketing
 * module, being rewritten elsewhere, and attendance should not stop working
 * because a campaign report changed shape.
 */

export type ColumnMapping = {
  /** Header of the badge or user id column. Required. */
  badge: string;
  /** Header of the timestamp column. Required. */
  timestamp: string;
  /** Where the device writes its own identity, if the file carries it. */
  device?: string | null;
  /** In/out, where the device records a direction at all. */
  direction?: string | null;
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
 */
export function parseDelimited(text: string): ParsedTable {
  const lines = text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);

  if (lines.length === 0) return { headers: [], rows: [] };

  const candidates = [",", ";", "\t", "|"];
  const delimiter = candidates
    .map((d) => ({ d, count: splitLine(lines[0], d).length }))
    .sort((a, b) => b.count - a.count)[0].d;

  const headers = splitLine(lines[0], delimiter);
  const rows = lines.slice(1).map((l) => splitLine(l, delimiter));
  return { headers, rows };
}

/**
 * Turns what a device wrote into an instant.
 *
 * Devices are configured by hand and their date formats follow whoever set
 * them up, so several shapes are accepted. Two-digit day-first and month-first
 * dates are genuinely ambiguous, and where they are, the day-first reading is
 * taken — it is the convention here, and the alternative is silently moving a
 * punch by months.
 *
 * The reading is wall-clock local to the device, which stands in Cairo.
 */
export function parseDeviceTimestamp(value: string, timeZone: string = CAIRO): Date | null {
  const text = value.trim();
  if (!text) return null;

  // 2026-09-20 09:05[:00] or 2026/09/20T09:05
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (m) {
    return cairoInstant(+m[1], +m[2], +m[3], +m[4], +m[5], m[6] ? +m[6] : 0, timeZone);
  }

  // 20-09-2026 09:05, 20/09/2026 9:05 am
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([APap][Mm])?/.exec(text);
  if (m) {
    let hour = +m[4];
    const meridiem = m[7]?.toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    return cairoInstant(+m[3], +m[2], +m[1], hour, +m[5], m[6] ? +m[6] : 0, timeZone);
  }

  // A date with no time at all is not a punch; it names a day, and a day is
  // not a moment somebody arrived.
  return null;
}

export type RowVerdict =
  | { kind: "valid"; badge: string; punchedAt: Date; direction: string | null; raw: Record<string, string> }
  | { kind: "invalid"; reason: string; raw: Record<string, string> }
  | { kind: "duplicate"; badge: string; punchedAt: Date; raw: Record<string, string> };

export type ClassifiedImport = {
  verdicts: RowVerdict[];
  totalRows: number;
  validRows: number;
  duplicateRows: number;
  invalidRows: number;
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
 */
export function classifyImport(input: ClassifyInput): ClassifiedImport {
  const { table, mapping } = input;
  const lower = table.headers.map((h) => h.trim().toLowerCase());
  const indexOf = (header: string | null | undefined) =>
    header ? lower.indexOf(header.trim().toLowerCase()) : -1;

  const badgeIdx = indexOf(mapping.badge);
  const timeIdx = indexOf(mapping.timestamp);
  const dirIdx = indexOf(mapping.direction);
  const payloadIdx = indexOf(mapping.payload);

  const verdicts: RowVerdict[] = [];
  const unknown = new Set<string>();
  const seen = new Set(input.existingKeys);
  let from: Date | null = null;
  let to: Date | null = null;

  for (const cells of table.rows) {
    const raw: Record<string, string> = {};
    table.headers.forEach((h, i) => {
      raw[h] = cells[i] ?? "";
    });

    if (badgeIdx < 0 || timeIdx < 0) {
      verdicts.push({ kind: "invalid", reason: "The badge or timestamp column is not mapped.", raw });
      continue;
    }

    const badge = (cells[badgeIdx] ?? "").trim();
    if (!badge) {
      verdicts.push({ kind: "invalid", reason: "No badge number on this row.", raw });
      continue;
    }

    const punchedAt = parseDeviceTimestamp(cells[timeIdx] ?? "", input.timeZone);
    if (!punchedAt) {
      verdicts.push({
        kind: "invalid",
        reason: `Could not read "${cells[timeIdx] ?? ""}" as a date and time.`,
        raw,
      });
      continue;
    }

    const key = punchKey(badge, punchedAt);
    if (seen.has(key)) {
      verdicts.push({ kind: "duplicate", badge, punchedAt, raw });
      continue;
    }
    seen.add(key);

    if (!input.knownBadges.has(badge)) unknown.add(badge);
    if (!from || punchedAt < from) from = punchedAt;
    if (!to || punchedAt > to) to = punchedAt;

    verdicts.push({
      kind: "valid",
      badge,
      punchedAt,
      direction: dirIdx >= 0 ? (cells[dirIdx] ?? "").trim() || null : null,
      raw: payloadIdx >= 0 ? { ...raw, _payload: cells[payloadIdx] ?? "" } : raw,
    });
  }

  return {
    verdicts,
    totalRows: table.rows.length,
    validRows: verdicts.filter((v) => v.kind === "valid").length,
    duplicateRows: verdicts.filter((v) => v.kind === "duplicate").length,
    invalidRows: verdicts.filter((v) => v.kind === "invalid").length,
    unknownBadges: [...unknown].sort(),
    rangeFrom: from,
    rangeTo: to,
  };
}

/** The sample file offered on the import screen. */
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
