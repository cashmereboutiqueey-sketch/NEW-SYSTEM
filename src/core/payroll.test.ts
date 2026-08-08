import { describe, it, expect } from "vitest";
import {
  deriveDay,
  splitOvertime,
  calculatePay,
  availableMinutesFromAttendance,
} from "./payroll";

const at = (hhmm: string) => new Date(`2026-08-03T${hhmm}:00.000Z`);

describe("deriving a day from punches", () => {
  it("pairs in and out punches", () => {
    const day = deriveDay([{ punchedAt: at("08:00") }, { punchedAt: at("17:00") }]);
    expect(day.workedMinutes.toString()).toBe("540");
    expect(day.incomplete).toBe(false);
  });

  it("subtracts an unpaid break", () => {
    const day = deriveDay([{ punchedAt: at("08:00") }, { punchedAt: at("17:00") }], 60);
    expect(day.workedMinutes.toString()).toBe("480");
  });

  it("handles a mid-day break as two pairs", () => {
    const day = deriveDay([
      { punchedAt: at("08:00") }, { punchedAt: at("12:00") },
      { punchedAt: at("13:00") }, { punchedAt: at("17:00") },
    ]);
    expect(day.workedMinutes.toString()).toBe("480");
  });

  it("sorts punches that arrive out of order", () => {
    const day = deriveDay([{ punchedAt: at("17:00") }, { punchedAt: at("08:00") }]);
    expect(day.workedMinutes.toString()).toBe("540");
    expect(day.firstIn).toEqual(at("08:00"));
  });

  it("flags a missing clock-out instead of guessing", () => {
    // Assuming the shift ended at closing time would pay for hours nobody saw.
    const day = deriveDay([{ punchedAt: at("08:00") }]);
    expect(day.incomplete).toBe(true);
    expect(day.workedMinutes.toString()).toBe("0");
    expect(day.lastOut).toBeNull();
  });

  it("returns an empty day when the reader recorded nothing", () => {
    const day = deriveDay([]);
    expect(day.workedMinutes.toString()).toBe("0");
    expect(day.incomplete).toBe(false);
  });

  it("never returns negative minutes when the break exceeds the shift", () => {
    const day = deriveDay([{ punchedAt: at("08:00") }, { punchedAt: at("08:30") }], 60);
    expect(day.workedMinutes.toString()).toBe("0");
  });
});

describe("overtime", () => {
  it("pays only the approved portion of extra time", () => {
    // Ten hours worked, two hours over, but only one approved.
    const split = splitOvertime(600, 480, 60);
    expect(split.ordinaryMinutes.toString()).toBe("480");
    expect(split.overtimeMinutes.toString()).toBe("60");
    expect(split.unapprovedMinutes.toString()).toBe("60");
  });

  it("pays no overtime when none was approved", () => {
    const split = splitOvertime(600, 480, 0);
    expect(split.overtimeMinutes.toString()).toBe("0");
    expect(split.unapprovedMinutes.toString()).toBe("120");
  });

  it("does not invent overtime from a short day", () => {
    const split = splitOvertime(400, 480, 120);
    expect(split.ordinaryMinutes.toString()).toBe("400");
    expect(split.overtimeMinutes.toString()).toBe("0");
  });

  it("caps overtime at the hours actually worked", () => {
    // Approving more than was worked must not create pay out of nothing.
    const split = splitOvertime(500, 480, 120);
    expect(split.overtimeMinutes.toString()).toBe("20");
  });
});

describe("pay calculation", () => {
  // A sewing operator on 6,700 EGP a month, 26 days, 8-hour days.
  const base = {
    baseSalary: "6700",
    standardDays: 26,
    standardDayMinutes: 480,
    daysAbsentUnpaid: 0,
    approvedOvertimeMinutes: 0,
    overtimeMultiplier: "1.5",
    employerCostPct: "0.1875",
  };

  it("derives the daily and minute rates", () => {
    const p = calculatePay(base);
    expect(p.dailyRate!.toFixed(4)).toBe("257.6923");
    expect(p.minuteRate!.toFixed(6)).toBe("0.536859");
  });

  it("pays the full salary for a full month", () => {
    const p = calculatePay(base);
    expect(p.grossPay.toString()).toBe("6700");
    expect(p.netPay.toString()).toBe("6700");
  });

  it("deducts unpaid absence at the daily rate", () => {
    const p = calculatePay({ ...base, daysAbsentUnpaid: 2 });
    expect(p.absenceDeduction.toFixed(2)).toBe("515.38");
    expect(p.grossPay.toFixed(2)).toBe("6184.62");
  });

  it("pays approved overtime at the multiplier", () => {
    // Two hours at 1.5×.
    const p = calculatePay({ ...base, approvedOvertimeMinutes: 120 });
    expect(p.overtimePay.toFixed(2)).toBe("96.63");
    expect(p.grossPay.toFixed(2)).toBe("6796.63");
  });

  it("adds employer cost on top of gross rather than inside it", () => {
    const p = calculatePay(base);
    expect(p.employerCost.toFixed(2)).toBe("1256.25");
    expect(p.totalCostToBusiness.toFixed(2)).toBe("7956.25");
    // The employee still receives their own gross, untouched.
    expect(p.netPay.toString()).toBe("6700");
  });

  it("reduces employer cost when absence reduces gross", () => {
    const full = calculatePay(base);
    const absent = calculatePay({ ...base, daysAbsentUnpaid: 3 });
    expect(absent.employerCost.lessThan(full.employerCost)).toBe(true);
  });

  it("applies other deductions to net, not to gross", () => {
    const p = calculatePay({ ...base, otherDeductions: "500" });
    expect(p.grossPay.toString()).toBe("6700");
    expect(p.netPay.toString()).toBe("6200");
    // Employer cost follows gross, so a loan repayment does not change it.
    expect(p.employerCost.toFixed(2)).toBe("1256.25");
  });

  it("reports no rate rather than dividing by zero for a period with no days", () => {
    const p = calculatePay({ ...base, standardDays: 0 });
    expect(p.dailyRate).toBeNull();
    expect(p.minuteRate).toBeNull();
    expect(p.overtimePay.toString()).toBe("0");
  });
});

describe("attendance and capacity", () => {
  it("counts absence as lost capacity, not as inefficiency", () => {
    // The specification is explicit: a line short two operators had fewer
    // minutes to sell. That is a staffing fact, not a shop-floor failure.
    const result = availableMinutesFromAttendance([
      { workedMinutes: 480, isAbsent: false, isLeave: false },
      { workedMinutes: 480, isAbsent: false, isLeave: false },
      { workedMinutes: 0, isAbsent: true, isLeave: false },
      { workedMinutes: 0, isAbsent: false, isLeave: true },
    ]);

    expect(result.availableMinutes.toString()).toBe("960");
    expect(result.absentDays).toBe(1);
    expect(result.leaveDays).toBe(1);
  });

  it("reports nothing available for a month nobody worked", () => {
    const result = availableMinutesFromAttendance([
      { workedMinutes: 0, isAbsent: true, isLeave: false },
    ]);
    expect(result.availableMinutes.toString()).toBe("0");
  });
});
