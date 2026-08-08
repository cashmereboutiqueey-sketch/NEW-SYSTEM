import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "./db";
import { postEntry, nextDocumentNumber } from "./ledger";
import { writeAudit, type AuditContext } from "./audit";
import { calculatePay, deriveDay } from "@/core/payroll";
import type { DraftLine } from "@/core/ledger";
import { violatesSeparationOfDuties } from "@/core/permissions";
import { dec } from "./money";

/**
 * Payroll.
 *
 * The rule that matters most: an employee's pay reaches the factory
 * conversion pool exactly once. It gets there through their cost centre's
 * account, and because the minute-rate pool is read from those accounts, a
 * second manual expense for the same wages would double the minute rate.
 *
 * Preparation and approval are separate acts by separate people, and posting
 * creates the accrual in the period earned regardless of when cash leaves.
 */

export class PayrollError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayrollError";
  }
}

const ACC = {
  ACCRUED_PAYROLL: "2210",
  /// Fallback when an employee has no cost centre account mapped.
  GENERAL_ADMIN: "6500",
} as const;

/** Cost-centre code → the account that person's pay is charged to. */
const COST_CENTRE_ACCOUNT: Record<string, string> = {
  "CC-FACTORY": "6110",
  "CC-BRAND": "6310",
  "CC-SHOWROOM-ALX": "6310",
  "CC-STORE-CAI": "6310",
  "CC-MARKETING": "6310",
  "CC-CORPORATE": "6510",
};

async function accountIdByCode(tx: Prisma.TransactionClient, code: string): Promise<string> {
  const a = await tx.account.findUnique({ where: { code }, select: { id: true } });
  if (!a) throw new PayrollError(`Account ${code} is missing from the chart of accounts.`);
  return a.id;
}

/**
 * Imports raw device punches.
 *
 * Idempotent by construction: the unique index on device, badge and timestamp
 * means re-importing yesterday's file changes nothing. Unmatched badges are
 * stored with a null employee so they surface as an exception rather than
 * silently disappearing.
 */
export async function importPunches(
  input: {
    deviceId: string;
    punches: { deviceUserId: string; punchedAt: Date; raw?: unknown }[];
  },
  ctx: AuditContext,
): Promise<{ imported: number; duplicates: number; unmatched: number }> {
  const employees = await db.employee.findMany({
    where: { biometricDeviceUserId: { not: null } },
    select: { id: true, biometricDeviceUserId: true },
  });
  const byDeviceUser = new Map(employees.map((e) => [e.biometricDeviceUserId!, e.id]));

  let imported = 0;
  let duplicates = 0;
  let unmatched = 0;

  for (const p of input.punches) {
    const employeeId = byDeviceUser.get(p.deviceUserId) ?? null;
    if (!employeeId) unmatched += 1;

    try {
      await db.biometricPunch.create({
        data: {
          deviceId: input.deviceId,
          deviceUserId: p.deviceUserId,
          employeeId,
          punchedAt: p.punchedAt,
          rawPayload: (p.raw ?? null) as Prisma.InputJsonValue,
        },
      });
      imported += 1;
    } catch (e) {
      // A replayed file is normal operation, not an error worth failing on.
      if (e instanceof Error && e.message.includes("Unique constraint")) {
        duplicates += 1;
        continue;
      }
      throw e;
    }
  }

  await db.$transaction(async (tx) => {
    await writeAudit(tx, {
      action: "BIOMETRIC_PUNCHES_IMPORTED",
      entityName: "BiometricPunch",
      entityId: input.deviceId,
      after: { device: input.deviceId, imported, duplicates, unmatched },
      ctx,
    });
  });

  return { imported, duplicates, unmatched };
}

/**
 * Builds approved attendance days from the punches on record.
 *
 * Existing days are left alone: once a supervisor has corrected a day, a
 * later re-derivation must not quietly overwrite their judgement.
 */
