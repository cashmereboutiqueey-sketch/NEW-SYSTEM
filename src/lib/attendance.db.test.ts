import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import {
  createShift,
  assignShift,
  previewImport,
  commitImport,
  linkBadge,
  deriveRange,
  correctDay,
  reviewDay,
  decideOvertime,
  lockAttendancePeriod,
  unresolvedCount,
  AttendanceError,
} from "./attendance";
import { preparePayrollRun, PayrollError } from "./payroll";
import { cairoParts } from "@/core/attendance";

/**
 * Attendance against a real database.
 *
 * The cases here are the ones that cost somebody money when they go wrong: a
 * file loaded twice, a badge nobody recognises, a missing clock-out, a night
 * shift, a correction, a locked month, and payroll reaching for a day that
 * nobody has settled.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let factoryId: string;
let factoryCcId: string;
let periodId: string;
let periodStart: Date;
let hrUserId: string;

const ctx = { userId: null as string | null, reason: null };
let seq = 0;

/** The month the fixtures work in, as Cairo names it. */
let monthKey: string;

beforeAll(async () => {
  factoryId = (await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } })).id;
  factoryCcId = (await db.costCenter.findFirstOrThrow({ where: { code: "CC-FACTORY" } })).id;
  hrUserId = (await db.user.findFirstOrThrow({ where: { email: "owner@cashmere.eg" } })).id;

  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" },
    orderBy: { startDate: "asc" },
  });
  periodId = period.id;
  periodStart = new Date(period.startDate);
  monthKey = periodStart.toISOString().slice(0, 7);
});

async function wipe() {
  await db.attendanceAdjustment.deleteMany({});
  await db.attendanceImportRow.deleteMany({});
  await db.attendanceImport.deleteMany({});
  await db.attendancePeriod.deleteMany({});
  await db.attendanceDay.deleteMany({});
  await db.biometricPunch.deleteMany({});
  await db.employeeShift.deleteMany({});
  await db.shift.deleteMany({});
  await db.payrollLine.deleteMany({});
  await db.payrollRun.deleteMany({});
  await db.employee.deleteMany({});
  await db.auditLog.deleteMany({});
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await db.$disconnect();
});

async function makeEmployee(over: { device?: string | null; name?: string } = {}) {
  return db.employee.create({
    data: {
      code: `ATT-${seq++}`,
      name: over.name ?? "عامل إنتاج",
      entityId: factoryId,
      costCenterId: factoryCcId,
      hiredAt: periodStart,
      baseSalary: "6700",
      biometricDeviceUserId: over.device === undefined ? `BADGE-${seq}` : over.device,
    },
  });
}

/** 09:00–17:00, Sunday to Thursday, thirty unpaid minutes, ten of grace. */
async function dayShift(over: Partial<Parameters<typeof createShift>[0]> = {}) {
  return createShift(
    {
      code: `SH-${seq++}`,
      nameEn: "Day",
      nameAr: "صباحي",
      startMinute: 540,
      endMinute: 1020,
      workingDays: [0, 1, 2, 3, 4],
      breakMinutes: 30,
      graceMinutes: 10,
      overtimeAfterMinutes: 450,
      ...over,
    },
    ctx,
  );
}

/** A date in the fixture month, as the device would write it. */
function at(day: number, hhmm: string): string {
  return `${monthKey}-${String(day).padStart(2, "0")} ${hhmm}`;
}

function csv(rows: string[]): string {
  return ["badge_id,timestamp,direction", ...rows].join("\n");
}

const mapping = { badge: "badge_id", timestamp: "timestamp", direction: "direction" };

async function importFile(text: string, device = "GATE-1") {
  const preview = await previewImport(
    { deviceId: device, filename: "export.csv", mapping, text },
    { userId: hrUserId, reason: null },
  );
  const result = await commitImport({ importId: preview.importId, text }, { userId: hrUserId, reason: null });
  return { preview, result };
}

