import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "./db";
import { command } from "./command";
import { writeAudit, type AuditContext } from "./audit";
import {
  CAIRO,
  cairoDateOnly,
  deriveAttendance,
  shiftDateKey,
  workDateFor,
  UNRESOLVED_STATUSES,
  type ShiftRule,
} from "@/core/attendance";
import {
  classifyImport,
  parseDelimited,
  punchKey,
  type ColumnMapping,
} from "@/core/attendance-import";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Attendance: device files in, a defensible day out.
 *
 * The shape of this module follows one rule that was already here and is worth
 * restating: a punch is evidence and is never edited, while a day is a
 * judgement and always can be. Everything below either records evidence,
 * derives a judgement from it, or records somebody changing that judgement and
 * why.
 *
 * Nothing here knows what brand of reader produced a file. Import takes a
 * table and a mapping; a device API added later produces the same table.
 */

export class AttendanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttendanceError";
  }
}

/* ------------------------------------------------------------------ shifts */

export const shiftSchema = z.object({
  code: z.string().min(1, "A shift needs a code."),
  nameEn: z.string().min(1, "A shift needs an English name."),
  nameAr: z.string().min(1, "A shift needs an Arabic name."),
  startMinute: z.coerce.number().int().min(0).max(1439),
  endMinute: z.coerce.number().int().min(0).max(1439),
  crossesMidnight: z.boolean().optional(),
  workingDays: z.array(z.coerce.number().int().min(0).max(6)).min(1, "Pick at least one working day."),
  breakMinutes: z.coerce.number().int().min(0).max(480).optional(),
  breakPaid: z.boolean().optional(),
  graceMinutes: z.coerce.number().int().min(0).max(240).optional(),
  overtimeAfterMinutes: z.coerce.number().int().min(0).max(1440).optional(),
  department: z.string().nullable().optional(),
  lineId: z.string().nullable().optional(),
});

export type ShiftInput = z.input<typeof shiftSchema>;

export async function createShift(input: ShiftInput, ctx: AuditContext) {
  const data = shiftSchema.parse(input);

  // Declared, never inferred: a shift from 20:00 to 04:00 crosses midnight and
  // one from 09:00 to 09:00 is a full day. The difference is eight hours of
  // somebody's pay, and no rule of thumb can tell them apart.
  const crossesMidnight = data.crossesMidnight ?? false;
  if (!crossesMidnight && data.endMinute <= data.startMinute) {
    throw new AttendanceError(
      "This shift ends before it starts. Tick that it crosses midnight, or correct the times.",
    );
  }

  const clash = await db.shift.findUnique({ where: { code: data.code } });
  if (clash) throw new AttendanceError(`Shift code ${data.code} is already in use.`);

  return db.$transaction(async (tx) => {
    const shift = await tx.shift.create({
      data: {
        code: data.code,
        nameEn: data.nameEn,
        nameAr: data.nameAr,
        startMinute: data.startMinute,
        endMinute: data.endMinute,
        crossesMidnight,
        workingDays: data.workingDays,
        breakMinutes: data.breakMinutes ?? 0,
        breakPaid: data.breakPaid ?? false,
        graceMinutes: data.graceMinutes ?? 0,
        overtimeAfterMinutes: data.overtimeAfterMinutes ?? 480,
        department: data.department ?? null,
        lineId: data.lineId ?? null,
      },
    });

    await writeAudit(tx, {
      action: "SHIFT_CREATED",
      entityName: "Shift",
      entityId: shift.id,
      after: {
        code: shift.code,
        start: shift.startMinute,
        end: shift.endMinute,
        crossesMidnight: shift.crossesMidnight,
      },
      ctx,
    });
    return shift;
  });
}

/**
 * Puts somebody on a shift from a date.
 *
 * Dated rather than replaced, so a month already worked keeps being judged
 * against the pattern it was actually worked under. The previous assignment is
 * closed the day before, which is what "from Sunday" means to the person
 * saying it.
 */