export async function deriveAttendance(
  input: { employeeId: string; from: Date; to: Date; breakMinutes?: number; standardDayMinutes?: number },
  ctx: AuditContext,
): Promise<{ daysCreated: number; incompleteDays: number }> {
  const punches = await db.biometricPunch.findMany({
    where: { employeeId: input.employeeId, punchedAt: { gte: input.from, lte: input.to } },
    orderBy: { punchedAt: "asc" },
  });

  const byDate = new Map<string, { punchedAt: Date }[]>();
  for (const p of punches) {
    const key = p.punchedAt.toISOString().slice(0, 10);
    byDate.set(key, [...(byDate.get(key) ?? []), { punchedAt: p.punchedAt }]);
  }

  let daysCreated = 0;
  let incompleteDays = 0;

  for (const [dateKey, dayPunches] of byDate) {
    const workDate = new Date(`${dateKey}T00:00:00.000Z`);
    const existing = await db.attendanceDay.findUnique({
      where: { employeeId_workDate: { employeeId: input.employeeId, workDate } },
    });
    if (existing) continue;

    const derived = deriveDay(dayPunches, input.breakMinutes ?? 0);
    if (derived.incomplete) incompleteDays += 1;

    await db.attendanceDay.create({
      data: {
        employeeId: input.employeeId,
        workDate,
        firstIn: derived.firstIn,
        lastOut: derived.lastOut,
        workedMinutes: derived.workedMinutes.toString(),
        source: "BIOMETRIC",
        // An unpaired punch is not absence — it is a missing clock-out, and
        // it must be resolved by a person before it affects pay.
        adjustmentReason: derived.incomplete ? "Missing clock-out; needs review" : null,
      },
    });
    daysCreated += 1;
  }

  await db.$transaction(async (tx) => {
    await writeAudit(tx, {
      action: "ATTENDANCE_DERIVED",
      entityName: "Employee",
      entityId: input.employeeId,
      after: { daysCreated, incompleteDays },
      ctx,
    });
  });

  return { daysCreated, incompleteDays };
}

/** Corrects a day, which always needs a reason — the punch stays untouched. */
export async function adjustAttendance(
  input: {
    employeeId: string;
    workDate: Date;
    workedMinutes?: string;
    overtimeMinutes?: string;
    isAbsent?: boolean;
    isLeave?: boolean;
    leaveType?: string | null;
    reason: string;
  },
  ctx: AuditContext,
): Promise<void> {
  if (!input.reason.trim()) {
    throw new PayrollError("An attendance correction needs a reason.");
  }

  await db.$transaction(async (tx) => {
    const before = await tx.attendanceDay.findUnique({
      where: { employeeId_workDate: { employeeId: input.employeeId, workDate: input.workDate } },
    });

    const data = {
      employeeId: input.employeeId,
      workDate: input.workDate,
      workedMinutes: input.workedMinutes ?? before?.workedMinutes.toString() ?? "0",
      overtimeMinutes: input.overtimeMinutes ?? before?.overtimeMinutes.toString() ?? "0",
      isAbsent: input.isAbsent ?? before?.isAbsent ?? false,
      isLeave: input.isLeave ?? before?.isLeave ?? false,
      leaveType: input.leaveType ?? before?.leaveType ?? null,
      source: "MANUAL" as const,
      adjustmentReason: input.reason,
      approvedByUserId: ctx.userId,
    };

    await tx.attendanceDay.upsert({
      where: { employeeId_workDate: { employeeId: input.employeeId, workDate: input.workDate } },
      create: data,
      update: data,
    });

    await writeAudit(tx, {
      action: "ATTENDANCE_ADJUSTED",
      entityName: "AttendanceDay",
      entityId: `${input.employeeId}:${input.workDate.toISOString().slice(0, 10)}`,
      before: before
        ? {
            workedMinutes: before.workedMinutes.toString(),
            isAbsent: before.isAbsent,
            source: before.source,
          }
        : undefined,
      after: {
        workedMinutes: data.workedMinutes,
        overtimeMinutes: data.overtimeMinutes,
        isAbsent: data.isAbsent,
        isLeave: data.isLeave,
      },
      ctx: { ...ctx, reason: input.reason },
    });
  });
}

async function settingNumber(key: string, fallback: string): Promise<string> {
  const row = await db.setting.findUnique({ where: { key } });
  return row?.value ?? fallback;
}