describe("importing a device file", () => {
  it("writes nothing until the preview is confirmed", async () => {
    const employee = await makeEmployee({ device: "1001" });
    const text = csv([`1001,${at(6, "09:00")},IN`, `1001,${at(6, "17:00")},OUT`]);

    const preview = await previewImport(
      { deviceId: "GATE-1", filename: "export.csv", mapping, text },
      { userId: hrUserId, reason: null },
    );

    expect(preview.validRows).toBe(2);
    expect(await db.biometricPunch.count()).toBe(0);

    await commitImport({ importId: preview.importId, text }, { userId: hrUserId, reason: null });
    expect(await db.biometricPunch.count({ where: { employeeId: employee.id } })).toBe(2);
  });

  it("imports the same file twice without duplicating a single punch", async () => {
    await makeEmployee({ device: "1001" });
    const text = csv([`1001,${at(6, "09:00")},IN`, `1001,${at(6, "17:00")},OUT`]);

    const first = await importFile(text);
    expect(first.result.imported).toBe(2);

    const second = await importFile(text);
    expect(second.result.imported).toBe(0);
    expect(second.result.duplicates).toBe(2);
    expect(await db.biometricPunch.count()).toBe(2);
  });

  it("refuses to commit a different file than the one previewed", async () => {
    await makeEmployee({ device: "1001" });
    const previewed = csv([`1001,${at(6, "09:00")},IN`]);
    const swapped = csv([`1001,${at(6, "09:00")},IN`, `1001,${at(6, "23:00")},OUT`]);

    const preview = await previewImport(
      { deviceId: "GATE-1", filename: "export.csv", mapping, text: previewed },
      { userId: hrUserId, reason: null },
    );

    await expect(
      commitImport({ importId: preview.importId, text: swapped }, { userId: hrUserId, reason: null }),
    ).rejects.toThrow(/not the file that was previewed/i);
    expect(await db.biometricPunch.count()).toBe(0);
  });

  it("keeps every refused row with the reason it was refused", async () => {
    await makeEmployee({ device: "1001" });
    const text = csv([`1001,${at(6, "09:00")},IN`, `1001,rubbish,OUT`, `,${at(6, "17:00")},OUT`]);

    const preview = await previewImport(
      { deviceId: "GATE-1", filename: "export.csv", mapping, text },
      { userId: hrUserId, reason: null },
    );

    expect(preview.invalidRows).toBe(2);
    const rows = await db.attendanceImportRow.findMany({ where: { importId: preview.importId } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.reason).join(" ")).toMatch(/rubbish|badge/i);
  });

  it("records who loaded which file, from which device", async () => {
    await makeEmployee({ device: "1001" });
    const text = csv([`1001,${at(6, "09:00")},IN`]);
    const { preview } = await importFile(text, "GATE-2");

    const record = await db.attendanceImport.findUniqueOrThrow({ where: { id: preview.importId } });
    expect(record.deviceId).toBe("GATE-2");
    expect(record.filename).toBe("export.csv");
    expect(record.importedByUserId).toBe(hrUserId);
    expect(record.status).toBe("COMMITTED");
  });
});

describe("a badge nobody recognises", () => {
  it("is imported and surfaced, never discarded", async () => {
    const text = csv([`9999,${at(6, "09:00")},IN`, `9999,${at(6, "17:00")},OUT`]);
    const { preview, result } = await importFile(text);

    expect(preview.unknownBadges).toEqual(["9999"]);
    expect(result.unmatched).toBe(2);

    const orphans = await db.biometricPunch.findMany({ where: { employeeId: null } });
    expect(orphans).toHaveLength(2);
  });

  it("is claimed by the employee it is linked to, punches and all", async () => {
    const text = csv([`9999,${at(6, "09:00")},IN`, `9999,${at(6, "17:00")},OUT`]);
    await importFile(text);

    const employee = await makeEmployee({ device: null });
    const { claimed } = await linkBadge(
      { deviceUserId: "9999", employeeId: employee.id, reason: "New joiner's card" },
      { userId: hrUserId, reason: null },
    );

    expect(claimed).toBe(2);
    expect(await db.biometricPunch.count({ where: { employeeId: null } })).toBe(0);

    const after = await db.employee.findUniqueOrThrow({ where: { id: employee.id } });
    expect(after.biometricDeviceUserId).toBe("9999");
  });

  it("refuses a badge already belonging to somebody else", async () => {
    const taken = await makeEmployee({ device: "1001", name: "Sara" });
    const other = await makeEmployee({ device: null });

    await expect(
      linkBadge({ deviceUserId: "1001", employeeId: other.id }, { userId: hrUserId, reason: null }),
    ).rejects.toThrow(/already belongs to/i);

    const unchanged = await db.employee.findUniqueOrThrow({ where: { id: taken.id } });
    expect(unchanged.biometricDeviceUserId).toBe("1001");
  });
});

