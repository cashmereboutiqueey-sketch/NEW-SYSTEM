import { describe, it, expect } from "vitest";
import {
  cairoParts,
  workDateFor,
  scheduledMinutesOf,
  isWorkingDay,
  deriveAttendance,
  type ShiftRule,
} from "./attendance";

/** Reading a day against a shift. */

/** 09:00–17:00, Sunday to Thursday, half an hour unpaid, ten minutes grace. */
const day: ShiftRule = {
  startMinute: 9 * 60,
  endMinute: 17 * 60,
  crossesMidnight: false,
  workingDays: [0, 1, 2, 3, 4],
  breakMinutes: 30,
  breakPaid: false,
  graceMinutes: 10,
  overtimeAfterMinutes: 450,
};

/** 20:00–04:00, the night line. */
const night: ShiftRule = {
  ...day,
  startMinute: 20 * 60,
  endMinute: 4 * 60,
  crossesMidnight: true,
  breakMinutes: 0,
  overtimeAfterMinutes: 480,
};

/** An instant from Cairo wall-clock time, so the tests read as the shop does. */
function cairo(dateKey: string, hhmm: string, offset: "+02:00" | "+03:00" = "+03:00"): Date {
  return new Date(`${dateKey}T${hhmm}:00${offset}`);
}

describe("Cairo, not UTC", () => {
  it("puts a late-evening punch on the day the shop calls it", () => {
    // 23:30 Cairo on the 31st is 20:30 UTC the same day in winter, but the
    // hour matters: in summer a 01:00 Cairo punch is 22:00 UTC the day before.
    const parts = cairoParts(new Date("2026-07-31T22:00:00.000Z"));
    expect(parts.dateKey).toBe("2026-08-01");
    expect(parts.minuteOfDay).toBe(60);
  });

  it("follows the offset across daylight saving rather than assuming one", () => {
    const summer = cairoParts(new Date("2026-07-15T09:00:00.000Z"));
    const winter = cairoParts(new Date("2026-12-15T09:00:00.000Z"));
    expect(summer.minuteOfDay - winter.minuteOfDay).toBe(60);
  });

  it("knows which weekday a work date is", () => {
    // 2026-09-20 is a Sunday, the first working day of the week here.
    expect(isWorkingDay(day, "2026-09-20")).toBe(true);
    // Friday.
    expect(isWorkingDay(day, "2026-09-25")).toBe(false);
  });
});

describe("which day a punch belongs to", () => {
  it("is the calendar day, for a day shift", () => {
    expect(workDateFor(cairo("2026-09-20", "09:05"), day)).toBe("2026-09-20");
  });

  it("is the evening it started, for a night shift", () => {
    // Clocking out at 02:10 finished the shift that began the night before.
    expect(workDateFor(cairo("2026-09-21", "02:10"), night)).toBe("2026-09-20");
    // Arriving at 20:00 starts a new one.
    expect(workDateFor(cairo("2026-09-21", "20:00"), night)).toBe("2026-09-21");
  });
});

describe("what the shift asks for", () => {
  it("counts the span less an unpaid break", () => {
    expect(scheduledMinutesOf(day)).toBe(8 * 60 - 30);
  });

  it("counts the whole span when the break is paid", () => {
    expect(scheduledMinutesOf({ ...day, breakPaid: true })).toBe(8 * 60);
  });

  it("wraps midnight for a night shift", () => {
    expect(scheduledMinutesOf(night)).toBe(8 * 60);
  });
});

describe("a normal day", () => {
  it("is present, with the unpaid break taken off", () => {
    const result = deriveAttendance({
      punches: [cairo("2026-09-20", "08:58"), cairo("2026-09-20", "17:02")],
      shift: day,
      dateKey: "2026-09-20",
    });
    expect(result.status).toBe("PRESENT");
    expect(result.workedMinutes).toBe(8 * 60 + 4 - 30);
    expect(result.breakMinutes).toBe(30);
    expect(result.lateMinutes).toBe(0);
    expect(result.earlyLeaveMinutes).toBe(0);
  });

  it("counts a second pair, for somebody who went out and came back", () => {
    const result = deriveAttendance({
      punches: [
        cairo("2026-09-20", "09:00"),
        cairo("2026-09-20", "12:00"),
        cairo("2026-09-20", "13:00"),
        cairo("2026-09-20", "17:00"),
      ],
      shift: day,
      dateKey: "2026-09-20",
    });
    expect(result.workedMinutes).toBe(7 * 60 - 30);
    expect(result.status).toBe("PRESENT");
  });
});

describe("lateness", () => {
  it("is not late inside the grace period", () => {
    const result = deriveAttendance({
      punches: [cairo("2026-09-20", "09:09"), cairo("2026-09-20", "17:00")],
      shift: day,
      dateKey: "2026-09-20",
    });
    expect(result.status).toBe("PRESENT");
    expect(result.lateMinutes).toBe(0);
  });

  it("counts from the scheduled start once the tolerance is exceeded", () => {
    const result = deriveAttendance({
      punches: [cairo("2026-09-20", "09:25"), cairo("2026-09-20", "17:00")],
      shift: day,
      dateKey: "2026-09-20",
    });
    expect(result.status).toBe("LATE");
    // Twenty-five past nine against a nine o'clock start: late by
    // twenty-five, not by fifteen. Grace decided that it counts, not how much.
    expect(result.lateMinutes).toBe(25);
  });
});