/** Prepares a draft run from approved attendance. Never posts. */
export async function preparePayrollRun(
  input: { entityId: string; fiscalPeriodId: string },
  ctx: AuditContext,
): Promise<{ payrollRunId: string; runNumber: string; employees: number; grossPay: string }> {
  const period = await db.fiscalPeriod.findUnique({ where: { id: input.fiscalPeriodId } });
  if (!period) throw new PayrollError("Fiscal period not found.");
  if (period.status === "CLOSED") {
    throw new PayrollError("That period is closed; payroll must be prepared in an open period.");
  }

  const existing = await db.payrollRun.findUnique({
    where: { entityId_fiscalPeriodId: { entityId: input.entityId, fiscalPeriodId: input.fiscalPeriodId } },
  });
  if (existing && existing.status !== "DRAFT") {
    throw new PayrollError(
      `Payroll for this period is already ${existing.status.toLowerCase()} and cannot be prepared again.`,
    );
  }

  const employees = await db.employee.findMany({
    where: { entityId: input.entityId, status: { not: "TERMINATED" } },
    include: { costCenter: true },
  });
  if (employees.length === 0) throw new PayrollError("No active employees for this entity.");

  const standardDays = await settingNumber("capacity.defaultWorkingDays", "26");
  const hoursPerDay = await settingNumber("capacity.defaultHoursPerDay", "8");
  const overtimeMultiplier = await settingNumber("payroll.overtimeMultiplier", "1.5");
  const employerCostPct = await settingNumber("payroll.employerCostPct", "0.1875");
  const standardDayMinutes = dec(hoursPerDay).times(60);

  return db.$transaction(async (tx) => {
    const runNumber = existing?.runNumber ?? (await nextDocumentNumber(tx, "PAY", period.startDate));

    if (existing) {
      await tx.payrollLine.deleteMany({ where: { payrollRunId: existing.id } });
    }

    const run = existing
      ? existing
      : await tx.payrollRun.create({
          data: {
            runNumber,
            entityId: input.entityId,
            fiscalPeriodId: input.fiscalPeriodId,
            status: "DRAFT",
            preparedByUserId: ctx.userId,
          },
        });

    let gross = dec(0);
    let deductions = dec(0);
    let net = dec(0);
    let employerTotal = dec(0);

    for (const e of employees) {
      const days = await tx.attendanceDay.findMany({
        where: {
          employeeId: e.id,
          workDate: { gte: period.startDate, lte: period.endDate },
        },
      });

      const absentDays = days.filter((d) => d.isAbsent && !d.isLeave).length;
      const approvedOvertime = days.reduce(
        (s, d) => s.plus(dec(d.overtimeMinutes)), dec(0),
      );
      const workedMinutes = days.reduce((s, d) => s.plus(dec(d.workedMinutes)), dec(0));

      const pay = calculatePay({
        baseSalary: e.baseSalary.toString(),
        standardDays,
        standardDayMinutes,
        daysAbsentUnpaid: absentDays,
        approvedOvertimeMinutes: approvedOvertime,
        overtimeMultiplier,
        employerCostPct,
      });

      const accountCode = e.costCenter
        ? COST_CENTRE_ACCOUNT[e.costCenter.code] ?? ACC.GENERAL_ADMIN
        : ACC.GENERAL_ADMIN;

      await tx.payrollLine.create({
        data: {
          payrollRunId: run.id,
          employeeId: e.id,
          baseSalary: e.baseSalary,
          overtimePay: pay.overtimePay.toString(),
          absenceDeduction: pay.absenceDeduction.toString(),
          otherDeductions: "0",
          grossPay: pay.grossPay.toString(),
          netPay: pay.netPay.toString(),
          employerCost: pay.employerCost.toString(),
          workedMinutes: workedMinutes.toString(),
          overtimeMinutes: approvedOvertime.toString(),
          absentDays,
          accountId: await accountIdByCode(tx, accountCode),
        },
      });

      gross = gross.plus(pay.grossPay);
      deductions = deductions.plus(pay.absenceDeduction).plus(pay.otherDeductions);
      net = net.plus(pay.netPay);
      employerTotal = employerTotal.plus(pay.employerCost);
    }

    await tx.payrollRun.update({
      where: { id: run.id },
      data: {
        grossPay: gross.toString(),
        deductions: deductions.toString(),
        netPay: net.toString(),
        employerCost: employerTotal.toString(),
        preparedByUserId: ctx.userId,
      },
    });

    await writeAudit(tx, {
      action: "PAYROLL_PREPARED",
      entityName: "PayrollRun",
      entityId: run.id,
      after: { runNumber, employees: employees.length, grossPay: gross.toString() },
      ctx,
    });

    return {
      payrollRunId: run.id,
      runNumber,
      employees: employees.length,
      grossPay: gross.toString(),
    };
  });
}

