import "server-only";
import { z } from "zod";
import { db } from "./db";
import { dec, type Decimal } from "./money";
import { lineEfficiency } from "@/core/production";
import { writeAudit, type AuditContext } from "./audit";

/**
 * What a line did with the hours it was paid for.
 *
 * Efficiency is earned minutes over clocked minutes. Clocked is what the
 * payroll actually pays for; earned is what came off the line, valued at the
 * standard minutes the work is supposed to take. Where the two diverge is
 * where the run is being lost, and naming the stage is the difference between
 * "the order was late" and "the sewing line ran at 62%".
 *
 * The earned figure is never typed in. It is qtyOut times the standard minutes
 * for that stage, taken from the style's own operations — which is the whole
 * reason SMV is built bottom-up from operations rather than asserted as one
 * number. A hand-entered efficiency is a number that measures the person
 * entering it.
 *
 * Nothing here posts to the ledger. Labour is already in the minute rate and
 * flows into every garment through the cost snapshot; booking it again here
 * would count the same wages twice.
 */

export class StageLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StageLogError";
  }
}

export const STAGES = ["CUTTING", "SEWING", "FINISHING", "QC", "PACKING"] as const;
export type Stage = (typeof STAGES)[number];

const logSchema = z
  .object({
    productionOrderId: z.string().min(1),
    lineId: z.string().min(1).nullable().optional(),
    stage: z.enum(STAGES),
    logDate: z.coerce.date(),
    qtyIn: z.coerce.number().int().min(0),
    qtyOut: z.coerce.number().int().min(0),
    operatorsCount: z.coerce.number().int().positive().nullable().optional(),
    clockedMinutes: z.coerce.number().positive("Clocked minutes must be greater than zero."),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .refine((v) => v.qtyOut <= v.qtyIn, {
    message: "More pieces came out of the stage than went into it.",
    path: ["qtyOut"],
  });

export type LogStageInput = z.input<typeof logSchema>;

/**
 * The standard minutes one garment takes at a stage.
 *
 * Zero when no operation has been assigned to that stage yet, which is a
 * refusal rather than a default: a log with no standard to measure against
 * would report an efficiency of zero and blame the line for a gap in the
 * routing.
 */
export async function standardMinutesFor(styleId: string, stage: Stage): Promise<Decimal> {
  const operations = await db.styleOperation.findMany({
    where: { styleId, stage },
    select: { smvMinutes: true },
  });
  return operations.reduce((t, o) => t.plus(dec(o.smvMinutes)), dec(0));
}

export async function logStage(input: LogStageInput, ctx: AuditContext) {
  const data = logSchema.parse(input);

  const order = await db.productionOrder.findUnique({
    where: { id: data.productionOrderId },
    include: { style: { select: { id: true, code: true, nameAr: true, nameEn: true } } },
  });
  if (!order) throw new StageLogError("Production order not found.");

  const standard = await standardMinutesFor(order.style.id, data.stage);
  if (standard.lessThanOrEqualTo(0)) {
    throw new StageLogError(
      `${order.style.code} has no operations assigned to ${data.stage.toLowerCase()}, so there are ` +
        "no standard minutes to measure the line against. Assign the stage on the style's " +
        "operations first.",
    );
  }

  const earnedMinutes = standard.times(data.qtyOut);
  const clockedMinutes = dec(data.clockedMinutes);
  // Null only when nothing was clocked, which the schema refuses anyway.
  const efficiency = lineEfficiency(earnedMinutes, clockedMinutes) ?? dec(0);

  const log = await db.productionStageLog.create({
    data: {
      productionOrderId: data.productionOrderId,
      lineId: data.lineId ?? null,
      stage: data.stage,
      logDate: data.logDate,
      qtyIn: data.qtyIn,
      qtyOut: data.qtyOut,
      operatorsCount: data.operatorsCount ?? null,
      clockedMinutes: clockedMinutes.toString(),
      earnedMinutes: earnedMinutes.toString(),
      efficiencyRate: efficiency.toString(),
      notes: data.notes ?? null,
    },
  });

  await writeAudit(db, {
    action: "STAGE_LOGGED",
    entityName: "ProductionStageLog",
    entityId: log.id,
    ctx,
    after: {
      order: order.orderNumber,
      stage: data.stage,
      qtyIn: data.qtyIn,
      qtyOut: data.qtyOut,
      clockedMinutes: clockedMinutes.toString(),
      earnedMinutes: earnedMinutes.toString(),
      efficiency: efficiency.toString(),
    },
  });

  return {
    stageLogId: log.id,
    earnedMinutes: earnedMinutes.toString(),
    clockedMinutes: clockedMinutes.toString(),
    efficiency: efficiency.toString(),
    standardMinutesPerUnit: standard.toString(),
  };
}

/** Runs that can be logged against, with the stages their routing supports. */
export async function loggableRuns() {
  const orders = await db.productionOrder.findMany({
    where: { status: { in: ["CONFIRMED", "IN_PRODUCTION", "COMPLETED"] } },
    include: {
      style: {
        select: {
          id: true, code: true, nameAr: true, nameEn: true,
          operations: { select: { stage: true, smvMinutes: true } },
        },
      },
    },
    orderBy: { orderDate: "desc" },
    take: 50,
  });

  return orders.map((o) => {
    const minutesByStage = new Map<string, Decimal>();
    for (const op of o.style.operations) {
      if (!op.stage) continue;
      minutesByStage.set(
        op.stage,
        (minutesByStage.get(op.stage) ?? dec(0)).plus(dec(op.smvMinutes)),
      );
    }

    return {
      id: o.id,
      orderNumber: o.orderNumber,
      styleCode: o.style.code,
      styleAr: o.style.nameAr,
      styleEn: o.style.nameEn,
      plannedQty: o.plannedQty,
      /** Only the stages the routing actually covers can be measured. */
      stages: [...minutesByStage.entries()].map(([stage, minutes]) => ({
        stage,
        standardMinutes: minutes.toString(),
      })),
      // Told plainly rather than left as an empty dropdown: the fix is on the
      // style, not on this screen.
      unroutedOperations: o.style.operations.filter((op) => !op.stage).length,
    };
  });
}

/** The lines work can be booked to. */
export async function activeLines() {
  const lines = await db.productionLine.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
    select: { id: true, code: true, nameAr: true, nameEn: true },
  });
  return lines;
}

/** Recent entries, so a mistake is visible rather than buried in a total. */
export async function recentStageLogs(limit = 25) {
  const logs = await db.productionStageLog.findMany({
    include: {
      line: { select: { nameAr: true, nameEn: true } },
      productionOrder: {
        select: { orderNumber: true, style: { select: { nameAr: true, nameEn: true } } },
      },
    },
    orderBy: [{ logDate: "desc" }, { createdAt: "desc" }],
    take: limit,
  });

  return logs.map((l) => ({
    id: l.id,
    date: l.logDate,
    orderNumber: l.productionOrder.orderNumber,
    styleAr: l.productionOrder.style.nameAr,
    styleEn: l.productionOrder.style.nameEn,
    stage: l.stage,
    lineAr: l.line?.nameAr ?? null,
    lineEn: l.line?.nameEn ?? null,
    qtyIn: l.qtyIn,
    qtyOut: l.qtyOut,
    operatorsCount: l.operatorsCount,
    clockedMinutes: l.clockedMinutes.toString(),
    earnedMinutes: l.earnedMinutes.toString(),
    efficiencyRate: l.efficiencyRate.toString(),
    notes: l.notes,
  }));
}
