import { Decimal, dec, safeDiv, type Numeric } from "@/lib/money";

/**
 * Attendance and pay.
 *
 * Punches are evidence; attendance is what a supervisor approved. Keeping the
 * two apart is what lets a broken reader be corrected without rewriting the
 * record of what the device actually saw.
 */

export type Punch = { punchedAt: Date };

export type DerivedDay = {
  firstIn: Date | null;
  lastOut: Date | null;
  workedMinutes: Decimal;
  /** Odd number of punches — someone forgot to clock out. */
  incomplete: boolean;
};

/**
 * Turns a day's punches into worked minutes by pairing them in/out.
 *
 * An odd punch count is flagged rather than guessed at: assuming the missing
 * half is the end of the shift silently pays for hours nobody verified.
 */
export function deriveDay(punches: Punch[], breakMinutes: Numeric = 0): DerivedDay {
  if (punches.length === 0) {
    return { firstIn: null, lastOut: null, workedMinutes: dec(0), incomplete: false };
  }

  const sorted = [...punches].sort((a, b) => a.punchedAt.getTime() - b.punchedAt.getTime());
  const incomplete = sorted.length % 2 !== 0;

  let minutes = dec(0);
  for (let i = 0; i + 1 < sorted.length; i += 2) {
    const span = (sorted[i + 1].punchedAt.getTime() - sorted[i].punchedAt.getTime()) / 60000;
    minutes = minutes.plus(dec(span));
  }

  const worked = minutes.minus(dec(breakMinutes));

  return {
    firstIn: sorted[0].punchedAt,
    lastOut: incomplete ? null : sorted[sorted.length - 1].punchedAt,
    workedMinutes: worked.lessThan(0) ? dec(0) : worked,
    incomplete,
  };
}

/**
 * Splits worked time into ordinary and overtime.
 *
 * Overtime is only what a supervisor approved. Excess hours beyond the
 * standard day stay visible but unpaid until someone signs for them, so a
 * long day cannot quietly become a wage claim.
 */
export function splitOvertime(
  workedMinutes: Numeric,
  standardDayMinutes: Numeric,
  approvedOvertimeMinutes: Numeric = 0,
): { ordinaryMinutes: Decimal; overtimeMinutes: Decimal; unapprovedMinutes: Decimal } {
  const worked = dec(workedMinutes);
  const standard = dec(standardDayMinutes);
  const approved = dec(approvedOvertimeMinutes);

  const ordinary = Decimal.min(worked, standard);
  const excess = worked.minus(ordinary);
  const overtime = Decimal.min(excess, approved);

  return {
    ordinaryMinutes: ordinary,
    overtimeMinutes: overtime,
    unapprovedMinutes: excess.minus(overtime),
  };
}

export type PayInput = {
  baseSalary: Numeric;
  /** Working days in the period, from the capacity configuration. */
  standardDays: Numeric;
  standardDayMinutes: Numeric;
  daysAbsentUnpaid: Numeric;
  approvedOvertimeMinutes: Numeric;
  /** Multiplier on the ordinary minute rate, e.g. 1.5. */
  overtimeMultiplier: Numeric;
  otherDeductions?: Numeric;
  /** Employer-side social insurance, as a fraction of gross. */
  employerCostPct?: Numeric;
};

export type PayResult = {
  dailyRate: Decimal | null;
  minuteRate: Decimal | null;
  absenceDeduction: Decimal;
  overtimePay: Decimal;
  grossPay: Decimal;
  otherDeductions: Decimal;
  netPay: Decimal;
  employerCost: Decimal;
  /** What the business actually spends on this person. */
  totalCostToBusiness: Decimal;
};

export function calculatePay(input: PayInput): PayResult {
  const base = dec(input.baseSalary);
  const dailyRate = safeDiv(base, input.standardDays);
  const minuteRate = dailyRate ? safeDiv(dailyRate, input.standardDayMinutes) : null;

  const absenceDeduction = dailyRate
    ? dailyRate.times(dec(input.daysAbsentUnpaid))
    : dec(0);

  const overtimePay = minuteRate
    ? minuteRate.times(dec(input.approvedOvertimeMinutes)).times(dec(input.overtimeMultiplier))
    : dec(0);

  // Absence reduces gross, so it also reduces the employer's percentage cost.
  const grossPay = base.minus(absenceDeduction).plus(overtimePay);
  const otherDeductions = dec(input.otherDeductions ?? 0);
  const netPay = grossPay.minus(otherDeductions);
  const employerCost = grossPay.times(dec(input.employerCostPct ?? 0));

  return {
    dailyRate,
    minuteRate,
    absenceDeduction,
    overtimePay,
    grossPay,
    otherDeductions,
    netPay,
    employerCost,
    totalCostToBusiness: grossPay.plus(employerCost),
  };
}

/**
 * Attendance converted into capacity.
 *
 * The specification is explicit that absence reduces *available* capacity
 * rather than counting as inefficiency: a line that was short two operators
 * had fewer minutes to sell, which is a staffing fact, not a shop-floor
 * failure. Blending the two hides which problem you actually have.
 */
export function availableMinutesFromAttendance(
  days: { workedMinutes: Numeric; isAbsent: boolean; isLeave: boolean }[],
): { availableMinutes: Decimal; absentDays: number; leaveDays: number } {
  const present = days.filter((d) => !d.isAbsent && !d.isLeave);
  return {
    availableMinutes: present.reduce((s, d) => s.plus(dec(d.workedMinutes)), dec(0)),
    absentDays: days.filter((d) => d.isAbsent).length,
    leaveDays: days.filter((d) => d.isLeave).length,
  };
}