/**
 * Approves and posts a run.
 *
 *   DR wage accounts (per employee's cost centre)   CR accrued payroll
 *
 * The accrual lands in the period earned, whatever month the cash leaves in.
 * Approval is refused to whoever prepared the run.
 */
export async function approveAndPostPayroll(
  input: { payrollRunId: string; postingDate?: Date },
  ctx: AuditContext,
): Promise<{ journalEntryNumber: string; totalCharged: string }> {
  const run = await db.payrollRun.findUnique({
    where: { id: input.payrollRunId },
    include: { lines: { include: { account: true, employee: true } }, fiscalPeriod: true },
  });
  if (!run) throw new PayrollError("Payroll run not found.");
  if (run.status === "POSTED") throw new PayrollError("That payroll run is already posted.");
  if (run.lines.length === 0) throw new PayrollError("The run has no lines to post.");

  if (
    ctx.userId &&
    violatesSeparationOfDuties({
      creatorUserId: run.preparedByUserId,
      approverUserId: ctx.userId,
      createPermission: "payroll:prepare",
      approvePermission: "payroll:approve",
    })
  ) {
    throw new PayrollError(
      "Payroll must be approved by someone other than the person who prepared it.",
    );
  }

  const postingDate = input.postingDate ?? run.fiscalPeriod.endDate;

  return db.$transaction(async (tx) => {
    // One line per wage account, so the ledger mirrors the cost centres
    // rather than listing every employee by name in the journal.
    const byAccount = new Map<string, ReturnType<typeof dec>>();
    for (const l of run.lines) {
      const accountId = l.accountId!;
      const charge = dec(l.grossPay).plus(dec(l.employerCost));
      byAccount.set(accountId, (byAccount.get(accountId) ?? dec(0)).plus(charge));
    }

    const totalCharged = [...byAccount.values()].reduce((s, v) => s.plus(v), dec(0));

    const lines: DraftLine[] = [...byAccount.entries()].map(([accountId, amount]) => ({
      accountId,
      debit: amount,
      entityId: run.entityId,
      description: `Payroll ${run.runNumber}`,
    }));

    lines.push({
      accountId: await accountIdByCode(tx, ACC.ACCRUED_PAYROLL),
      credit: totalCharged,
      entityId: run.entityId,
      description: `Payroll accrued ${run.runNumber}`,
    });

    const journal = await postEntry(tx, {
      entityId: run.entityId,
      postingDate,
      sourceType: "PAYROLL",
      sourceId: run.id,
      memo: `Payroll ${run.runNumber}`,
      ctx,
      lines,
    });

    await tx.payrollRun.update({
      where: { id: run.id },
      data: {
        status: "POSTED",
        approvedByUserId: ctx.userId,
        approvedAt: new Date(),
        postedAt: new Date(),
        journalEntryId: journal.id,
      },
    });

    await writeAudit(tx, {
      action: "PAYROLL_POSTED",
      entityName: "PayrollRun",
      entityId: run.id,
      before: { status: run.status },
      after: {
        status: "POSTED",
        totalCharged: totalCharged.toString(),
        journalEntry: journal.entryNumber,
        accounts: byAccount.size,
      },
      ctx,
    });

    return { journalEntryNumber: journal.entryNumber, totalCharged: totalCharged.toString() };
  });
}