export async function assignShift(
  input: { employeeId: string; shiftId: string; effectiveFrom: Date },
  ctx: AuditContext,
) {
  return command("attendance.assignShift", input, ctx, async () => {
    const [employee, shift] = await Promise.all([
      db.employee.findUnique({ where: { id: input.employeeId }, select: { id: true, name: true } }),
      db.shift.findUnique({ where: { id: input.shiftId }, select: { id: true, code: true } }),
    ]);
    if (!employee) throw new AttendanceError("Employee not found.");
    if (!shift) throw new AttendanceError("Shift not found.");

    return db.$transaction(async (tx) => {
      const open = await tx.employeeShift.findFirst({
        where: { employeeId: input.employeeId, effectiveTo: null },
        orderBy: { effectiveFrom: "desc" },
      });
      if (open) {
        const dayBefore = new Date(input.effectiveFrom);
        dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
        await tx.employeeShift.update({
          where: { id: open.id },
          data: { effectiveTo: dayBefore },
        });
      }

      const assignment = await tx.employeeShift.create({
        data: {
          employeeId: input.employeeId,
          shiftId: input.shiftId,
          effectiveFrom: input.effectiveFrom,
        },
      });

      await writeAudit(tx, {
        action: "SHIFT_ASSIGNED",
        entityName: "Employee",
        entityId: input.employeeId,
        after: {
          shift: shift.code,
          from: input.effectiveFrom.toISOString().slice(0, 10),
        },
        ctx,
      });
      return assignment;
    });
  });
}

type ShiftRow = {
  id: string;
  startMinute: number;
  endMinute: number;
  crossesMidnight: boolean;
  workingDays: number[];
  breakMinutes: number;
  breakPaid: boolean;
  graceMinutes: number;
  overtimeAfterMinutes: number;
};

function toRule(shift: ShiftRow): ShiftRule {
  return {
    startMinute: shift.startMinute,
    endMinute: shift.endMinute,
    crossesMidnight: shift.crossesMidnight,
    workingDays: shift.workingDays,
    breakMinutes: shift.breakMinutes,
    breakPaid: shift.breakPaid,
    graceMinutes: shift.graceMinutes,
    overtimeAfterMinutes: shift.overtimeAfterMinutes,
  };
}

/* ------------------------------------------------------------------ import */

export type ImportPreview = {
  importId: string;
  totalRows: number;
  validRows: number;
  duplicateRows: number;
  invalidRows: number;
  unknownBadges: string[];
  rangeFrom: Date | null;
  rangeTo: Date | null;
  /** The first few refusals, so the screen can show what went wrong. */
  problems: { rowNumber: number; reason: string }[];
};

function hashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Reads a file, counts what is in it, and writes no punches.
 *
 * Nothing is imported until somebody has seen these numbers and said yes. The
 * file's hash is kept so the confirmation cannot quietly apply to a different
 * file than the one that was counted.
 */
export async function previewImport(
  input: { deviceId: string; filename: string; mapping: ColumnMapping; text: string },
  ctx: AuditContext,
): Promise<ImportPreview> {
  if (!input.deviceId.trim()) throw new AttendanceError("Name the device this file came from.");

  const table = parseDelimited(input.text);
  if (table.headers.length === 0) throw new AttendanceError("That file has no rows.");

  const employees = await db.employee.findMany({
    where: { biometricDeviceUserId: { not: null } },
    select: { biometricDeviceUserId: true },
  });
  const knownBadges = new Set(employees.map((e) => e.biometricDeviceUserId!));

  // Only this device's punches: two readers may number their badges
  // independently, and a badge is only ever unique within the device that
  // issued it.
  const existing = await db.biometricPunch.findMany({
    where: { deviceId: input.deviceId },
    select: { deviceUserId: true, punchedAt: true },
  });
  const existingKeys = new Set(existing.map((p) => punchKey(p.deviceUserId, p.punchedAt)));

  const classified = classifyImport({ table, mapping: input.mapping, knownBadges, existingKeys });

  const record = await db.attendanceImport.create({
    data: {
      deviceId: input.deviceId.trim(),
      filename: input.filename,
      mapping: input.mapping as unknown as Prisma.InputJsonValue,
      fileHash: hashOf(input.text),
      status: "PREVIEWED",
      totalRows: classified.totalRows,
      validRows: classified.validRows,
      duplicateRows: classified.duplicateRows,
      invalidRows: classified.invalidRows,
      unknownBadges: classified.unknownBadges.length,
      rangeFrom: classified.rangeFrom,
      rangeTo: classified.rangeTo,
      importedByUserId: ctx.userId ?? null,
    },
  });

  // Refusals are kept with the row that caused them, so "why is my day short"
  // has an answer that does not require the original file.
  const problems: { rowNumber: number; reason: string }[] = [];
  const rows = classified.verdicts
    .map((v, i) => ({ v, rowNumber: i + 2 }))
    .filter((r) => r.v.kind === "invalid");
  for (const { v, rowNumber } of rows) {
    if (v.kind !== "invalid") continue;
    problems.push({ rowNumber, reason: v.reason });
  }
  if (rows.length > 0) {
    await db.attendanceImportRow.createMany({
      data: rows.map(({ v, rowNumber }) => ({
        importId: record.id,
        rowNumber,
        raw: (v.kind === "invalid" ? v.raw : {}) as unknown as Prisma.InputJsonValue,
        reason: v.kind === "invalid" ? v.reason : "",
      })),
    });
  }

  await db.$transaction(async (tx) => {
    await writeAudit(tx, {
      action: "ATTENDANCE_IMPORT_PREVIEWED",
      entityName: "AttendanceImport",
      entityId: record.id,
      after: {
        device: record.deviceId,
        filename: record.filename,
        mapping: input.mapping,
        totalRows: classified.totalRows,
        validRows: classified.validRows,
      },
      ctx,
    });
  });

  return {
    importId: record.id,
    totalRows: classified.totalRows,
    validRows: classified.validRows,
    duplicateRows: classified.duplicateRows,
    invalidRows: classified.invalidRows,
    unknownBadges: classified.unknownBadges,
    rangeFrom: classified.rangeFrom,
    rangeTo: classified.rangeTo,
    problems: problems.slice(0, 20),
  };
}

