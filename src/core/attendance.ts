/**
 * Reading a day's punches against the shift somebody was meant to work.
 *
 * Pure, and deliberately so: what a day amounts to is the part most likely to
 * be argued about, and an argument is easier to settle against a function that
 * can be run on the numbers than against a query.
 *
 * Everything here happens in Cairo. A device writes local wall-clock time and
 * the database stores instants, so the day a punch belongs to has to be
 * decided in the timezone the shop stands in — in UTC a 01:00 punch belongs to
 * the wrong date for two hours of every night, and on the 31st it belongs to
 * the wrong month. Egypt also keeps daylight saving again, so the offset is
 * not a constant and is never treated as one.
 */

export const CAIRO = "Africa/Cairo";

/** Minutes in a day, named because the arithmetic below leans on it. */
export const DAY_MINUTES = 1440;

export type ShiftRule = {
  /** Minutes from midnight, Cairo. */
  startMinute: number;
  endMinute: number;
  /** Declared rather than inferred from end <= start. */
  crossesMidnight: boolean;
  /** 0 = Sunday … 6 = Saturday. */
  workingDays: number[];
  breakMinutes: number;
  breakPaid: boolean;
  graceMinutes: number;
  overtimeAfterMinutes: number;
};

export type AttendanceStatus =
  | "PRESENT"
  | "LATE"
  | "EARLY_LEAVE"
  | "INCOMPLETE"
  | "ABSENT"
  | "LEAVE"
  | "OFF"
  | "NEEDS_REVIEW";

export type DerivedAttendance = {
  status: AttendanceStatus;
  firstIn: Date | null;
  lastOut: Date | null;
  scheduledMinutes: number;
  workedMinutes: number;
  breakMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeCandidateMinutes: number;
  /** Why a person still has to look at it, where that is the case. */
  reviewReason: string | null;
};

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
      hour12: false,
    });
    partsCache.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  /** 0 = Sunday. */
  weekday: number;
  minuteOfDay: number;
  /** YYYY-MM-DD in the zone, which is what a "work date" means here. */
  dateKey: string;
};

