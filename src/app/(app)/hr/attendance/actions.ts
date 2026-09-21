"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import {
  AttendanceError,
  assignShift,
  commitImport,
  correctDay,
  createShift,
  decideOvertime,
  deriveRange,
  linkBadge,
  lockAttendancePeriod,
  previewImport,
  reviewDay,
} from "@/lib/attendance";
import type { ColumnMapping, DateOrder } from "@/core/attendance-import";
import type { FormState } from "@/components/entity-form";

/**
 * The attendance workspace, at the boundary.
 *
 * Every entry point names the capability it needs before it does anything.
 * They are deliberately separate: loading a file, changing what a day says,
 * agreeing to pay overtime and sealing a month are four different kinds of
 * authority, and a supervisor who may see the floor holds none of them.
 */

function toMessage(error: unknown): string {
  if (error instanceof AttendanceError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  if (error && typeof error === "object" && "issues" in error) {
    return (error as { issues: { message: string }[] }).issues.map((i) => i.message).join(" ");
  }
  console.error("Unhandled attendance error:", error);
  return "Something went wrong. Nothing was saved.";
}

/* ------------------------------------------------------------------ import */

export type PreviewState = FormState & {
  preview?: {
    importId: string;
    totalRows: number;
    validRows: number;
    duplicateRows: number;
    invalidRows: number;
    emptyRows: number;
    unknownBadges: string[];
    rangeFrom: string | null;
    rangeTo: string | null;
    problems: { rowNumber: number; reason: string }[];
  };
};

/**
 * Reads the mapping off the form.
 *
 * The clock columns arrive as `map_in_0`, `map_out_0`, `map_in_1` … because
 * how many pairs a device prints is the device's business, not this form's.
 * A pair with no arrival column chosen is not a pair and is dropped.
 */
function buildMapping(formData: FormData): ColumnMapping {
  const layout = formData.get("layout") === "PAIRS_PER_DAY" ? "PAIRS_PER_DAY" : "PUNCH_PER_ROW";
  const dateOrder = (formData.get("dateOrder") as DateOrder) || "DMY";
  const headerRow = Number(formData.get("headerRow") ?? 1) || 1;

  const base = {
    layout,
    badge: String(formData.get("map_badge") ?? ""),
    dateOrder,
    headerRow,
    device: (formData.get("map_device") as string) || null,
    payload: (formData.get("map_payload") as string) || null,
  } as const;

  if (layout === "PUNCH_PER_ROW") {
    return {
      ...base,
      timestamp: String(formData.get("map_timestamp") ?? ""),
      direction: (formData.get("map_direction") as string) || null,
    };
  }

  const pairs: { in: string; out: string | null }[] = [];
  for (let i = 0; i < 12; i += 1) {
    const inCol = (formData.get(`map_in_${i}`) as string) || "";
    const outCol = (formData.get(`map_out_${i}`) as string) || "";
    if (!inCol && !outCol) continue;
    if (!inCol) continue;
    pairs.push({ in: inCol, out: outCol || null });
  }

  return { ...base, date: String(formData.get("map_date") ?? ""), pairs };
}

/** Counts what is in a file and writes nothing. */
export async function previewImportAction(
  _prev: PreviewState,
  formData: FormData,
): Promise<PreviewState> {
  try {
    const session = await authorize("attendance:import");

    const text = String(formData.get("text") ?? "");
    if (!text.trim()) return { error: "Choose a file first." };

    const result = await previewImport(
      {
        deviceId: String(formData.get("deviceId") ?? ""),
        filename: String(formData.get("filename") ?? "export.csv"),
        mapping: buildMapping(formData),
        text,
      },
      { userId: session.userId },
    );

    return {
      preview: {
        ...result,
        rangeFrom: result.rangeFrom?.toISOString() ?? null,
        rangeTo: result.rangeTo?.toISOString() ?? null,
      },
      success:
        `${result.validRows} punch(es) from ${result.totalRows} row(s) can be imported. ` +
        `Nothing has been written yet.`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

/** Writes the punches a preview counted, and derives the days they touch. */
export async function commitImportAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("attendance:import");

    const importId = String(formData.get("importId") ?? "");
    const text = String(formData.get("text") ?? "");
    const result = await commitImport({ importId, text }, { userId: session.userId });

    // Derived straight away, over exactly the days the file covered: an import
    // that leaves nothing on the review screen looks like it did nothing.
    const from = String(formData.get("rangeFrom") ?? "").slice(0, 10);
    const to = String(formData.get("rangeTo") ?? "").slice(0, 10);
    let derived = { needingReview: 0 };
    if (from && to) {
      derived = await deriveRange({ fromKey: from, toKey: to }, { userId: session.userId });
    }

    revalidatePath("/hr/attendance");
    revalidatePath("/hr");

    const parts = [`${result.imported} punch(es) imported`];
    if (result.duplicates > 0) parts.push(`${result.duplicates} already had been`);
    if (result.unmatched > 0) parts.push(`${result.unmatched} from badges nobody is linked to`);
    if (derived.needingReview > 0) parts.push(`${derived.needingReview} day(s) need review`);
    return { success: parts.join(", ") + "." };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

/* -------------------------------------------------------------- exceptions */

export async function linkBadgeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await authorize("attendance:review");

    const { claimed } = await linkBadge(
      {
        deviceUserId: String(formData.get("deviceUserId") ?? ""),
        employeeId: String(formData.get("employeeId") ?? ""),
        reason: (formData.get("reason") as string) || undefined,
      },
      { userId: session.userId },
    );

    // The punches now belong to somebody, so the days they fall on can be
    // worked out. Without this the badge is linked and the queue still shows
    // nothing for the person it was linked to.
    const from = String(formData.get("from") ?? "").slice(0, 10);
    const to = String(formData.get("to") ?? "").slice(0, 10);
    if (from && to) await deriveRange({ fromKey: from, toKey: to }, { userId: session.userId });

    revalidatePath("/hr/attendance");
    revalidatePath("/hr");
    return { success: `Linked. ${claimed} punch(es) now belong to them.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function deriveAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await authorize("attendance:review");

    const result = await deriveRange(
      {
        fromKey: String(formData.get("from") ?? "").slice(0, 10),
        toKey: String(formData.get("to") ?? "").slice(0, 10),
      },
      { userId: session.userId },
    );

    revalidatePath("/hr/attendance");
    revalidatePath("/hr");
    return {
      success:
        `${result.created} day(s) built, ${result.updated} updated, ` +
        `${result.skipped} left alone because somebody had already settled them. ` +
        `${result.needingReview} need review.`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function correctDayAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    // Changing a locked month is a different right from changing an open one.
    const afterLock = formData.get("afterLock") != null;
    const session = afterLock
      ? await authorize("attendance:lock")
      : await authorize("attendance:correct");

    const status = (formData.get("status") as string) || undefined;
    await correctDay(
      {
        dayId: String(formData.get("dayId") ?? ""),
        reason: String(formData.get("reason") ?? ""),
        workedMinutes: (formData.get("workedMinutes") as string) || undefined,
        status: status as never,
        isAbsent: status === "ABSENT" ? true : status ? false : undefined,
        isLeave: status === "LEAVE" ? true : status ? false : undefined,
        leaveType: (formData.get("leaveType") as string) || undefined,
        afterLock,
      },
      { userId: session.userId },
    );

    revalidatePath("/hr/attendance");
    revalidatePath("/hr");
    return { success: afterLock ? "Recorded as an adjustment after the lock." : "Corrected." };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function reviewDayAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await authorize("attendance:review");
    await reviewDay(
      {
        dayId: String(formData.get("dayId") ?? ""),
        reason: (formData.get("reason") as string) || undefined,
      },
      { userId: session.userId },
    );
    revalidatePath("/hr/attendance");
    revalidatePath("/hr");
    return { success: "Accepted as recorded." };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function decideOvertimeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await authorize("overtime:approve");
    const approve = String(formData.get("decision") ?? "") === "approve";

    await decideOvertime(
      {
        dayId: String(formData.get("dayId") ?? ""),
        approve,
        minutes: (formData.get("minutes") as string) || undefined,
        reason: String(formData.get("reason") ?? ""),
      },
      { userId: session.userId },
    );

    revalidatePath("/hr/attendance");
    revalidatePath("/hr");
    return { success: approve ? "Overtime approved." : "Overtime refused; the hours stay on record." };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function lockPeriodAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await authorize("attendance:lock");
    const [year, month] = String(formData.get("month") ?? "").split("-").map(Number);
    if (!year || !month) return { error: "Choose a month." };

    const { daysLocked } = await lockAttendancePeriod(
      { entityId: String(formData.get("entityId") ?? ""), year, month },
      { userId: session.userId },
    );

    revalidatePath("/hr/attendance");
    revalidatePath("/hr");
    return { success: `${daysLocked} day(s) sealed. Payroll can be prepared against them.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

/* ------------------------------------------------------------------ shifts */

export async function createShiftAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await authorize("attendance:correct");

    const hhmm = (name: string) => {
      const [h, m] = String(formData.get(name) ?? "0:0").split(":").map(Number);
      return (h || 0) * 60 + (m || 0);
    };

    const shift = await createShift(
      {
        code: String(formData.get("code") ?? ""),
        nameEn: String(formData.get("nameEn") ?? ""),
        nameAr: String(formData.get("nameAr") ?? ""),
        startMinute: hhmm("start"),
        endMinute: hhmm("end"),
        crossesMidnight: formData.get("crossesMidnight") != null,
        workingDays: formData.getAll("workingDays").map(Number),
        breakMinutes: Number(formData.get("breakMinutes") ?? 0),
        breakPaid: formData.get("breakPaid") != null,
        graceMinutes: Number(formData.get("graceMinutes") ?? 0),
        overtimeAfterMinutes: Number(formData.get("overtimeAfterMinutes") ?? 480),
        department: (formData.get("department") as string) || null,
        lineId: (formData.get("lineId") as string) || null,
      },
      { userId: session.userId },
    );

    revalidatePath("/hr/attendance/shifts");
    return { success: `${shift.code} added.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function assignShiftAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await authorize("attendance:correct");

    await assignShift(
      {
        employeeId: String(formData.get("employeeId") ?? ""),
        shiftId: String(formData.get("shiftId") ?? ""),
        effectiveFrom: new Date(String(formData.get("effectiveFrom") ?? "")),
      },
      { userId: session.userId },
    );

    revalidatePath("/hr/attendance/shifts");
    revalidatePath("/hr/attendance");
    return { success: "Assigned." };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