/**
 * Writes the punches a preview counted.
 *
 * Idempotent twice over: the file must be the one that was previewed, and the
 * unique index on device, badge and timestamp means a replay writes nothing
 * whatever anybody clicks.
 */
export async function commitImport(
  input: { importId: string; text: string },
  ctx: AuditContext,
): Promise<{ imported: number; duplicates: number; unmatched: number }> {
  return command("attendance.commitImport", { importId: input.importId }, ctx, async () => {
    const record = await db.attendanceImport.findUnique({ where: { id: input.importId } });
    if (!record) throw new AttendanceError("That import was not found.");
    if (record.status === "COMMITTED") {
      throw new AttendanceError("That file has already been imported.");
    }
    if (record.status === "CANCELLED") {
      throw new AttendanceError("That import was cancelled; start again.");
    }
    if (record.fileHash !== hashOf(input.text)) {
      throw new AttendanceError(
        "This is not the file that was previewed. Preview it again before importing.",
      );
    }

    const table = parseDelimited(input.text);
    const employees = await db.employee.findMany({
      where: { biometricDeviceUserId: { not: null } },
      select: { id: true, biometricDeviceUserId: true },
    });
    const byBadge = new Map(employees.map((e) => [e.biometricDeviceUserId!, e.id]));

    const existing = await db.biometricPunch.findMany({
      where: { deviceId: record.deviceId },
      select: { deviceUserId: true, punchedAt: true },
    });
    const existingKeys = new Set(existing.map((p) => punchKey(p.deviceUserId, p.punchedAt)));

    const classified = classifyImport({
      table,
      mapping: record.mapping as unknown as ColumnMapping,
      knownBadges: new Set(byBadge.keys()),
      existingKeys,
    });

    let imported = 0;
    let duplicates = classified.duplicateRows;
    let unmatched = 0;

    for (const verdict of classified.verdicts) {
      if (verdict.kind !== "valid") continue;
      const employeeId = byBadge.get(verdict.badge) ?? null;
      if (!employeeId) unmatched += 1;

      try {
        await db.biometricPunch.create({
          data: {
            deviceId: record.deviceId,
            deviceUserId: verdict.badge,
            employeeId,
            punchedAt: verdict.punchedAt,
            rawPayload: verdict.raw as unknown as Prisma.InputJsonValue,
          },
        });
        imported += 1;
      } catch (e) {
        // A replayed file is ordinary operation, not a failure.
        if (e instanceof Error && e.message.includes("Unique constraint")) {
          duplicates += 1;
          continue;
        }
        throw e;
      }
    }

    await db.$transaction(async (tx) => {
      await tx.attendanceImport.update({
        where: { id: record.id },
        data: {
          status: "COMMITTED",
          committedAt: new Date(),
          importedRows: imported,
          duplicateRows: duplicates,
          unknownBadges: classified.unknownBadges.length,
        },
      });
      await writeAudit(tx, {
        action: "ATTENDANCE_IMPORT_COMMITTED",
        entityName: "AttendanceImport",
        entityId: record.id,
        after: { device: record.deviceId, imported, duplicates, unmatched },
        ctx,
      });
    });

    return { imported, duplicates, unmatched };
  });
}

