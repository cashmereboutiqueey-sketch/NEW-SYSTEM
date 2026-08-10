import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import {
  importPunches, deriveAttendance, adjustAttendance,
  preparePayrollRun, approveAndPostPayroll, PayrollError,
} from "./payroll";
import { readCostPool } from "./minute-rate";
import { dec } from "./money";

/** HR and payroll against a real database. */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let factoryId: string;
let periodId: string;
let periodStart: Date;
let factoryCcId: string;
let preparerId: string;
let approverId: string;

const ctx = { userId: null as string | null, reason: null };
let seq = 0;

beforeAll(async () => {
  factoryId = (await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } })).id;
  factoryCcId = (await db.costCenter.findFirstOrThrow({ where: { code: "CC-FACTORY" } })).id;
  preparerId = (await db.user.findFirstOrThrow({ where: { email: "accountant@cashmere.eg" } })).id;
  approverId = (await db.user.findFirstOrThrow({ where: { email: "owner@cashmere.eg" } })).id;

  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" }, orderBy: { startDate: "asc" },
  });
  periodId = period.id;
  periodStart = new Date(period.startDate);
});

async function wipe() {
  await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
  await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
  try {
    await db.payrollLine.deleteMany({});
    await db.payrollRun.deleteMany({});
    await db.attendanceDay.deleteMany({});
    await db.biometricPunch.deleteMany({});
    await db.employee.deleteMany({});
    await db.bankStatementLine.deleteMany({});
    await db.bankStatement.deleteMany({});
    await db.journalLine.deleteMany({});
    await db.journalEntry.deleteMany({});
    await db.auditLog.deleteMany({});
    await db.documentSequence.deleteMany({});
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
  }
}

async function makeEmployee(over: { salary?: string; device?: string; costCenterId?: string } = {}) {
  return db.employee.create({
    data: {
      code: `EMP-${seq++}`,
      name: "عامل إنتاج",
      entityId: factoryId,
      costCenterId: over.costCenterId ?? factoryCcId,
      hiredAt: periodStart,
      baseSalary: over.salary ?? "6700",
      biometricDeviceUserId: over.device ?? null,
    },
  });
}

const dayAt = (dayOffset: number, hhmm: string) => {
  const d = new Date(periodStart);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  const [h, m] = hhmm.split(":").map(Number);
  d.setUTCHours(h, m, 0, 0);
  return d;
};

beforeEach(wipe);
afterAll(async () => { await wipe(); await db.$disconnect(); });

describe("biometric import", () => {
  it("maps punches to employees by device badge", async () => {
    const e = await makeEmployee({ device: "BADGE-1" });
    const r = await importPunches(
      {
        deviceId: "DEV-A",
        punches: [
          { deviceUserId: "BADGE-1", punchedAt: dayAt(0, "08:00") },
          { deviceUserId: "BADGE-1", punchedAt: dayAt(0, "17:00") },
        ],
      },
      ctx,
    );

    expect(r.imported).toBe(2);
    expect(r.unmatched).toBe(0);
    expect(await db.biometricPunch.count({ where: { employeeId: e.id } })).toBe(2);
  });

  it("is idempotent when the same file is imported twice", async () => {
    await makeEmployee({ device: "BADGE-1" });
    const punches = [
      { deviceUserId: "BADGE-1", punchedAt: dayAt(0, "08:00") },
      { deviceUserId: "BADGE-1", punchedAt: dayAt(0, "17:00") },
    ];

    await importPunches({ deviceId: "DEV-A", punches }, ctx);
    const second = await importPunches({ deviceId: "DEV-A", punches }, ctx);

    // A replayed device file must change nothing.
    expect(second.imported).toBe(0);
    expect(second.duplicates).toBe(2);
    expect(await db.biometricPunch.count()).toBe(2);
  });

  it("keeps an unknown badge as evidence rather than dropping it", async () => {
    const r = await importPunches(
      { deviceId: "DEV-A", punches: [{ deviceUserId: "GHOST", punchedAt: dayAt(0, "08:00") }] },
      ctx,
    );
    expect(r.unmatched).toBe(1);
    const orphan = await db.biometricPunch.findFirstOrThrow({ where: { deviceUserId: "GHOST" } });
    expect(orphan.employeeId).toBeNull();
  });
});

