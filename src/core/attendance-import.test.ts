import { describe, it, expect } from "vitest";
import {
  parseDelimited,
  parseDeviceTimestamp,
  classifyImport,
  punchKey,
  SAMPLE_CSV,
  SAMPLE_PAIRS_CSV,
  sniffDateOrder,
  type ColumnMapping,
} from "./attendance-import";
import { cairoParts } from "./attendance";

/** Reading a device export before anything is written. */

const mapping: ColumnMapping = {
  badge: "badge_id",
  timestamp: "timestamp",
  device: "device_id",
  direction: "direction",
};

function classify(csv: string, known: string[] = ["1001", "1002"], existing: string[] = []) {
  return classifyImport({
    table: parseDelimited(csv),
    mapping,
    knownBadges: new Set(known),
    existingKeys: new Set(existing),
  });
}

describe("reading the file", () => {
  it("finds the delimiter instead of assuming a comma", () => {
    const semi = parseDelimited("a;b;c\n1;2;3");
    expect(semi.headers).toEqual(["a", "b", "c"]);
    expect(semi.rows[0]).toEqual(["1", "2", "3"]);

    const tab = parseDelimited("a\tb\n1\t2");
    expect(tab.headers).toEqual(["a", "b"]);
  });

  it("keeps a comma that lives inside a quoted field", () => {
    const table = parseDelimited('name,note\n"Ali, A",fine');
    expect(table.rows[0]).toEqual(["Ali, A", "fine"]);
  });

  it("survives a byte-order mark, which exports routinely carry", () => {
    const table = parseDelimited("﻿badge_id,timestamp\n1001,2026-09-20 09:00");
    expect(table.headers[0]).toBe("badge_id");
  });
});

describe("reading a device's idea of a timestamp", () => {
  it("takes the reading as Cairo wall-clock, not UTC", () => {
    const instant = parseDeviceTimestamp("2026-09-20 09:05")!;
    const parts = cairoParts(instant);
    expect(parts.dateKey).toBe("2026-09-20");
    expect(parts.minuteOfDay).toBe(9 * 60 + 5);
  });

  it("reads the same wall-clock correctly on both sides of daylight saving", () => {
    for (const date of ["2026-01-15", "2026-07-15"]) {
      const parts = cairoParts(parseDeviceTimestamp(`${date} 09:00`)!);
      expect(parts.minuteOfDay).toBe(540);
      expect(parts.dateKey).toBe(date);
    }
  });

  it("accepts day-first dates and twelve-hour clocks", () => {
    const a = cairoParts(parseDeviceTimestamp("20/09/2026 09:05")!);
    expect(a.dateKey).toBe("2026-09-20");

    const pm = cairoParts(parseDeviceTimestamp("20/09/2026 5:04 PM")!);
    expect(pm.minuteOfDay).toBe(17 * 60 + 4);

    const midnight = cairoParts(parseDeviceTimestamp("20/09/2026 12:30 AM")!);
    expect(midnight.minuteOfDay).toBe(30);
  });

  it("refuses a date with no time, which is not a moment anybody arrived", () => {
    expect(parseDeviceTimestamp("2026-09-20")).toBeNull();
    expect(parseDeviceTimestamp("not a date")).toBeNull();
    expect(parseDeviceTimestamp("")).toBeNull();
  });
});