/** What the clock on the wall in Cairo said at that instant. */
export function cairoParts(instant: Date, timeZone: string = CAIRO): ZonedParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(instant)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  // 24 at midnight in some engines; the day has already turned by then.
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);

  return {
    year,
    month,
    day,
    weekday: WEEKDAYS[parts.weekday] ?? 0,
    minuteOfDay: hour * 60 + minute,
    dateKey:
      `${String(year).padStart(4, "0")}-` +
      `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

/** The instant a Cairo date begins, for storing a work date as a date. */
export function cairoDateOnly(dateKey: string): Date {
  // Stored as a bare date in the database, so midnight UTC of that calendar
  // day is the value, never an instant shifted by an offset.
  return new Date(`${dateKey}T00:00:00.000Z`);
}

/**
 * The instant at which a Cairo wall-clock reading occurred.
 *
 * A fingerprint reader writes what its own clock says and knows nothing of
 * offsets, so "2026-07-01 09:00" from a device in Cairo is 06:00 UTC in
 * summer and 07:00 in winter. Guessing one offset would move every punch in
 * half the year by an hour, which is an hour of pay.
 *
 * Solved by asking rather than computing: take the reading as though it were
 * UTC, ask what Cairo called that instant, and correct by the difference.
 * Repeated once, because near a daylight change the first correction can land
 * on the other side of the jump.
 */
export function cairoInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
  timeZone: string = CAIRO,
): Date {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let instant = new Date(asUtc);
  for (let i = 0; i < 2; i += 1) {
    const seen = cairoParts(instant, timeZone);
    const seenUtc = Date.UTC(
      seen.year,
      seen.month - 1,
      seen.day,
      Math.floor(seen.minuteOfDay / 60),
      seen.minuteOfDay % 60,
      second,
    );
    const drift = seenUtc - asUtc;
    if (drift === 0) break;
    instant = new Date(instant.getTime() - drift);
  }
  return instant;
}

/** Shifts the calendar day by whole days, in Cairo terms. */
export function shiftDateKey(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Which working day a punch belongs to.
 *
 * For a day shift that is simply the Cairo date. For a night shift it is the
 * date the shift began: somebody clocking out at 02:00 finished the shift that
 * started the previous evening, and counting that as a new day would leave two
 * half-days where one whole one was worked.
 *
 * The line is drawn at the shift's end plus an hour, which is late enough to
 * catch an overrun and early enough that the next evening's arrival is not
 * dragged backwards.
 */
export function workDateFor(
  instant: Date,
  shift: Pick<ShiftRule, "crossesMidnight" | "endMinute"> | null,
  timeZone: string = CAIRO,
): string {
  const parts = cairoParts(instant, timeZone);
  if (!shift?.crossesMidnight) return parts.dateKey;
  const cutoff = Math.min(shift.endMinute + 60, DAY_MINUTES - 1);
  return parts.minuteOfDay <= cutoff ? shiftDateKey(parts.dateKey, -1) : parts.dateKey;
}

/** How long the shift asks for, less any break that is not paid. */
export function scheduledMinutesOf(shift: ShiftRule): number {
  const span = shift.crossesMidnight
    ? DAY_MINUTES - shift.startMinute + shift.endMinute
    : shift.endMinute - shift.startMinute;
  const paid = shift.breakPaid ? span : span - shift.breakMinutes;
  return Math.max(0, paid);
}

/** Whether the shift is worked on that calendar day at all. */
export function isWorkingDay(shift: ShiftRule, dateKey: string): boolean {
  const weekday = new Date(`${dateKey}T12:00:00.000Z`).getUTCDay();
  return shift.workingDays.includes(weekday);
}

/**
 * Minutes from the start of the shift's own day.
 *
 * On a night shift the hours after midnight belong to the same stretch, so
 * they continue past 1440 rather than restarting — otherwise 23:00 to 02:00
 * subtracts to minus twenty-one hours.
 */
function shiftMinute(instant: Date, shift: ShiftRule, dateKey: string, timeZone: string): number {
  const parts = cairoParts(instant, timeZone);
  if (parts.dateKey === dateKey) return parts.minuteOfDay;
  return parts.minuteOfDay + DAY_MINUTES;
}

export type DeriveInput = {
  /** Every punch already assigned to this work date, in any order. */
  punches: Date[];
  shift: ShiftRule | null;
  /** The work date, YYYY-MM-DD in Cairo. */
  dateKey: string;
  /** Approved leave, which the engine is told about rather than inferring. */
  onLeave?: boolean;
  /** A day the business is closed, whatever the shift says. */
  holiday?: boolean;
  timeZone?: string;
};

/**
 * What a day comes to.
 *
 * Two rules govern the awkward cases, and both exist because the alternative
 * costs somebody money they earned:
 *
 *   - An odd number of punches is INCOMPLETE, never absence and never a
 *     shorter day. A reader that missed a finger is not an employee who went
 *     home.
 *   - No punches at all on a working day is NEEDS_REVIEW, not ABSENT. Absence
 *     is a judgement about a person, and a judgement is made by a person.
 */
export function deriveAttendance(input: DeriveInput): DerivedAttendance {
  const timeZone = input.timeZone ?? CAIRO;
  const punches = [...input.punches].sort((a, b) => a.getTime() - b.getTime());
  const shift = input.shift;
  const scheduled = shift ? scheduledMinutesOf(shift) : 0;

  const empty: DerivedAttendance = {
    status: "NEEDS_REVIEW",
    firstIn: punches[0] ?? null,
    lastOut: punches.length > 1 ? punches[punches.length - 1] : null,
    scheduledMinutes: scheduled,
    workedMinutes: 0,
    breakMinutes: 0,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    overtimeCandidateMinutes: 0,
    reviewReason: null,
  };

  if (input.holiday) {
    return { ...empty, status: "OFF", scheduledMinutes: 0, reviewReason: null };
  }
  if (input.onLeave) {
    return { ...empty, status: "LEAVE", reviewReason: null };
  }
  if (shift && !isWorkingDay(shift, input.dateKey) && punches.length === 0) {
    return { ...empty, status: "OFF", scheduledMinutes: 0, reviewReason: null };
  }
  if (punches.length === 0) {
    return {
      ...empty,
      status: "NEEDS_REVIEW",
      reviewReason: "No punch on a scheduled working day.",
    };
  }
  if (punches.length % 2 !== 0) {
    return {
      ...empty,
      status: "INCOMPLETE",
      lastOut: null,
      reviewReason:
        punches.length === 1
          ? "Only one punch: no clock-out."
          : "An odd number of punches: one is missing.",
    };
  }

  // Paired in order: in, out, in, out. Anything else is a guess about which
  // punch was which, and a guess is what the review queue is for.
  let worked = 0;
  for (let i = 0; i < punches.length; i += 2) {
    worked += (punches[i + 1].getTime() - punches[i].getTime()) / 60000;
  }

  const firstIn = punches[0];
  const lastOut = punches[punches.length - 1];

  // An unpaid break is deducted only where the day is long enough to have
  // held one. Taking it off a two-hour visit invents time nobody was absent.
  let breakTaken = 0;
  if (shift && !shift.breakPaid && shift.breakMinutes > 0 && worked > shift.breakMinutes) {
    breakTaken = shift.breakMinutes;
    worked -= breakTaken;
  }
  worked = Math.max(0, Math.round(worked * 10000) / 10000);

  let late = 0;
  let earlyLeave = 0;
  if (shift) {
    const inMinute = shiftMinute(firstIn, shift, input.dateKey, timeZone);
    const outMinute = shiftMinute(lastOut, shift, input.dateKey, timeZone);
    const endMinute = shift.crossesMidnight
      ? shift.endMinute + DAY_MINUTES
      : shift.endMinute;

    /*
     * Grace decides whether lateness counts, not how much of it counts.
     *
     * Somebody ten minutes past a ten-minute tolerance is late by twenty, as
     * anybody in the building would say it — measuring from the end of grace
     * would make them late by ten and quietly hand back the tolerance twice.
     */
    const past = inMinute - shift.startMinute;
    late = past > shift.graceMinutes ? past : 0;
    earlyLeave = Math.max(0, endMinute - outMinute);
  }

  const overtimeCandidate = shift
    ? Math.max(0, worked - shift.overtimeAfterMinutes)
    : 0;

  const status: AttendanceStatus = late > 0 ? "LATE" : earlyLeave > 0 ? "EARLY_LEAVE" : "PRESENT";

  return {
    status,
    firstIn,
    lastOut,
    scheduledMinutes: scheduled,
    workedMinutes: worked,
    breakMinutes: breakTaken,
    lateMinutes: late,
    earlyLeaveMinutes: earlyLeave,
    overtimeCandidateMinutes: overtimeCandidate,
    reviewReason: null,
  };
}

/** Statuses a person still has to deal with before payroll can be prepared. */
export const UNRESOLVED_STATUSES: AttendanceStatus[] = ["NEEDS_REVIEW", "INCOMPLETE"];