describe("attendance", () => {
  it("derives worked minutes from paired punches", async () => {
    const e = await makeEmployee({ device: "B1" });
    await importPunches(
      {
        deviceId: "DEV-A",
        punches: [
          { deviceUserId: "B1", punchedAt: dayAt(0, "08:00") },
          { deviceUserId: "B1", punchedAt: dayAt(0, "17:00") },
        ],
      },
      ctx,
    );

    await deriveAttendance(
      { employeeId: e.id, from: dayAt(0, "00:00"), to: dayAt(1, "00:00"), breakMinutes: 60 },
      ctx,
    );

    const day = await db.attendanceDay.findFirstOrThrow({ where: { employeeId: e.id } });
    expect(day.workedMinutes.toString()).toBe("480");
    expect(day.source).toBe("BIOMETRIC");
  });

  it("flags a missing clock-out for review instead of guessing", async () => {
    const e = await makeEmployee({ device: "B1" });
    await importPunches(
      { deviceId: "DEV-A", punches: [{ deviceUserId: "B1", punchedAt: dayAt(0, "08:00") }] },
      ctx,
    );

    const r = await deriveAttendance(
      { employeeId: e.id, from: dayAt(0, "00:00"), to: dayAt(1, "00:00") }, ctx,
    );
    expect(r.incompleteDays).toBe(1);

    const day = await db.attendanceDay.findFirstOrThrow({ where: { employeeId: e.id } });
    expect(day.adjustmentReason).toMatch(/missing clock-out/i);
    expect(day.workedMinutes.toString()).toBe("0");
  });

  it("does not overwrite a day a supervisor already corrected", async () => {
    const e = await makeEmployee({ device: "B1" });
    await adjustAttendance(
      {
        employeeId: e.id, workDate: dayAt(0, "00:00"),
        workedMinutes: "480", reason: "Reader was down; confirmed present",
      },
      { userId: approverId, reason: null },
    );

    await importPunches(
      { deviceId: "DEV-A", punches: [{ deviceUserId: "B1", punchedAt: dayAt(0, "08:00") }] },
      ctx,
    );
    await deriveAttendance({ employeeId: e.id, from: dayAt(0, "00:00"), to: dayAt(1, "00:00") }, ctx);

    const day = await db.attendanceDay.findFirstOrThrow({ where: { employeeId: e.id } });
    expect(day.workedMinutes.toString()).toBe("480");
    expect(day.source).toBe("MANUAL");
  });

  it("requires a reason for a correction and records who made it", async () => {
    const e = await makeEmployee();
    await expect(
      adjustAttendance(
        { employeeId: e.id, workDate: dayAt(0, "00:00"), isAbsent: true, reason: "  " },
        ctx,
      ),
    ).rejects.toThrow(/needs a reason/i);

    await adjustAttendance(
      { employeeId: e.id, workDate: dayAt(0, "00:00"), isAbsent: true, reason: "Unauthorised absence" },
      { userId: approverId, reason: null },
    );

    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "ATTENDANCE_ADJUSTED" } });
    expect(audit.reason).toMatch(/unauthorised/i);
    expect(audit.userId).toBe(approverId);
  });
});

describe("payroll run", () => {
  it("pays a full salary when nobody was absent", async () => {
    await makeEmployee({ salary: "6700" });
    const run = await preparePayrollRun(
      { entityId: factoryId, fiscalPeriodId: periodId }, { userId: preparerId, reason: null },
    );

    expect(run.employees).toBe(1);
    expect(Number(run.grossPay)).toBeCloseTo(6700, 2);
  });

  it("deducts unpaid absence from gross", async () => {
    const e = await makeEmployee({ salary: "6700" });
    await adjustAttendance(
      { employeeId: e.id, workDate: dayAt(0, "00:00"), isAbsent: true, reason: "Absent" },
      { userId: approverId, reason: null },
    );

    const run = await preparePayrollRun(
      { entityId: factoryId, fiscalPeriodId: periodId }, { userId: preparerId, reason: null },
    );
    // One day at 6700/26.
    expect(Number(run.grossPay)).toBeCloseTo(6700 - 6700 / 26, 2);
  });

  it("pays only approved overtime", async () => {
    const e = await makeEmployee({ salary: "6700" });
    await adjustAttendance(
      {
        employeeId: e.id, workDate: dayAt(0, "00:00"),
        workedMinutes: "600", overtimeMinutes: "0", reason: "Long day, overtime not approved",
      },
      { userId: approverId, reason: null },
    );

    const noOt = await preparePayrollRun(
      { entityId: factoryId, fiscalPeriodId: periodId }, { userId: preparerId, reason: null },
    );
    expect(Number(noOt.grossPay)).toBeCloseTo(6700, 2);

    await adjustAttendance(
      {
        employeeId: e.id, workDate: dayAt(0, "00:00"),
        workedMinutes: "600", overtimeMinutes: "120", reason: "Overtime approved by supervisor",
      },
      { userId: approverId, reason: null },
    );
    const withOt = await preparePayrollRun(
      { entityId: factoryId, fiscalPeriodId: periodId }, { userId: preparerId, reason: null },
    );
    expect(Number(withOt.grossPay)).toBeGreaterThan(6700);
  });

  it("refuses preparation in a closed period", async () => {
    const closed = await db.fiscalPeriod.findFirstOrThrow({ where: { status: "CLOSED" } });
    await makeEmployee();
    await expect(
      preparePayrollRun({ entityId: factoryId, fiscalPeriodId: closed.id }, ctx),
    ).rejects.toThrow(/closed/i);
  });
});