/**
 * Says whose badge an unrecognised number is.
 *
 * Claims every punch already stored under it, so the days those punches belong
 * to can be derived — a badge linked in October must still explain September.
 */
export async function linkBadge(
  input: { deviceUserId: string; employeeId: string; reason?: string },
  ctx: AuditContext,
): Promise<{ claimed: number }> {
  return command("attendance.linkBadge", input, ctx, async () => {
    const badge = input.deviceUserId.trim();
    if (!badge) throw new AttendanceError("Which badge?");

    const employee = await db.employee.findUnique({
      where: { id: input.employeeId },
      select: { id: true, name: true, biometricDeviceUserId: true },
    });
    if (!employee) throw new AttendanceError("Employee not found.");

    const taken = await db.employee.findFirst({
      where: { biometricDeviceUserId: badge, id: { not: employee.id } },
      select: { name: true },
    });
    if (taken) {
      throw new AttendanceError(`Badge ${badge} already belongs to ${taken.name}.`);
    }

    return db.$transaction(async (tx) => {
      await tx.employee.update({
        where: { id: employee.id },
        data: { biometricDeviceUserId: badge },
      });

      const claimed = await tx.biometricPunch.updateMany({
        where: { deviceUserId: badge, employeeId: null },
        data: { employeeId: employee.id },
      });

      await writeAudit(tx, {
        action: "BIOMETRIC_BADGE_LINKED",
        entityName: "Employee",
        entityId: employee.id,
        before: { badge: employee.biometricDeviceUserId },
        after: { badge, punchesClaimed: claimed.count },
        ctx: { ...ctx, reason: input.reason ?? null },
      });

      return { claimed: claimed.count };
    });
  });
}

/* -------------------------------------------------------------- derivation */

/** The shift somebody was on for a given day, or none. */
async function shiftFor(employeeId: string, dateKey: string): Promise<ShiftRow | null> {
  const on = cairoDateOnly(dateKey);
  const assignment = await db.employeeShift.findFirst({
    where: {
      employeeId,
      effectiveFrom: { lte: on },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: on } }],
    },
    orderBy: { effectiveFrom: "desc" },
    include: { shift: true },
  });
  return assignment?.shift ?? null;
}

/**
 * A day that a person has already settled, which re-derivation must not undo.
 *
 * Three ways a day becomes somebody's rather than the device's: it was
 * corrected by hand, it was reviewed and accepted, or its period was locked.
 * Any of them means the derivation engine has nothing left to say about it.
 */
function isSettled(day: { source: string; reviewedAt: Date | null; lockedAt: Date | null }): boolean {
  return day.source === "MANUAL" || day.reviewedAt !== null || day.lockedAt !== null;
}

