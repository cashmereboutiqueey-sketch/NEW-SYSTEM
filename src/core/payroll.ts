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

/**
 * How somebody is paid, which decides what their pay is made of.
 *
 * A monthly salary is an entitlement that absence reduces. A weekly or daily
 * wage is earned by turning up, so it is counted from days present rather than
 * deducted from a month nobody promised. Piece work is paid for what was made
 * and is not a time wage at all — absence and overtime mean nothing to it,
 * because the only thing that pays is output.
 */
export type PayBasis = "MONTHLY" | "WEEKLY" | "DAILY" | "PIECE_RATE";

export type PayInput = {
  basis?: PayBasis;
  /** Pay for one period of the basis: a month, a week, or a day. */
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

  /**
   * Of the period's working days, how many this person was employed for.
   * Somebody hired on the twentieth is owed the days from the twentieth, and
   * somebody who left mid-month is owed the days up to the day they left.
   * Defaults to the whole period.
   */
  daysEmployed?: Numeric;
  /** Days actually worked. What a weekly or daily wage is paid on. */
  daysPresent?: Numeric;
  /** Working days in a week, for turning a weekly wage into a daily one. */
  weekWorkingDays?: Numeric;
  /** Garments finished, for piece work. */
  piecesProduced?: Numeric;
  /** What one finished garment pays. */
  pieceRate?: Numeric;
};

export type PayResult = {
  basis: PayBasis;
  dailyRate: Decimal | null;
  minuteRate: Decimal | null;
  /** What the days or the pieces earned, before overtime and deductions. */
  earned: Decimal;
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
  const basis = input.basis ?? "MONTHLY";
  const base = dec(input.baseSalary);
  const standardDays = dec(input.standardDays);

  // The day and the minute this person's pay works out to, whatever period
  // their wage is quoted for. Everything below is priced off these two.
  const dailyRate =
    basis === "DAILY"
      ? base
      : basis === "WEEKLY"
        ? safeDiv(base, input.weekWorkingDays ?? 6)
        : safeDiv(base, standardDays);
  const minuteRate = dailyRate ? safeDiv(dailyRate, input.standardDayMinutes) : null;

  // Only part of the period, for somebody hired or leaving inside it. A month
  // nobody was employed for is not a month anybody is owed.
  const daysEmployed = input.daysEmployed != null ? dec(input.daysEmployed) : standardDays;
  const daysPresent = dec(input.daysPresent ?? 0);

  if (basis === "PIECE_RATE") {
    // Paid for what was made. Absence is not deducted from output and
    // overtime does not multiply it: the garments are the wage.
    const pieces = dec(input.piecesProduced ?? 0);
    const earned = pieces.times(dec(input.pieceRate ?? 0));
    const otherDeductions = dec(input.otherDeductions ?? 0);
    const employerCost = earned.times(dec(input.employerCostPct ?? 0));
    return {
      basis,
      dailyRate,
      minuteRate,
      earned,
      absenceDeduction: dec(0),
      overtimePay: dec(0),
      grossPay: earned,
      otherDeductions,
      netPay: earned.minus(otherDeductions),
      employerCost,
      totalCostToBusiness: earned.plus(employerCost),
    };
  }

  // A month is an entitlement that unpaid absence reduces; a week or a day is
  // earned by turning up, so it is counted rather than deducted.
  const entitlement =
    basis === "MONTHLY"
      ? dailyRate
        ? dailyRate.times(daysEmployed)
        : base
      : dailyRate
        ? dailyRate.times(daysPresent)
        : dec(0);

  const absenceDeduction =
    basis === "MONTHLY" && dailyRate ? dailyRate.times(dec(input.daysAbsentUnpaid)) : dec(0);

  const overtimePay = minuteRate
    ? minuteRate.times(dec(input.approvedOvertimeMinutes)).times(dec(input.overtimeMultiplier))
    : dec(0);

  // Absence reduces gross, so it also reduces the employer's percentage cost.
  const grossPay = entitlement.minus(absenceDeduction).plus(overtimePay);
  const otherDeductions = dec(input.otherDeductions ?? 0);
  const netPay = grossPay.minus(otherDeductions);
  const employerCost = grossPay.times(dec(input.employerCostPct ?? 0));

  return {
    basis,
    dailyRate,
    minuteRate,
    earned: entitlement,
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