describe("deriving the day", () => {
  /** A Sunday in the fixture month, which every day shift works. */
  async function sundayIn(): Promise<number> {
    for (let d = 1; d <= 28; d += 1) {
      const key = `${monthKey}-${String(d).padStart(2, "0")}`;
      if (new Date(`${key}T12:00:00.000Z`).getUTCDay() === 0) return d;
    }
    throw new Error("no Sunday in the month");
  }

  it("reads a normal day as present, with the unpaid break taken off", async () => {
    const employee = await makeEmployee({ device: "1001" });
    const shift = await dayShift();
    await assignShift({ employeeId: employee.id, shiftId: shift.id, effectiveFrom: periodStart }, ctx);

    const day = await sundayIn();
    await importFile(csv([`1001,${at(day, "08:58")},IN`, `1001,${at(day, "17:02")},OUT`]));

    const key = `${monthKey}-${String(day).padStart(2, "0")}`;
    await deriveRange({ employeeIds: [employee.id], fromKey: key, toKey: key }, ctx);

    const row = await db.attendanceDay.findFirstOrThrow({ where: { employeeId: employee.id } });
    expect(row.status).toBe("PRESENT");
    expect(Number(row.workedMinutes)).toBe(8 * 60 + 4 - 30);
    expect(Number(row.lateMinutes)).toBe(0);
    expect(row.shiftId).toBe(shift.id);
  });

  it("is not late inside the grace period, and late by the whole delay outside it", async () => {
    const employee = await makeEmployee({ device: "1001" });
    const shift = await dayShift();
    await assignShift({ employeeId: employee.id, shiftId: shift.id, effectiveFrom: periodStart }, ctx);

    const day = await sundayIn();
    const key = `${monthKey}-${String(day).padStart(2, "0")}`;

    await importFile(csv([`1001,${at(day, "09:08")},IN`, `1001,${at(day, "17:00")},OUT`]));
    await deriveRange({ employeeIds: [employee.id], fromKey: key, toKey: key }, ctx);
    let row = await db.attendanceDay.findFirstOrThrow({ where: { employeeId: employee.id } });
    expect(row.status).toBe("PRESENT");

    await db.attendanceDay.deleteMany({});
    await db.biometricPunch.deleteMany({});
    await importFile(csv([`1001,${at(day, "09:30")},IN`, `1001,${at(day, "17:00")},OUT`]), "GATE-9");
    await deriveRange({ employeeIds: [employee.id], fromKey: key, toKey: key }, ctx);
    row = await db.attendanceDay.findFirstOrThrow({ where: { employeeId: employee.id } });
    expect(row.status).toBe("LATE");
    expect(Number(row.lateMinutes)).toBe(30);
  });

  it("calls a missing clock-out incomplete, and never absence", async () => {
    const employee = await makeEmployee({ device: "1001" });
    const shift = await dayShift();
    await assignShift({ employeeId: employee.id, shiftId: shift.id, effectiveFrom: periodStart }, ctx);

    const day = await sundayIn();
    const key = `${monthKey}-${String(day).padStart(2, "0")}`;
    await importFile(csv([`1001,${at(day, "09:00")},IN`]));
    await deriveRange({ employeeIds: [employee.id], fromKey: key, toKey: key }, ctx);

    const row = await db.attendanceDay.findFirstOrThrow({ where: { employeeId: employee.id } });
    expect(row.status).toBe("INCOMPLETE");
    expect(row.isAbsent).toBe(false);
    expect(Number(row.workedMinutes)).toBe(0);
  });

  it("keeps a night shift's hours on the evening it began", async () => {
    const employee = await makeEmployee({ device: "1001" });
    const shift = await dayShift({
      startMinute: 20 * 60,
      endMinute: 4 * 60,
      crossesMidnight: true,
      breakMinutes: 0,
      workingDays: [0, 1, 2, 3, 4, 5, 6],
    });
    await assignShift({ employeeId: employee.id, shiftId: shift.id, effectiveFrom: periodStart }, ctx);

    const day = 6;
    const key = `${monthKey}-06`;
    await importFile(csv([`1001,${at(day, "20:00")},IN`, `1001,${at(day + 1, "04:00")},OUT`]));
    await deriveRange({ employeeIds: [employee.id], fromKey: key, toKey: `${monthKey}-07` }, ctx);

    const rows = await db.attendanceDay.findMany({
      where: { employeeId: employee.id },
      orderBy: { workDate: "asc" },
    });
    const worked = rows.find((r) => Number(r.workedMinutes) > 0);
    expect(worked).toBeDefined();
    expect(cairoParts(worked!.workDate).dateKey).toBe(key);
    expect(Number(worked!.workedMinutes)).toBe(480);
    expect(worked!.status).toBe("PRESENT");
  });

  it("flags a scheduled day with no punch at all for review, not as absence", async () => {
    const employee = await makeEmployee({ device: "1001" });
    const shift = await dayShift();
    await assignShift({ employeeId: employee.id, shiftId: shift.id, effectiveFrom: periodStart }, ctx);

    const day = await sundayIn();
    const key = `${monthKey}-${String(day).padStart(2, "0")}`;
    await deriveRange({ employeeIds: [employee.id], fromKey: key, toKey: key }, ctx);

    const row = await db.attendanceDay.findFirstOrThrow({ where: { employeeId: employee.id } });
    expect(row.status).toBe("NEEDS_REVIEW");
    expect(row.isAbsent).toBe(false);
  });

  it("leaves a corrected day alone when it runs again", async () => {
    const employee = await makeEmployee({ device: "1001" });
    const shift = await dayShift();
    await assignShift({ employeeId: employee.id, shiftId: shift.id, effectiveFrom: periodStart }, ctx);

    const day = await sundayIn();
    const key = `${monthKey}-${String(day).padStart(2, "0")}`;
    await importFile(csv([`1001,${at(day, "09:00")},IN`]));
    await deriveRange({ employeeIds: [employee.id], fromKey: key, toKey: key }, ctx);

    const before = await db.attendanceDay.findFirstOrThrow({ where: { employeeId: employee.id } });
    await correctDay(
      { dayId: before.id, reason: "Reader missed the finger; supervisor confirms 17:00", workedMinutes: "450", status: "PRESENT" },
      { userId: hrUserId, reason: null },
    );

    await deriveRange({ employeeIds: [employee.id], fromKey: key, toKey: key }, ctx);

    const after = await db.attendanceDay.findFirstOrThrow({ where: { employeeId: employee.id } });
    expect(Number(after.workedMinutes)).toBe(450);
    expect(after.status).toBe("PRESENT");
    expect(after.source).toBe("MANUAL");
  });
});