export async function deriveRange(
  input: { employeeIds?: string[]; fromKey: string; toKey: string },
  ctx: AuditContext,
): Promise<{ created: number; updated: number; skipped: number; needingReview: number }> {
  const employees = await db.employee.findMany({
    where: {
      status: { not: "TERMINATED" },
      ...(input.employeeIds?.length ? { id: { in: input.employeeIds } } : {}),
    },
    select: { id: true, entityId: true },
  });

  // Padded a day each way: a night shift's punches sit on the calendar day
  // after the one they belong to.
  const from = cairoDateOnly(shiftDateKey(input.fromKey, -1));
  const to = cairoDateOnly(shiftDateKey(input.toKey, 2));

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let needingReview = 0;

  for (const employee of employees) {
    const punches = await db.biometricPunch.findMany({
      where: { employeeId: employee.id, punchedAt: { gte: from, lt: to } },
      orderBy: { punchedAt: "asc" },
      select: { punchedAt: true },
    });

    // Every date in the range gets a verdict, whether or not anybody punched:
    // a day with no punch at all is exactly the day somebody needs to look at.
    for (let key = input.fromKey; key <= input.toKey; key = shiftDateKey(key, 1)) {
      const shift = await shiftFor(employee.id, key);
      const rule = shift ? toRule(shift) : null;

      const mine = punches
        .filter((p) => workDateFor(p.punchedAt, rule, CAIRO) === key)
        .map((p) => p.punchedAt);

      const existing = await db.attendanceDay.findUnique({
        where: { employeeId_workDate: { employeeId: employee.id, workDate: cairoDateOnly(key) } },
        select: {
          id: true,
          source: true,
          reviewedAt: true,
          lockedAt: true,
          isLeave: true,
          status: true,
        },
      });

      if (existing && isSettled(existing)) {
        skipped += 1;
        continue;
      }

      const derived = deriveAttendance({
        punches: mine,
        shift: rule,
        dateKey: key,
        onLeave: existing?.isLeave ?? false,
      });

      // Nothing at all to say about an off day nobody worked: writing a row
      // for every Friday of every employee buries the queue in silence.
      if (derived.status === "OFF" && mine.length === 0 && !existing) continue;

      if (UNRESOLVED_STATUSES.includes(derived.status)) needingReview += 1;

      const data = {
        shiftId: shift?.id ?? null,
        status: derived.status,
        firstIn: derived.firstIn,
        lastOut: derived.lastOut,
        scheduledMinutes: String(derived.scheduledMinutes),
        workedMinutes: String(derived.workedMinutes),
        breakMinutes: String(derived.breakMinutes),
        lateMinutes: String(derived.lateMinutes),
        earlyLeaveMinutes: String(derived.earlyLeaveMinutes),
        overtimeCandidateMinutes: String(derived.overtimeCandidateMinutes),
        source: "BIOMETRIC" as const,
        adjustmentReason: derived.reviewReason,
      };

      if (existing) {
        await db.attendanceDay.update({ where: { id: existing.id }, data });
        updated += 1;
      } else {
        await db.attendanceDay.create({
          data: { employeeId: employee.id, workDate: cairoDateOnly(key), ...data },
        });
        created += 1;
      }
    }

    await ensurePeriodFor(employee.entityId, input.fromKey);
    await ensurePeriodFor(employee.entityId, input.toKey);
  }

  await db.$transaction(async (tx) => {
    await writeAudit(tx, {
      action: "ATTENDANCE_DERIVED",
      entityName: "AttendanceDay",
      entityId: `${input.fromKey}..${input.toKey}`,
      after: { created, updated, skipped, needingReview, employees: employees.length },
      ctx,
    });
  });

  return { created, updated, skipped, needingReview };
}

/* ----------------------------------------------------------------- periods */

async function ensurePeriodFor(entityId: string, dateKey: string) {
  const [year, month] = dateKey.split("-").map(Number);
  const existing = await db.attendancePeriod.findUnique({
    where: { entityId_year_month: { entityId, year, month } },
  });
  if (existing) return existing;
  return db.attendancePeriod.create({ data: { entityId, year, month } });
}

/** Days nobody has settled, which is what stops a period being locked. */
export async function unresolvedCount(
  entityId: string,
  year: number,
  month: number,
): Promise<{ needsReview: number; incomplete: number; overtimePending: number }> {
  const from = cairoDateOnly(`${year}-${String(month).padStart(2, "0")}-01`);
  const to = new Date(Date.UTC(year, month, 1));

  const [needsReview, incomplete, overtimePending] = await Promise.all([
    db.attendanceDay.count({
      where: { employee: { entityId }, workDate: { gte: from, lt: to }, status: "NEEDS_REVIEW" },
    }),
    db.attendanceDay.count({
      where: { employee: { entityId }, workDate: { gte: from, lt: to }, status: "INCOMPLETE" },
    }),
    db.attendanceDay.count({
      where: {
        employee: { entityId },
        workDate: { gte: from, lt: to },
        overtimeCandidateMinutes: { gt: 0 },
        overtimeApprovedAt: null,
      },
    }),
  ]);

  return { needsReview, incomplete, overtimePending };
}

/**
 * Seals a month, so payroll has something that cannot move under it.
 *
 * Refused while anything is unresolved: locking a month with days nobody has
 * looked at makes the lock a formality, and the whole point of it is that
 * after this the figures are answerable.
 */