describe("sorting the rows", () => {
  it("counts the sample file as entirely valid", () => {
    const result = classify(SAMPLE_CSV, ["1001", "1002", "1003"]);
    expect(result.totalRows).toBe(6);
    expect(result.validRows).toBe(6);
    expect(result.invalidRows).toBe(0);
    expect(result.duplicateRows).toBe(0);
    expect(result.unknownBadges).toEqual([]);
  });

  it("reports the span the file covers", () => {
    const result = classify(SAMPLE_CSV, ["1001", "1002", "1003"]);
    expect(cairoParts(result.rangeFrom!).dateKey).toBe("2026-09-20");
    expect(cairoParts(result.rangeTo!).dateKey).toBe("2026-09-21");
  });

  it("names an unknown badge rather than dropping its punches", () => {
    const result = classify(SAMPLE_CSV, ["1001", "1002"]);
    expect(result.unknownBadges).toEqual(["1003"]);
    // Still valid: an unrecognised badge is imported and resolved later.
    expect(result.validRows).toBe(6);
  });

  it("calls a row already stored a duplicate, not a new punch", () => {
    const existing = [punchKey("1001", parseDeviceTimestamp("2026-09-20 08:58")!)];
    const result = classify(SAMPLE_CSV, ["1001", "1002", "1003"], existing);
    expect(result.duplicateRows).toBe(1);
    expect(result.validRows).toBe(5);
  });

  it("catches a file that repeats a punch within itself", () => {
    const csv =
      "badge_id,timestamp\n1001,2026-09-20 09:00\n1001,2026-09-20 09:00\n1001,2026-09-20 17:00";
    const result = classify(csv);
    expect(result.validRows).toBe(2);
    expect(result.duplicateRows).toBe(1);
  });

  it("refuses a row with no badge, and says why", () => {
    const result = classify("badge_id,timestamp\n,2026-09-20 09:00");
    expect(result.invalidRows).toBe(1);
    const bad = result.verdicts[0];
    expect(bad.kind).toBe("invalid");
    if (bad.kind === "invalid") expect(bad.reason).toMatch(/badge/i);
  });

  it("refuses an unreadable timestamp, quoting what it could not read", () => {
    const result = classify("badge_id,timestamp\n1001,yesterday");
    const bad = result.verdicts[0];
    expect(bad.kind).toBe("invalid");
    if (bad.kind === "invalid") expect(bad.reason).toContain("yesterday");
  });

  it("refuses every row when the mapping points at columns that are not there", () => {
    const result = classifyImport({
      table: parseDelimited("a,b\n1,2"),
      mapping: { badge: "badge_id", timestamp: "timestamp" },
      knownBadges: new Set(),
      existingKeys: new Set(),
    });
    expect(result.invalidRows).toBe(1);
    expect(result.validRows).toBe(0);
  });

  it("keeps the whole row against a refusal, so it can be read back", () => {
    const result = classify("badge_id,timestamp,note\n1001,nonsense,late entry");
    const bad = result.verdicts[0];
    if (bad.kind === "invalid") expect(bad.raw.note).toBe("late entry");
  });
});

/**
 * A day to a row, which is what the attendance software bundled with these
 * readers prints. Fixed against the real export: `Emp No.`, a month-first
 * date, and five clock pairs of which one is usually filled.
 */