describe("correcting a day", () => {
  async function aDayNeedingHelp() {
    const employee = await makeEmployee({ device: "1001" });
    const shift = await dayShift({ workingDays: [0, 1, 2, 3, 4, 5, 6] });
    await assignShift({ employeeId: employee.id, shiftId: shift.id, effectiveFrom: periodStart }, ctx);
    const key = `${monthKey}-06`;
    await importFile(csv([`1001,${at(6, "09:00")},IN`]));
    await deriveRange({ employeeIds: [employee.id], fromKey: key, toKey: key }, ctx);
    return db.attendanceDay.findFirstOrThrow({ where: { employeeId: employee.id } });
  }

  it("leaves the punches exactly as the device recorded them", async () => {
    const day = await aDayNeedingHelp();
    const before = await db.biometricPunch.findMany({ orderBy: { punchedAt: "asc" } });

    await correctDay(
      { dayId: day.id, reason: "Confirmed by the line supervisor", workedMinutes: "480", status: "PRESENT" },
      { userId: hrUserId, reason: null },
    );

    const after = await db.biometricPunch.findMany({ orderBy: { punchedAt: "asc" } });
    expect(after).toHaveLength(before.length);
    expect(after[0].punchedAt.toISOString()).toBe(before[0].punchedAt.toISOString());
  });

  it("refuses to change anything without a reason", async () => {
    const day = await aDayNeedingHelp();
    await expect(
      correctDay({ dayId: day.id, reason: "   ", workedMinutes: "480" }, { userId: hrUserId, reason: null }),
    ).rejects.toThrow(AttendanceError);
  });

  it("writes an adjustment holding what it was and what it became", async () => {
    const day = await aDayNeedingHelp();
    await correctDay(
      { dayId: day.id, reason: "Missed the reader on the way out", workedMinutes: "480", status: "PRESENT" },
      { userId: hrUserId, reason: null },
    );

    const adjustments = await db.attendanceAdjustment.findMany({ where: { dayId: day.id } });
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0].kind).toBe("CORRECTION");
    expect(adjustments[0].requestedByUserId).toBe(hrUserId);
    expect(JSON.stringify(adjustments[0].before)).toContain("INCOMPLETE");
    expect(JSON.stringify(adjustments[0].after)).toContain("PRESENT");
  });

  it("will not accept a day that is still incomplete", async () => {
    const day = await aDayNeedingHelp();
    await expect(reviewDay({ dayId: day.id }, { userId: hrUserId, reason: null })).rejects.toThrow(
      /correct it|nothing to accept/i,
    );
  });
});