describe("leaving early", () => {
  it("is measured against the shift's end", () => {
    const result = deriveAttendance({
      punches: [cairo("2026-09-20", "09:00"), cairo("2026-09-20", "15:30")],
      shift: day,
      dateKey: "2026-09-20",
    });
    expect(result.status).toBe("EARLY_LEAVE");
    expect(result.earlyLeaveMinutes).toBe(90);
  });
});

describe("a missing clock-out", () => {
  it("is incomplete, never absent and never a shorter day", () => {
    const result = deriveAttendance({
      punches: [cairo("2026-09-20", "09:00")],
      shift: day,
      dateKey: "2026-09-20",
    });
    expect(result.status).toBe("INCOMPLETE");
    expect(result.workedMinutes).toBe(0);
    expect(result.lastOut).toBeNull();
    expect(result.reviewReason).toMatch(/one punch/i);
  });

  it("is incomplete for any odd number of punches", () => {
    const result = deriveAttendance({
      punches: [
        cairo("2026-09-20", "09:00"),
        cairo("2026-09-20", "12:00"),
        cairo("2026-09-20", "13:00"),
      ],
      shift: day,
      dateKey: "2026-09-20",
    });
    expect(result.status).toBe("INCOMPLETE");
  });
});

describe("no punch at all", () => {
  it("needs review on a working day — absence is somebody's judgement", () => {
    const result = deriveAttendance({ punches: [], shift: day, dateKey: "2026-09-20" });
    expect(result.status).toBe("NEEDS_REVIEW");
    expect(result.status).not.toBe("ABSENT");
    expect(result.reviewReason).toMatch(/no punch/i);
  });

  it("is simply off on a day the shift does not work", () => {
    const result = deriveAttendance({ punches: [], shift: day, dateKey: "2026-09-25" });
    expect(result.status).toBe("OFF");
    expect(result.scheduledMinutes).toBe(0);
  });

  it("is leave when leave was approved", () => {
    const result = deriveAttendance({
      punches: [],
      shift: day,
      dateKey: "2026-09-20",
      onLeave: true,
    });
    expect(result.status).toBe("LEAVE");
  });
});

describe("a night shift", () => {
  it("counts hours across midnight as one stretch", () => {
    const result = deriveAttendance({
      punches: [cairo("2026-09-20", "19:55"), cairo("2026-09-21", "04:05")],
      shift: night,
      dateKey: "2026-09-20",
    });
    expect(result.status).toBe("PRESENT");
    expect(result.workedMinutes).toBe(8 * 60 + 10);
    expect(result.lateMinutes).toBe(0);
    expect(result.earlyLeaveMinutes).toBe(0);
  });

  it("still sees lateness on the evening it began", () => {
    const result = deriveAttendance({
      punches: [cairo("2026-09-20", "20:40"), cairo("2026-09-21", "04:00")],
      shift: night,
      dateKey: "2026-09-20",
    });
    expect(result.status).toBe("LATE");
    // Forty past eight against an eight o'clock start, by the same rule.
    expect(result.lateMinutes).toBe(40);
  });

  it("sees an early departure before the morning end", () => {
    const result = deriveAttendance({
      punches: [cairo("2026-09-20", "20:00"), cairo("2026-09-21", "02:00")],
      shift: night,
      dateKey: "2026-09-20",
    });
    expect(result.status).toBe("EARLY_LEAVE");
    expect(result.earlyLeaveMinutes).toBe(120);
  });
});

describe("overtime", () => {
  it("is only ever a candidate here, never approved by arithmetic", () => {
    const result = deriveAttendance({
      punches: [cairo("2026-09-20", "09:00"), cairo("2026-09-20", "19:00")],
      shift: day,
      dateKey: "2026-09-20",
    });
    // Ten hours less the unpaid half hour, against a 450-minute threshold.
    expect(result.workedMinutes).toBe(570);
    expect(result.overtimeCandidateMinutes).toBe(120);
  });

  it("is nothing at all on a day that ran to time", () => {
    const result = deriveAttendance({
      punches: [cairo("2026-09-20", "09:00"), cairo("2026-09-20", "17:00")],
      shift: day,
      dateKey: "2026-09-20",
    });
    expect(result.overtimeCandidateMinutes).toBe(0);
  });
});

describe("a short visit", () => {
  it("does not have a break deducted from it", () => {
    const result = deriveAttendance({
      punches: [cairo("2026-09-20", "09:00"), cairo("2026-09-20", "09:20")],
      shift: day,
      dateKey: "2026-09-20",
    });
    expect(result.workedMinutes).toBe(20);
    expect(result.breakMinutes).toBe(0);
  });
});