describe("a day per row, with clock in and clock out columns", () => {
  const paired: ColumnMapping = {
    layout: "PAIRS_PER_DAY",
    badge: "Emp No.",
    date: "Date",
    dateOrder: "MDY",
    pairs: [
      { in: "Clock In 1", out: "Clock Out 1" },
      { in: "Clock In 2", out: "Clock Out 2" },
    ],
  };

  function classifyPaired(csv: string, known: string[] = ["21"], existing: string[] = []) {
    return classifyImport({
      table: parseDelimited(csv),
      mapping: paired,
      knownBadges: new Set(known),
      existingKeys: new Set(existing),
    });
  }

  const header = "Emp No.,Date,Clock In 1,Clock Out 1,Clock In 2,Clock Out 2,Total in time";

  it("turns one printed day into the two punches it stands for", () => {
    const result = classifyPaired(`${header}\n21,9/12/2026,07:47,17:07,,,09:20`);

    expect(result.totalRows).toBe(1);
    expect(result.validRows).toBe(2);

    const punches = result.verdicts.filter((v) => v.kind === "valid");
    expect(punches.map((v) => (v.kind === "valid" ? v.direction : null))).toEqual(["IN", "OUT"]);

    const [first, second] = punches.map((v) => (v.kind === "valid" ? cairoParts(v.punchedAt) : null));
    expect(first).toMatchObject({ dateKey: "2026-09-12", minuteOfDay: 7 * 60 + 47 });
    expect(second).toMatchObject({ dateKey: "2026-09-12", minuteOfDay: 17 * 60 + 7 });
  });

  it("reads a month-first date as month-first and a day-first one as day-first", () => {
    const csv = `${header}\n21,9/10/2026,08:00,17:00,,,`;

    const asMonthFirst = classifyPaired(csv);
    const monthFirst = asMonthFirst.verdicts.find((v) => v.kind === "valid");
    expect(monthFirst?.kind === "valid" && cairoParts(monthFirst.punchedAt).dateKey).toBe("2026-09-10");

    const asDayFirst = classifyImport({
      table: parseDelimited(csv),
      mapping: { ...paired, dateOrder: "DMY" },
      knownBadges: new Set(["21"]),
      existingKeys: new Set(),
    });
    const dayFirst = asDayFirst.verdicts.find((v) => v.kind === "valid");
    expect(dayFirst?.kind === "valid" && cairoParts(dayFirst.punchedAt).dateKey).toBe("2026-10-09");
  });

  it("refuses a date the stated order cannot read, naming the order it tried", () => {
    // 9/16 is only a date if the month comes first. Read day-first it is the
    // sixteenth month, and swapping it silently would be the whole disaster.
    const result = classifyImport({
      table: parseDelimited(`${header}\n21,9/16/2026,09:17,18:11,,,`),
      mapping: { ...paired, dateOrder: "DMY" },
      knownBadges: new Set(["21"]),
      existingKeys: new Set(),
    });
    expect(result.validRows).toBe(0);
    const bad = result.verdicts[0];
    expect(bad.kind).toBe("invalid");
    if (bad.kind === "invalid") expect(bad.reason).toContain("day-first");
  });

  it("calls a day the device printed with nobody on it empty, not an error", () => {
    const result = classifyPaired(`${header}\n21,9/15/2026,,,,,`);
    expect(result.emptyRows).toBe(1);
    expect(result.invalidRows).toBe(0);
    expect(result.validRows).toBe(0);
  });

  it("keeps a single clock in without inventing the clock out", () => {
    const result = classifyPaired(`${header}\n21,9/13/2026,08:30,,,,`);
    expect(result.validRows).toBe(1);
    const only = result.verdicts.find((v) => v.kind === "valid");
    expect(only?.kind === "valid" && only.direction).toBe("IN");
  });

  it("puts a clock out earlier than its clock in on the next morning", () => {
    const result = classifyPaired(`${header}\n21,9/20/2026,20:00,04:05,,,`);
    const punches = result.verdicts.filter((v) => v.kind === "valid");
    const days = punches.map((v) => (v.kind === "valid" ? cairoParts(v.punchedAt).dateKey : ""));
    expect(days).toEqual(["2026-09-20", "2026-09-21"]);
  });

  it("reads every pair the device printed, not only the first", () => {
    const result = classifyPaired(`${header}\n21,9/14/2026,07:42,12:00,13:00,16:47,09:05`);
    expect(result.validRows).toBe(4);
  });

  it("writes nothing twice when the same week is exported again", () => {
    const csv = `${header}\n21,9/12/2026,07:47,17:07,,,09:20`;
    const first = classifyPaired(csv);
    const stored = first.verdicts
      .filter((v) => v.kind === "valid")
      .map((v) => (v.kind === "valid" ? punchKey(v.badge, v.punchedAt) : ""));

    const again = classifyPaired(csv, ["21"], stored);
    expect(again.validRows).toBe(0);
    expect(again.duplicateRows).toBe(2);
  });

  it("points a refusal at the line of the file it came from", () => {
    const result = classifyPaired(
      `${header}\n21,9/12/2026,07:47,17:07,,,09:20\n21,nonsense,08:00,17:00,,,`,
    );
    const bad = result.verdicts.find((v) => v.kind === "invalid");
    expect(bad?.row).toBe(2);
  });

  it("surfaces a badge nobody is linked to rather than dropping the day", () => {
    const result = classifyPaired(`${header}\n99,9/12/2026,07:47,17:07,,,09:20`, ["21"]);
    expect(result.unknownBadges).toEqual(["99"]);
    expect(result.validRows).toBe(2);
  });

  it("reads the sample file it offers, which is the real export's shape", () => {
    const result = classifyImport({
      table: parseDelimited(SAMPLE_PAIRS_CSV),
      mapping: {
        layout: "PAIRS_PER_DAY",
        badge: "Emp No.",
        date: "Date",
        dateOrder: "MDY",
        pairs: [
          { in: "Clock In 1", out: "Clock Out 1" },
          { in: "Clock In 2", out: "Clock Out 2" },
        ],
      },
      knownBadges: new Set(["21"]),
      existingKeys: new Set(),
    });
    // Three days worked, one with no clock out, one printed empty.
    expect(result.validRows).toBe(7);
    expect(result.emptyRows).toBe(1);
    expect(result.invalidRows).toBe(0);
  });
});

describe("saying which number is the month", () => {
  it("knows month-first when a second number passes twelve", () => {
    expect(sniffDateOrder(["9/10/2026", "9/16/2026"])).toBe("MDY");
  });

  it("knows day-first when a first number passes twelve", () => {
    expect(sniffDateOrder(["16/09/2026", "10/09/2026"])).toBe("DMY");
  });

  it("says nothing at all when every date reads both ways", () => {
    expect(sniffDateOrder(["03/04/2026", "05/06/2026"])).toBeNull();
  });

  it("says nothing when the column cannot be dates in any order", () => {
    expect(sniffDateOrder(["16/16/2026"])).toBeNull();
  });
});

describe("a report with a title above the table", () => {
  it("takes the headers from the line it is told to", () => {
    const withTitle = ["Attendance calculation", "OUR COMPANY  9/10/2026 - 9/16/2026", "badge_id,timestamp", "1001,2026-09-12 07:47"].join("\n");

    expect(parseDelimited(withTitle).headers).toEqual(["Attendance calculation"]);

    const table = parseDelimited(withTitle, 3);
    expect(table.headers).toEqual(["badge_id", "timestamp"]);
    expect(table.rows).toEqual([["1001", "2026-09-12 07:47"]]);
  });
});
