import "server-only";
import { z } from "zod";
import { db } from "./db";
import { dec, safeDiv, type Decimal } from "./money";
import { writeAudit, type AuditContext } from "./audit";

/**
 * What one operator produced against the time they were paid for.
 *
 * This deliberately does not come from the line's shift log. A shift records
 * a line, a stage and a headcount; splitting its minutes evenly across the
 * people on the line would hand every one of them the same efficiency, which
 * is precisely the thing per-operator productivity exists to tell apart.
 *
 * Half of it is measured rather than typed. Clocked minutes come from the
 * attendance day the biometric device already produced, so nobody gets to
 * decide retrospectively how long somebody was on the floor. What is entered
 * is what they made — the standard minutes their output is worth — because
 * only the supervisor counting the bundles knows that.
 *
 * Nothing here reaches the ledger. Their wages are payroll's business and are
 * already counted there; this measures what those wages bought.
 */

export class OperatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorError";
  }
}

const productivitySchema = z.object({
  operatorId: z.string().min(1),
  logDate: z.coerce.date(),
  smvProduced: z.coerce.number().min(0, "Standard minutes produced cannot be negative."),
  /**
   * Overrides attendance. Only for an operator with no HR record yet — and
   * the result says it was typed, because a clocked figure somebody chose is
   * a different kind of number from one a device recorded.
   */
  clockedMinutes: z.coerce.number().positive().nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

export type RecordProductivityInput = z.input<typeof productivitySchema>;

/**
 * Minutes on the floor that day, from the attendance the device recorded.
 *
 * Null when the operator has no HR record or was not there — the caller has to
 * decide what that means rather than being handed a zero that reads as though
 * somebody stood idle all day.
 */
export async function clockedFromAttendance(
  operatorId: string,
  logDate: Date,
): Promise<Decimal | null> {
  const operator = await db.operator.findUnique({
    where: { id: operatorId },
    select: { employeeId: true },
  });
  if (!operator?.employeeId) return null;

  const day = await db.attendanceDay.findUnique({
    where: { employeeId_workDate: { employeeId: operator.employeeId, workDate: logDate } },
    select: { workedMinutes: true, overtimeMinutes: true, isAbsent: true, isLeave: true },
  });
  if (!day || day.isAbsent || day.isLeave) return null;

  // Overtime counts: those minutes were paid for and the work done in them is
  // work done. Leaving them out would flatter the efficiency of anybody who
  // stayed late.
  const total = dec(day.workedMinutes).plus(dec(day.overtimeMinutes));
  return total.greaterThan(0) ? total : null;
}

export async function recordProductivity(
  input: RecordProductivityInput,
  ctx: AuditContext,
) {
  const data = productivitySchema.parse(input);

  const operator = await db.operator.findUnique({
    where: { id: data.operatorId },
    select: { id: true, code: true, name: true, isActive: true },
  });
  if (!operator) throw new OperatorError("Operator not found.");

  const measured = await clockedFromAttendance(data.operatorId, data.logDate);
  const clocked = measured ?? (data.clockedMinutes != null ? dec(data.clockedMinutes) : null);

  if (!clocked) {
    throw new OperatorError(
      `${operator.name} has no attendance recorded for that day, so there are no clocked ` +
        "minutes to measure against. Record the attendance first, or enter the minutes.",
    );
  }

  const smvProduced = dec(data.smvProduced);
  const efficiency = safeDiv(smvProduced, clocked) ?? dec(0);

  // One row per operator per day, so correcting a miscount replaces it rather
  // than adding a second day's work to the same day.
  const record = await db.operatorProductivity.upsert({
    where: { operatorId_logDate: { operatorId: data.operatorId, logDate: data.logDate } },
    update: {
      smvProduced: smvProduced.toString(),
      clockedMinutes: clocked.toString(),
      efficiencyRate: efficiency.toString(),
      notes: data.notes ?? null,
    },
    create: {
      operatorId: data.operatorId,
      logDate: data.logDate,
      smvProduced: smvProduced.toString(),
      clockedMinutes: clocked.toString(),
      efficiencyRate: efficiency.toString(),
      notes: data.notes ?? null,
    },
  });

  await writeAudit(db, {
    action: "OPERATOR_PRODUCTIVITY_RECORDED",
    entityName: "OperatorProductivity",
    entityId: record.id,
    ctx,
    after: {
      operator: operator.code,
      date: data.logDate.toISOString().slice(0, 10),
      smvProduced: smvProduced.toString(),
      clockedMinutes: clocked.toString(),
      clockedFrom: measured ? "attendance" : "entered",
      efficiency: efficiency.toString(),
    },
  });

  return {
    productivityId: record.id,
    clockedMinutes: clocked.toString(),
    clockedFromAttendance: measured !== null,
    smvProduced: smvProduced.toString(),
    efficiency: efficiency.toString(),
  };
}

/**
 * Operators ranked by what they produced against what they were paid for.
 *
 * Days on the floor are counted alongside the average, because an operator who
 * ran at 95% for two days is not the same claim as one who held it for twenty.
 */
export async function operatorProductivity(sinceDays = 90) {
  const since = new Date();
  since.setDate(since.getDate() - sinceDays);

  const rows = await db.operatorProductivity.findMany({
    where: { logDate: { gte: since } },
    include: {
      operator: {
        select: {
          id: true, code: true, name: true, isActive: true,
          line: { select: { nameAr: true, nameEn: true } },
        },
      },
    },
    orderBy: { logDate: "desc" },
  });

  const byOperator = new Map<
    string,
    {
      operatorId: string;
      code: string;
      name: string;
      isActive: boolean;
      lineAr: string | null;
      lineEn: string | null;
      smvProduced: Decimal;
      clockedMinutes: Decimal;
      days: number;
      best: Decimal | null;
      worst: Decimal | null;
    }
  >();

  for (const row of rows) {
    const at = byOperator.get(row.operator.id) ?? {
      operatorId: row.operator.id,
      code: row.operator.code,
      name: row.operator.name,
      isActive: row.operator.isActive,
      lineAr: row.operator.line?.nameAr ?? null,
      lineEn: row.operator.line?.nameEn ?? null,
      smvProduced: dec(0),
      clockedMinutes: dec(0),
      days: 0,
      best: null,
      worst: null,
    };

    const rate = dec(row.efficiencyRate);
    at.smvProduced = at.smvProduced.plus(dec(row.smvProduced));
    at.clockedMinutes = at.clockedMinutes.plus(dec(row.clockedMinutes));
    at.days += 1;
    at.best = at.best === null || rate.greaterThan(at.best) ? rate : at.best;
    at.worst = at.worst === null || rate.lessThan(at.worst) ? rate : at.worst;

    byOperator.set(row.operator.id, at);
  }

  const operators = [...byOperator.values()]
    .map((o) => ({
      ...o,
      // Weighted by minutes rather than averaging the daily rates: a long day
      // at 60% should not be cancelled by a short one at 100%.
      efficiency: safeDiv(o.smvProduced, o.clockedMinutes),
    }))
    .sort((a, b) => Number((b.efficiency ?? dec(0)).minus(a.efficiency ?? dec(0))));

  const smv = operators.reduce((t, o) => t.plus(o.smvProduced), dec(0));
  const clocked = operators.reduce((t, o) => t.plus(o.clockedMinutes), dec(0));

  return {
    operators,
    totals: {
      operators: operators.length,
      smvProduced: smv,
      clockedMinutes: clocked,
      efficiency: safeDiv(smv, clocked),
      days: operators.reduce((n, o) => n + o.days, 0),
    },
    recent: rows.slice(0, 30).map((r) => ({
      id: r.id,
      date: r.logDate,
      operatorCode: r.operator.code,
      operatorName: r.operator.name,
      smvProduced: r.smvProduced.toString(),
      clockedMinutes: r.clockedMinutes.toString(),
      efficiencyRate: r.efficiencyRate.toString(),
      notes: r.notes,
    })),
  };
}

/** Operators who can be logged against, and whether attendance knows them. */
export async function loggableOperators() {
  const operators = await db.operator.findMany({
    where: { isActive: true },
    include: { line: { select: { nameAr: true, nameEn: true } } },
    orderBy: { code: "asc" },
  });

  return operators.map((o) => ({
    id: o.id,
    code: o.code,
    name: o.name,
    lineAr: o.line?.nameAr ?? null,
    lineEn: o.line?.nameEn ?? null,
    /** Without an HR record the clocked minutes have to be typed. */
    hasEmployee: o.employeeId !== null,
  }));
}