export async function lockAttendancePeriod(
  input: { entityId: string; year: number; month: number },
  ctx: AuditContext,
): Promise<{ daysLocked: number }> {
  return command("attendance.lockPeriod", input, ctx, async () => {
    const unresolved = await unresolvedCount(input.entityId, input.year, input.month);
    if (unresolved.needsReview > 0 || unresolved.incomplete > 0) {
      throw new AttendanceError(
        `${unresolved.needsReview + unresolved.incomplete} day(s) still need review. ` +
          `Resolve them before locking the month.`,
      );
    }

    const period = await ensurePeriodFor(
      input.entityId,
      `${input.year}-${String(input.month).padStart(2, "0")}-01`,
    );
    if (period.status === "LOCKED") throw new AttendanceError("That month is already locked.");

    const from = cairoDateOnly(`${input.year}-${String(input.month).padStart(2, "0")}-01`);
    const to = new Date(Date.UTC(input.year, input.month, 1));

    return db.$transaction(async (tx) => {
      const locked = await tx.attendanceDay.updateMany({
        where: { employee: { entityId: input.entityId }, workDate: { gte: from, lt: to }, lockedAt: null },
        data: { lockedAt: new Date() },
      });

      await tx.attendancePeriod.update({
        where: { id: period.id },
        data: { status: "LOCKED", lockedAt: new Date(), lockedByUserId: ctx.userId ?? null },
      });

      await writeAudit(tx, {
        action: "ATTENDANCE_PERIOD_LOCKED",
        entityName: "AttendancePeriod",
        entityId: period.id,
        after: { year: input.year, month: input.month, daysLocked: locked.count },
        ctx,
      });

      return { daysLocked: locked.count };
    });
  });
}

/* ------------------------------------------------------------- corrections */

type DaySnapshot = Record<string, unknown>;

function snapshot(day: {
  status: string;
  workedMinutes: unknown;
  overtimeMinutes: unknown;
  lateMinutes: unknown;
  isAbsent: boolean;
  isLeave: boolean;
  firstIn: Date | null;
  lastOut: Date | null;
}): DaySnapshot {
  return {
    status: day.status,
    workedMinutes: String(day.workedMinutes),
    overtimeMinutes: String(day.overtimeMinutes),
    lateMinutes: String(day.lateMinutes),
    isAbsent: day.isAbsent,
    isLeave: day.isLeave,
    firstIn: day.firstIn?.toISOString() ?? null,
    lastOut: day.lastOut?.toISOString() ?? null,
  };
}

export type CorrectionInput = {
  dayId: string;
  reason: string;
  workedMinutes?: string;
  status?: "PRESENT" | "LATE" | "EARLY_LEAVE" | "ABSENT" | "LEAVE" | "OFF" | "INCOMPLETE" | "NEEDS_REVIEW";
  isAbsent?: boolean;
  isLeave?: boolean;
  leaveType?: string | null;
  /** Deliberate change to a locked month, which takes the lock capability. */
  afterLock?: boolean;
};

/**
 * Corrects a day, leaving the punches exactly where they were.
 *
 * The day carries what is true now; the adjustment carries what it was, what
 * it became, who asked and why. Nothing is overwritten without that record,
 * and a locked month refuses an ordinary correction outright — after a lock,
 * changing a figure is a deliberate act with its own name.
 */
export async function correctDay(input: CorrectionInput, ctx: AuditContext) {
  return command("attendance.correctDay", input, ctx, async () => {
    const reason = input.reason.trim();
    if (!reason) throw new AttendanceError("A correction needs a reason.");

    const day = await db.attendanceDay.findUnique({ where: { id: input.dayId } });
    if (!day) throw new AttendanceError("That day was not found.");

    if (day.lockedAt && !input.afterLock) {
      throw new AttendanceError(
        "That month is locked for payroll. A change now has to be made as a post-lock adjustment.",
      );
    }

    const before = snapshot(day);
    const status = input.status ?? (input.isAbsent ? "ABSENT" : input.isLeave ? "LEAVE" : day.status);

    return db.$transaction(async (tx) => {
      const updated = await tx.attendanceDay.update({
        where: { id: day.id },
        data: {
          status,
          workedMinutes: input.workedMinutes ?? day.workedMinutes,
          isAbsent: input.isAbsent ?? day.isAbsent,
          isLeave: input.isLeave ?? day.isLeave,
          leaveType: input.leaveType ?? day.leaveType,
          // The day stops being the device's account of itself the moment a
          // person changes it, and re-derivation leaves it alone thereafter.
          source: "MANUAL",
          adjustmentReason: reason,
          approvedByUserId: ctx.userId ?? null,
          reviewedByUserId: ctx.userId ?? null,
          reviewedAt: new Date(),
        },
      });

      await tx.attendanceAdjustment.create({
        data: {
          dayId: day.id,
          kind: input.afterLock ? "POST_LOCK" : "CORRECTION",
          reason,
          before: before as Prisma.InputJsonValue,
          after: snapshot(updated) as Prisma.InputJsonValue,
          requestedByUserId: ctx.userId ?? null,
          approvedByUserId: ctx.userId ?? null,
        },
      });

      await writeAudit(tx, {
        action: input.afterLock ? "ATTENDANCE_ADJUSTED_AFTER_LOCK" : "ATTENDANCE_ADJUSTED",
        entityName: "AttendanceDay",
        entityId: day.id,
        before,
        after: snapshot(updated),
        ctx: { ...ctx, reason },
      });

      return updated;
    });
  });
}

