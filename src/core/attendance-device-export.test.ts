import { describe, it, expect } from "vitest";
import { parseDelimited, classifyImport, sniffDateOrder } from "./attendance-import";
import { deriveAttendance, cairoParts, type ShiftRule } from "./attendance";

/**
 * The export this factory's reader actually produces, fixed exactly as its own
 * software printed it for the week of 9/10 to 9/16.
 *
 * Kept as a test rather than described in a document because the shape of this
 * file is the one thing here nobody controls: it is whatever the software on
 * the office machine prints, and the day it changes, this fails. The worked
 * minutes are checked against the totals that software computed for itself, so
 * a disagreement is between two independent arithmetics rather than between
 * this engine and its own expectations.
 */
const FILE = [
  "Emp No.,AC-No.,No.,Name,Date,Clock In 1,Clock Out 1,Clock In 2,Clock Out 2,Clock In 3,Clock Out 3,Clock In 4,Clock Out 4,Clock In 5,Clock Out 5,Total in time",
  "21,21,,21,9/10/2026,,,,,,,,,,,",
  "21,21,,21,9/12/2026,07:47,17:07,,,,,,,,,09:20",
  "21,21,,21,9/13/2026,08:30,,,,,,,,,,",
  "21,21,,21,9/14/2026,07:42,16:47,,,,,,,,,09:05",
  "21,21,,21,9/15/2026,,,,,,,,,,,",
  "21,21,,21,9/16/2026,09:17,18:11,,,,,,,,,08:54",
].join("\n");

const shift: ShiftRule = {
  startMinute: 540, endMinute: 1020, crossesMidnight: false,
  workingDays: [0, 1, 2, 3, 4, 6], breakMinutes: 0, breakPaid: false,
  graceMinutes: 15, overtimeAfterMinutes: 480,
};

describe("the export this factory's reader actually produces", () => {
  const table = parseDelimited(FILE);
  const dateIdx = table.headers.indexOf("Date");

  it("is recognised as month-first from its own dates", () => {
    expect(sniffDateOrder(table.rows.map((r) => r[dateIdx]))).toBe("MDY");
  });

  const result = classifyImport({
    table,
    mapping: {
      layout: "PAIRS_PER_DAY", badge: "Emp No.", date: "Date", dateOrder: "MDY",
      pairs: [1, 2, 3, 4, 5].map((n) => ({ in: `Clock In ${n}`, out: `Clock Out ${n}` })),
    },
    knownBadges: new Set(["21"]),
    existingKeys: new Set(),
  });

  it("reads six printed days into seven punches, refusing none", () => {
    expect(result.totalRows).toBe(6);
    // Three days both ways, and the thirteenth with an arrival and no departure.
    expect(result.validRows).toBe(7);
    expect(result.invalidRows).toBe(0);
    // The two days the device printed with nothing on them at all.
    expect(result.emptyRows).toBe(2);
  });

  it("lands inside the week the operator asked the device for", () => {
    expect(cairoParts(result.rangeFrom!).dateKey).toBe("2026-09-12");
    expect(cairoParts(result.rangeTo!).dateKey).toBe("2026-09-16");
  });

  it("works each day out to the same total the device printed", () => {
    const punches = result.verdicts.flatMap((v) => (v.kind === "valid" ? [v.punchedAt] : []));
    const byDay = new Map<string, Date[]>();
    for (const at of punches) {
      const key = cairoParts(at).dateKey;
      byDay.set(key, [...(byDay.get(key) ?? []), at]);
    }

    const worked = (key: string) =>
      deriveAttendance({ dateKey: key, shift, punches: byDay.get(key) ?? [] }).workedMinutes;

    expect(worked("2026-09-12")).toBe(9 * 60 + 20);
    expect(worked("2026-09-14")).toBe(9 * 60 + 5);
    expect(worked("2026-09-16")).toBe(8 * 60 + 54);
  });

  it("leaves the day with one punch incomplete rather than calling it absence", () => {
    const punches = result.verdicts.flatMap((v) =>
      v.kind === "valid" && cairoParts(v.punchedAt).dateKey === "2026-09-13" ? [v.punchedAt] : [],
    );
    const day = deriveAttendance({ dateKey: "2026-09-13", shift, punches });
    expect(day.status).toBe("INCOMPLETE");
    expect(day.workedMinutes).toBe(0);
  });
});