describe("overtime", () => {
  async function aLongDay() {
    const employee = await makeEmployee({ device: "1001" });
    const shift = await dayShift({ workingDays: [0, 1, 2, 3, 4, 5, 6] });
    await assignShift({ employeeId: employee.id, shiftId: shift.id, effectiveFrom: periodStart }, ctx);
    const key = `${monthKey}-06`;
    await importFile(csv([`1001,${at(6, "09:00")},IN`, `1001,${at(6, "19:00")},OUT`]));
    await deriveRange({ employeeIds: [employee.id], fromKey: key, toKey: key }, ctx);
    return db.attendanceDay.findFirstOrThrow({ where: { employeeId: employee.id } });
  }

  it("is recorded as a candidate and paid nothing until somebody agrees", async () => {
    const day = await aLongDay();
    expect(Number(day.overtimeCandidateMinutes)).toBe(120);
    expect(Number(day.overtimeMinutes)).toBe(0);
  });

  it("is paid once approved, with the reason kept", async () => {
    const day = await aLongDay();
    await decideOvertime(
      { dayId: day.id, approve: true, reason: "Shipment deadline" },
      { userId: hrUserId, reason: null },
    );

    const after = await db.attendanceDay.findUniqueOrThrow({ where: { id: day.id } });
    expect(Number(after.overtimeMinutes)).toBe(120);
    expect(after.overtimeApprovedByUserId).toBe(hrUserId);

    const adjustment = await db.attendanceAdjustment.findFirstOrThrow({ where: { dayId: day.id } });
    expect(adjustment.kind).toBe("OVERTIME_APPROVAL");
    expect(adjustment.reason).toBe("Shipment deadline");
  });

  it("stays visible after it is refused, because the hours still happened", async () => {
    const day = await aLongDay();
    await decideOvertime(
      { dayId: day.id, approve: false, reason: "Not authorised in advance" },
      { userId: hrUserId, reason: null },
    );

    const after = await db.attendanceDay.findUniqueOrThrow({ where: { id: day.id } });
    expect(Number(after.overtimeMinutes)).toBe(0);
    expect(Number(after.overtimeCandidateMinutes)).toBe(120);
  });
});