/** Accepts a day as it stands. Re-derivation leaves it alone afterwards. */
export async function reviewDay(
  input: { dayId: string; reason?: string },
  ctx: AuditContext,
) {
  return command("attendance.reviewDay", input, ctx, async () => {
    const day = await db.attendanceDay.findUnique({ where: { id: input.dayId } });
    if (!day) throw new AttendanceError("That day was not found.");
    if (day.status === "INCOMPLETE" || day.status === "NEEDS_REVIEW") {
      throw new AttendanceError(
        "This day has nothing to accept yet — correct it, or mark it leave or absence.",
      );
    }

    return db.$transaction(async (tx) => {
      const updated = await tx.attendanceDay.update({
        where: { id: day.id },
        data: { reviewedAt: new Date(), reviewedByUserId: ctx.userId ?? null },
      });
      await tx.attendanceAdjustment.create({
        data: {
          dayId: day.id,
          kind: "REVIEW",
          reason: input.reason?.trim() || "Accepted as recorded.",
          after: snapshot(updated) as Prisma.InputJsonValue,
          requestedByUserId: ctx.userId ?? null,
          approvedByUserId: ctx.userId ?? null,
        },
      });
      await writeAudit(tx, {
        action: "ATTENDANCE_REVIEWED",
        entityName: "AttendanceDay",
        entityId: day.id,
        after: { status: updated.status },
        ctx,
      });
      return updated;
    });
  });
}

/**
 * Decides what to do about hours worked beyond the shift.
 *
 * Overtime is only ever paid once somebody with the authority says so: the
 * engine records what was worked, and this records what was agreed. Rejecting
 * leaves the candidate minutes visible, because the hours still happened.
 */
export async function decideOvertime(
  input: { dayId: string; approve: boolean; minutes?: string; reason: string },
  ctx: AuditContext,
) {
  return command("attendance.decideOvertime", input, ctx, async () => {
    const reason = input.reason.trim();
    if (!reason) throw new AttendanceError("Approving or refusing overtime needs a reason.");

    const day = await db.attendanceDay.findUnique({ where: { id: input.dayId } });
    if (!day) throw new AttendanceError("That day was not found.");
    if (day.lockedAt) throw new AttendanceError("That month is locked for payroll.");

    const minutes = input.approve
      ? (input.minutes ?? day.overtimeCandidateMinutes.toString())
      : "0";

    return db.$transaction(async (tx) => {
      const before = snapshot(day);
      const updated = await tx.attendanceDay.update({
        where: { id: day.id },
        data: {
          overtimeMinutes: minutes,
          overtimeApprovedAt: new Date(),
          overtimeApprovedByUserId: ctx.userId ?? null,
        },
      });

      await tx.attendanceAdjustment.create({
        data: {
          dayId: day.id,
          kind: input.approve ? "OVERTIME_APPROVAL" : "OVERTIME_REJECTION",
          reason,
          before: before as Prisma.InputJsonValue,
          after: snapshot(updated) as Prisma.InputJsonValue,
          requestedByUserId: ctx.userId ?? null,
          approvedByUserId: ctx.userId ?? null,
        },
      });

      await writeAudit(tx, {
        action: input.approve ? "OVERTIME_APPROVED" : "OVERTIME_REJECTED",
        entityName: "AttendanceDay",
        entityId: day.id,
        after: { minutes },
        ctx: { ...ctx, reason },
      });

      return updated;
    });
  });
}
