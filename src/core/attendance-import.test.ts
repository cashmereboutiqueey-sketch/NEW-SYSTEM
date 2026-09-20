import { describe, it, expect } from "vitest";
import {
  parseDelimited,
  parseDeviceTimestamp,
  classifyImport,
  punchKey,
  SAMPLE_CSV,
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