describe("locking the month", () => {
  async function aSettledMonth() {
    const employee = await makeEmployee({ device: "1001" });
    const shift = await dayShift({ workingDays: [0, 1, 2, 3, 4, 5, 6] });
    await assignShift({ employeeId: employee.id, shiftId: shift.id, effectiveFrom: periodStart }, ctx);
    const key = `${monthKey}-06`;
    await importFile(csv([`1001,${at(6, "09:00")},IN`, `1001,${at(6, "17:00")},OUT`]));
    await deriveRange({ employeeIds: [employee.id], fromKey: key, toKey: key }, ctx);
    return { employee, key };
  }

  it("refuses while anything is still unresolved", async () => {
    const employee = await makeEmployee({ device: "1001" });
    const shift = await dayShift({ workingDays: [0, 1, 2, 3, 4, 5, 6] });
    await assignShift({ employeeId: employee.id, shiftId: shift.id, effectiveFrom: periodStart }, ctx);
    await importFile(csv([`1001,${at(6, "09:00")},IN`]));
    await deriveRange({ employeeIds: [employee.id], fromKey: `${monthKey}-06`, toKey: `${monthKey}-06` }, ctx);

    const [year, month] = monthKey.split("-").map(Number);
    await expect(
      lockAttendancePeriod({ entityId: factoryId, year, month }, { userId: hrUserId, reason: null }),
    ).rejects.toThrow(/still need review/i);
  });

  it("seals every day in the month once nothing is outstanding", async () => {
    await aSettledMonth();
    const [year, month] = monthKey.split("-").map(Number);

    const { daysLocked } = await lockAttendancePeriod(
      { entityId: factoryId, year, month },
      { userId: hrUserId, reason: null },
    );
    expect(daysLocked).toBeGreaterThan(0);

    const period = await db.attendancePeriod.findFirstOrThrow({ where: { entityId: factoryId, year, month } });
    expect(period.status).toBe("LOCKED");
  });

  it("refuses an ordinary correction afterwards", async () => {
    await aSettledMonth();
    const [year, month] = monthKey.split("-").map(Number);
    await lockAttendancePeriod({ entityId: factoryId, year, month }, { userId: hrUserId, reason: null });

    const day = await db.attendanceDay.findFirstOrThrow({});
    await expect(
      correctDay({ dayId: day.id, reason: "Changed my mind", workedMinutes: "400" }, { userId: hrUserId, reason: null }),
    ).rejects.toThrow(/locked/i);
  });

  it("takes a post-lock change only as its own kind of adjustment", async () => {
    await aSettledMonth();
    const [year, month] = monthKey.split("-").map(Number);
    await lockAttendancePeriod({ entityId: factoryId, year, month }, { userId: hrUserId, reason: null });

    const day = await db.attendanceDay.findFirstOrThrow({});
    await correctDay(
      { dayId: day.id, reason: "Tribunal finding: paid for the full day", workedMinutes: "480", afterLock: true },
      { userId: hrUserId, reason: null },
    );

    const adjustment = await db.attendanceAdjustment.findFirstOrThrow({
      where: { dayId: day.id },
      orderBy: { createdAt: "desc" },
    });
    expect(adjustment.kind).toBe("POST_LOCK");
  });
});

describe("payroll and attendance", () => {
  it("refuses to prepare a run while days in the month need review", async () => {
    const employee = await makeEmployee({ device: "1001" });
    const shift = await dayShift({ workingDays: [0, 1, 2, 3, 4, 5, 6] });
    await assignShift({ employeeId: employee.id, shiftId: shift.id, effectiveFrom: periodStart }, ctx);
    await importFile(csv([`1001,${at(6, "09:00")},IN`]));
    await deriveRange({ employeeIds: [employee.id], fromKey: `${monthKey}-06`, toKey: `${monthKey}-06` }, ctx);

    await expect(
      preparePayrollRun({ entityId: factoryId, fiscalPeriodId: periodId }, { userId: hrUserId, reason: null }),
    ).rejects.toThrow(PayrollError);
  });

  it("warns rather than blocks where the month was never brought into attendance", async () => {
    // Nothing derived: no attendance period exists, which is every month
    // worked before this module and every business not yet using it.
    await makeEmployee({ device: "1001" });
    const run = await preparePayrollRun(
      { entityId: factoryId, fiscalPeriodId: periodId },
      { userId: hrUserId, reason: null },
    );
    expect(run.warnings.join(" ")).toMatch(/no attendance period/i);
  });

  it("counts the unresolved for a period so a screen can say what is outstanding", async () => {
    const employee = await makeEmployee({ device: "1001" });
    const shift = await dayShift({ workingDays: [0, 1, 2, 3, 4, 5, 6] });
    await assignShift({ employeeId: employee.id, shiftId: shift.id, effectiveFrom: periodStart }, ctx);
    await importFile(csv([`1001,${at(6, "09:00")},IN`, `1001,${at(7, "09:00")},IN`, `1001,${at(7, "19:00")},OUT`]));
    await deriveRange({ employeeIds: [employee.id], fromKey: `${monthKey}-06`, toKey: `${monthKey}-07` }, ctx);

    const [year, month] = monthKey.split("-").map(Number);
    const counts = await unresolvedCount(factoryId, year, month);
    expect(counts.incomplete).toBe(1);
    expect(counts.overtimePending).toBe(1);
  });
});