describe("posting payroll", () => {
  it("charges factory wages to the conversion pool exactly once", async () => {
    await makeEmployee({ salary: "6700" });
    const run = await preparePayrollRun(
      { entityId: factoryId, fiscalPeriodId: periodId }, { userId: preparerId, reason: null },
    );
    await approveAndPostPayroll(
      { payrollRunId: run.payrollRunId }, { userId: approverId, reason: null },
    );

    // The minute-rate pool reads posted debits on conversion accounts. Wages
    // must appear there once — a second manual expense would double the rate.
    const pool = await readCostPool(factoryId, periodId);
    const labour = pool.components.find((c) => c.accountCode === "6110");
    expect(labour).toBeDefined();

    const gross = dec(run.grossPay);
    const employerCost = gross.times("0.1875");
    expect(Number(labour!.amount)).toBeCloseTo(Number(gross.plus(employerCost)), 2);
  });

  it("accrues the liability rather than assuming cash left", async () => {
    await makeEmployee({ salary: "6700" });
    const run = await preparePayrollRun(
      { entityId: factoryId, fiscalPeriodId: periodId }, { userId: preparerId, reason: null },
    );
    const posted = await approveAndPostPayroll(
      { payrollRunId: run.payrollRunId }, { userId: approverId, reason: null },
    );

    const [accrued] = await db.$queryRaw<{ balance: string }[]>`
      SELECT COALESCE(SUM(l."credit") - SUM(l."debit"), 0)::text AS balance
      FROM "journal_lines" l
      JOIN "journal_entries" e ON e."id" = l."journalEntryId"
      JOIN "accounts" a ON a."id" = l."accountId"
      WHERE a."code" = '2210' AND e."status" = 'POSTED'
    `;
    expect(Number(accrued.balance)).toBeCloseTo(Number(posted.totalCharged), 2);
  });

  it("refuses approval by the person who prepared it", async () => {
    await makeEmployee();
    const run = await preparePayrollRun(
      { entityId: factoryId, fiscalPeriodId: periodId }, { userId: preparerId, reason: null },
    );

    await expect(
      approveAndPostPayroll({ payrollRunId: run.payrollRunId }, { userId: preparerId, reason: null }),
    ).rejects.toThrow(/other than the person who prepared it/i);
  });

  it("refuses to post the same run twice", async () => {
    await makeEmployee();
    const run = await preparePayrollRun(
      { entityId: factoryId, fiscalPeriodId: periodId }, { userId: preparerId, reason: null },
    );
    await approveAndPostPayroll({ payrollRunId: run.payrollRunId }, { userId: approverId, reason: null });

    await expect(
      approveAndPostPayroll({ payrollRunId: run.payrollRunId }, { userId: approverId, reason: null }),
    ).rejects.toThrow(/already posted/i);
  });

  it("refuses to re-prepare a posted run", async () => {
    await makeEmployee();
    const run = await preparePayrollRun(
      { entityId: factoryId, fiscalPeriodId: periodId }, { userId: preparerId, reason: null },
    );
    await approveAndPostPayroll({ payrollRunId: run.payrollRunId }, { userId: approverId, reason: null });

    await expect(
      preparePayrollRun({ entityId: factoryId, fiscalPeriodId: periodId }, { userId: preparerId, reason: null }),
    ).rejects.toThrow(PayrollError);
  });

  it("keeps the ledger balanced", async () => {
    await makeEmployee({ salary: "6700" });
    await makeEmployee({ salary: "9200" });
    const run = await preparePayrollRun(
      { entityId: factoryId, fiscalPeriodId: periodId }, { userId: preparerId, reason: null },
    );
    await approveAndPostPayroll({ payrollRunId: run.payrollRunId }, { userId: approverId, reason: null });

    const [row] = await db.$queryRaw<{ debit: string; credit: string }[]>`
      SELECT COALESCE(SUM(l."debit"), 0)::text AS debit,
             COALESCE(SUM(l."credit"), 0)::text AS credit
      FROM "journal_lines" l
      JOIN "journal_entries" e ON e."id" = l."journalEntryId"
      WHERE e."status" = 'POSTED'
    `;
    expect(row.debit).toBe(row.credit);
  });
});
