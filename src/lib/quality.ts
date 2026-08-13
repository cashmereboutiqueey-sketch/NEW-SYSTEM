import "server-only";
import { z } from "zod";
import { db } from "./db";
import { dec, safeDiv, roundMoney, type Decimal } from "./money";
import { postEntry, nextDocumentNumber } from "./ledger";
import { consumeFifo } from "@/core/fifo";
import { writeAudit, type AuditContext } from "./audit";
import type { Prisma } from "@/generated/prisma/client";

/**
 * What the inspection found, and what putting it right cost.
 *
 * Both tables have been in the schema from the first migration and neither
 * ever had a writer. There is an alert rule watching the rework rate that
 * could never fire, and account 5500 "Rework cost" has never been posted to.
 *
 * Rework is the most expensive thing a factory does not measure. The minutes
 * are paid twice and earn once: the garment was already costed at its standard
 * minutes, and every minute spent fixing it is a minute the line did not spend
 * making the next one. Leaving that inside the ordinary conversion cost hides
 * it in the minute rate, where it quietly raises the price of every garment
 * the factory makes instead of pointing at the run that caused it.
 *
 * So rework is booked to its own account at the rate in force when it happened,
 * frozen on the record. A rate revised next quarter must not restate what last
 * quarter's mistakes cost.
 */

export class QualityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QualityError";
  }
}

const ACC = {
  REWORK: "5500",
  /**
   * Direct sewing labour. Rework minutes are already sitting here — they were
   * paid through the payroll like every other minute — so booking rework
   * reclassifies them rather than creating cost that does not exist. Total
   * cost is unchanged; what changes is that the rework can now be named.
   *
   * Crediting work in progress instead, which is what this first did, credits
   * an inventory account against stock that was never there and puts the
   * ledger out of step with the lots. The books audit caught it by 728.97.
   */
  SEWING_LABOUR: "6110",
  RAW: "1310",
} as const;

export const REWORK_TYPES = [
  "RESEWING",
  "REPRESSING",
  "REPACKING",
  "RECUTTING",
  "WASHING",
] as const;
export type ReworkType = (typeof REWORK_TYPES)[number];

export const STAGES = ["CUTTING", "SEWING", "FINISHING", "QC", "PACKING"] as const;
export type Stage = (typeof STAGES)[number];

async function accountId(tx: Prisma.TransactionClient, code: string): Promise<string> {
  const a = await tx.account.findUnique({ where: { code }, select: { id: true } });
  if (!a) throw new QualityError(`Account ${code} is missing from the chart of accounts.`);
  return a.id;
}

/* ─────────────────────────────── inspection ─────────────────────────────── */

const inspectionSchema = z
  .object({
    productionOrderId: z.string().min(1),
    stage: z.enum(STAGES).default("QC"),
    inspectionDate: z.coerce.date(),
    inspectedQty: z.coerce.number().int().positive("Nothing was inspected."),
    passedQty: z.coerce.number().int().min(0),
    reworkQty: z.coerce.number().int().min(0).default(0),
    rejectedQty: z.coerce.number().int().min(0).default(0),
    defectNotes: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((v) => v.passedQty + v.reworkQty + v.rejectedQty === v.inspectedQty, {
    // Every garment inspected ends up in exactly one of the three buckets. If
    // they do not add up, the defect rate is measuring an arithmetic slip.
    message: "Passed, rework and rejected must add up to the number inspected.",
    path: ["passedQty"],
  });

export type RecordInspectionInput = z.input<typeof inspectionSchema>;

/**
 * Record an inspection.
 *
 * No journal: nothing has moved and nothing has been spent yet. What it found
 * decides what happens next — rework costs minutes, a rejection is a garment
 * written off — and each of those is recorded as it happens.
 */
export async function recordInspection(input: RecordInspectionInput, ctx: AuditContext) {
  const data = inspectionSchema.parse(input);

  const order = await db.productionOrder.findUnique({
    where: { id: data.productionOrderId },
    select: { id: true, orderNumber: true, plannedQty: true, actualQty: true },
  });
  if (!order) throw new QualityError("Production order not found.");

  const defective = data.reworkQty + data.rejectedQty;
  const defectRate = safeDiv(dec(defective), dec(data.inspectedQty)) ?? dec(0);

  const record = await db.qCRecord.create({
    data: {
      productionOrderId: data.productionOrderId,
      stage: data.stage,
      inspectedQty: data.inspectedQty,
      passedQty: data.passedQty,
      reworkQty: data.reworkQty,
      rejectedQty: data.rejectedQty,
      defectRate: defectRate.toString(),
      defectNotes: data.defectNotes ?? null,
      inspectionDate: data.inspectionDate,
    },
  });

  await writeAudit(db, {
    action: "QC_RECORDED",
    entityName: "QCRecord",
    entityId: record.id,
    ctx,
    after: {
      order: order.orderNumber,
      stage: data.stage,
      inspected: data.inspectedQty,
      passed: data.passedQty,
      rework: data.reworkQty,
      rejected: data.rejectedQty,
      defectRate: defectRate.toString(),
    },
  });

  return {
    qcRecordId: record.id,
    defectRate: defectRate.toString(),
    defective,
  };
}

/* ──────────────────────────────── rework ────────────────────────────────── */

const reworkSchema = z.object({
  productionOrderId: z.string().min(1),
  entityId: z.string().min(1),
  lineId: z.string().min(1).nullable().optional(),
  type: z.enum(REWORK_TYPES),
  quantity: z.coerce.number().int().positive("Nothing was reworked."),
  minutesPerUnit: z.coerce.number().positive("Rework takes minutes; say how many."),
  /**
   * Material consumed putting it right — new buttons, new thread, new cloth.
   *
   * Named rather than valued: the cost is whatever FIFO says those specific
   * units cost, exactly as it is for scrap. A typed figure would credit the
   * inventory account for stock that never moved.
   */
  material: z
    .object({
      materialId: z.string().min(1),
      locationId: z.string().min(1),
      quantity: z.coerce.number().positive(),
    })
    .nullable()
    .optional(),
  reworkDate: z.coerce.date(),
  reason: z.string().trim().max(500).nullable().optional(),
});

export type RecordReworkInput = z.input<typeof reworkSchema>;

/**
 * The minute rate in force on the day the rework happened.
 *
 * Frozen onto the record, never looked up again. A rate revised next quarter
 * must not quietly restate what last quarter's mistakes cost.
 */
async function rateOn(entityId: string, when: Date): Promise<Decimal> {
  const period = await db.minuteRatePeriod.findFirst({
    where: {
      entityId,
      fiscalPeriod: { startDate: { lte: when }, endDate: { gte: when } },
    },
    // The most recently calculated rate for that period, so a recalculation
    // supersedes an earlier provisional one.
    orderBy: { calculatedAt: "desc" },
  });

  if (!period) {
    // Falling back to the newest rate would price old rework at a number that
    // did not exist when it happened.
    throw new QualityError(
      "No minute rate has been calculated for that period, so rework cannot be costed. " +
        "Calculate the minute rate first.",
    );
  }
  return dec(period.actualMinuteRate);
}

/**
 * Record rework, and charge it where somebody will see it.
 *
 * The labour is real and already paid for through the payroll, so this moves
 * cost out of work in progress and into 5500 rather than creating new expense
 * — the wages were counted once, when they were paid. What changes is which
 * account carries them: a garment that had to be fixed did not earn those
 * minutes back.
 */
export async function recordRework(input: RecordReworkInput, ctx: AuditContext) {
  const data = reworkSchema.parse(input);

  const order = await db.productionOrder.findUnique({
    where: { id: data.productionOrderId },
    select: { id: true, orderNumber: true },
  });
  if (!order) throw new QualityError("Production order not found.");

  const minuteRate = await rateOn(data.entityId, data.reworkDate);
  const totalMinutes = dec(data.minutesPerUnit).times(data.quantity);
  const labourCost = roundMoney(totalMinutes.times(minuteRate));

  return db.$transaction(async (tx) => {
    const reference = await nextDocumentNumber(tx, "RWK", data.reworkDate);

    // Material actually leaves the shelf, so it is consumed FIFO and valued at
    // what those specific units cost. Nothing here is a typed figure.
    let materialCost = dec(0);
    let consumed: { lotId: string; quantity: Decimal; unitCost: Decimal; cost: Decimal }[] = [];

    if (data.material) {
      const lots = await tx.inventoryLot.findMany({
        where: {
          materialId: data.material.materialId,
          locationId: data.material.locationId,
          state: "RAW_MATERIAL",
          remainingQty: { gt: 0 },
        },
        orderBy: [{ receivedDate: "asc" }, { sequence: "asc" }],
        select: { id: true, receivedDate: true, sequence: true, remainingQty: true, unitCost: true },
      });

      const result = consumeFifo(
        lots.map((l) => ({
          id: l.id,
          receivedDate: l.receivedDate,
          sequence: l.sequence,
          remainingQty: l.remainingQty.toString(),
          unitCost: l.unitCost.toString(),
        })),
        data.material.quantity,
      );
      if (!result.ok) {
        throw new QualityError(
          `Not enough of that material to rework with: ${result.requested.toString()} needed, ` +
            `${result.available.toString()} on hand.`,
        );
      }

      materialCost = roundMoney(result.totalCost);
      consumed = result.allocations;
    }

    const totalCost = roundMoney(labourCost.plus(materialCost));

    // The minutes were already paid through the payroll and are already
    // sitting in direct sewing labour, so this names them rather than adding
    // cost that does not exist. Material genuinely leaves stock.
    const lines: Parameters<typeof postEntry>[1]["lines"] = [
      {
        accountId: await accountId(tx, ACC.REWORK),
        debit: totalCost,
        entityId: data.entityId,
        description: `Rework ${reference} — ${order.orderNumber}`,
      },
    ];
    if (labourCost.greaterThan(0)) {
      lines.push({
        accountId: await accountId(tx, ACC.SEWING_LABOUR),
        credit: labourCost,
        entityId: data.entityId,
        description: `Minutes reclassified as rework — ${order.orderNumber}`,
      });
    }
    if (materialCost.greaterThan(0)) {
      lines.push({
        accountId: await accountId(tx, ACC.RAW),
        credit: materialCost,
        entityId: data.entityId,
        description: `Material consumed reworking ${order.orderNumber}`,
      });
    }

    const journal = await postEntry(tx, {
      entityId: data.entityId,
      postingDate: data.reworkDate,
      sourceType: "MANUAL",
      sourceId: data.productionOrderId,
      memo: `Rework ${reference} — ${order.orderNumber}`,
      ctx,
      lines,
    });

    for (const a of consumed) {
      await tx.inventoryLot.update({
        where: { id: a.lotId },
        data: { remainingQty: { decrement: a.quantity.toString() } },
      });
      await tx.inventoryMovement.create({
        data: {
          lotId: a.lotId,
          type: "ISSUE_TO_PRODUCTION",
          quantity: a.quantity.toString(),
          unitCost: a.unitCost.toString(),
          totalCost: a.cost.toString(),
          movementDate: data.reworkDate,
          fromLocationId: data.material!.locationId,
          referenceType: "REWORK",
          referenceId: reference,
          journalEntryId: journal.id,
        },
      });
    }

    const record = await tx.reworkRecord.create({
      data: {
        productionOrderId: data.productionOrderId,
        lineId: data.lineId ?? null,
        type: data.type,
        quantity: data.quantity,
        minutesPerUnit: dec(data.minutesPerUnit).toString(),
        totalMinutes: totalMinutes.toString(),
        minuteRate: minuteRate.toString(),
        labourCost: labourCost.toString(),
        materialCost: materialCost.toString(),
        totalCost: totalCost.toString(),
        reworkDate: data.reworkDate,
        reason: data.reason ?? null,
      },
    });

    await writeAudit(tx, {
      action: "REWORK_RECORDED",
      entityName: "ReworkRecord",
      entityId: record.id,
      ctx,
      after: {
        order: order.orderNumber,
        type: data.type,
        quantity: data.quantity,
        totalMinutes: totalMinutes.toString(),
        minuteRate: minuteRate.toString(),
        totalCost: totalCost.toString(),
        journal: journal.entryNumber,
      },
    });

    return {
      reworkRecordId: record.id,
      totalMinutes: totalMinutes.toString(),
      minuteRate: minuteRate.toString(),
      labourCost: labourCost.toString(),
      materialCost: materialCost.toString(),
      totalCost: totalCost.toString(),
      journalEntryNumber: journal.entryNumber,
    };
  });
}

/* ──────────────────────────────── reporting ─────────────────────────────── */

/**
 * Quality by run: what was inspected, what came back, and what it cost.
 *
 * Defect rate and rework cost are reported together on purpose. A 3% defect
 * rate on a style that takes forty minutes to fix is worse than 8% on one that
 * takes four, and a rate on its own cannot say so.
 */
export async function qualityReport(sinceDays = 180) {
  const since = new Date();
  since.setDate(since.getDate() - sinceDays);

  const [inspections, reworks] = await Promise.all([
    db.qCRecord.findMany({
      where: { inspectionDate: { gte: since } },
      include: {
        productionOrder: {
          select: {
            id: true, orderNumber: true, actualQty: true,
            style: { select: { code: true, nameAr: true, nameEn: true } },
          },
        },
      },
      orderBy: { inspectionDate: "desc" },
    }),
    db.reworkRecord.findMany({
      where: { reworkDate: { gte: since } },
      include: {
        line: { select: { nameAr: true, nameEn: true } },
        productionOrder: {
          select: {
            id: true, orderNumber: true,
            style: { select: { code: true, nameAr: true, nameEn: true } },
          },
        },
      },
      orderBy: { reworkDate: "desc" },
    }),
  ]);

  const byRun = new Map<
    string,
    {
      orderId: string;
      orderNumber: string;
      styleCode: string;
      styleAr: string;
      styleEn: string;
      inspected: number;
      passed: number;
      reworkFound: number;
      rejected: number;
      reworkDone: number;
      minutes: Decimal;
      cost: Decimal;
    }
  >();

  const blank = (o: { id: string; orderNumber: string; style: { code: string; nameAr: string; nameEn: string } }) => ({
    orderId: o.id,
    orderNumber: o.orderNumber,
    styleCode: o.style.code,
    styleAr: o.style.nameAr,
    styleEn: o.style.nameEn,
    inspected: 0, passed: 0, reworkFound: 0, rejected: 0, reworkDone: 0,
    minutes: dec(0), cost: dec(0),
  });

  for (const i of inspections) {
    const at = byRun.get(i.productionOrder.id) ?? blank(i.productionOrder);
    at.inspected += i.inspectedQty;
    at.passed += i.passedQty;
    at.reworkFound += i.reworkQty;
    at.rejected += i.rejectedQty;
    byRun.set(i.productionOrder.id, at);
  }

  for (const r of reworks) {
    const at = byRun.get(r.productionOrder.id) ?? blank(r.productionOrder);
    at.reworkDone += r.quantity;
    at.minutes = at.minutes.plus(dec(r.totalMinutes));
    at.cost = at.cost.plus(dec(r.totalCost));
    byRun.set(r.productionOrder.id, at);
  }

  const runs = [...byRun.values()]
    .map((r) => ({
      ...r,
      defectRate: safeDiv(dec(r.reworkFound + r.rejected), dec(r.inspected)),
      // Cost per garment that had to be fixed — the figure that says whether a
      // low defect rate is actually cheap.
      costPerReworked: r.reworkDone > 0 ? r.cost.div(r.reworkDone) : null,
      /**
       * Found at inspection but not yet put right. Not necessarily wrong —
       * the fix may be tomorrow — but a gap that never closes means garments
       * were quietly passed.
       */
      outstanding: r.reworkFound - r.reworkDone,
    }))
    .sort((a, b) => Number(b.cost.minus(a.cost)));

  const inspected = runs.reduce((n, r) => n + r.inspected, 0);
  const defective = runs.reduce((n, r) => n + r.reworkFound + r.rejected, 0);

  const byType = new Map<string, { type: string; quantity: number; minutes: Decimal; cost: Decimal }>();
  for (const r of reworks) {
    const at = byType.get(r.type) ?? { type: r.type, quantity: 0, minutes: dec(0), cost: dec(0) };
    at.quantity += r.quantity;
    at.minutes = at.minutes.plus(dec(r.totalMinutes));
    at.cost = at.cost.plus(dec(r.totalCost));
    byType.set(r.type, at);
  }

  return {
    runs,
    byType: [...byType.values()].sort((a, b) => Number(b.cost.minus(a.cost))),
    totals: {
      inspected,
      defective,
      defectRate: safeDiv(dec(defective), dec(inspected)),
      reworked: reworks.reduce((n, r) => n + r.quantity, 0),
      minutes: reworks.reduce((t, r) => t.plus(dec(r.totalMinutes)), dec(0)),
      labourCost: reworks.reduce((t, r) => t.plus(dec(r.labourCost)), dec(0)),
      materialCost: reworks.reduce((t, r) => t.plus(dec(r.materialCost)), dec(0)),
      cost: reworks.reduce((t, r) => t.plus(dec(r.totalCost)), dec(0)),
    },
    recentInspections: inspections.slice(0, 25).map((i) => ({
      id: i.id,
      date: i.inspectionDate,
      orderNumber: i.productionOrder.orderNumber,
      styleAr: i.productionOrder.style.nameAr,
      styleEn: i.productionOrder.style.nameEn,
      stage: i.stage,
      inspectedQty: i.inspectedQty,
      passedQty: i.passedQty,
      reworkQty: i.reworkQty,
      rejectedQty: i.rejectedQty,
      defectRate: i.defectRate.toString(),
      defectNotes: i.defectNotes,
    })),
    recentReworks: reworks.slice(0, 25).map((r) => ({
      id: r.id,
      date: r.reworkDate,
      orderNumber: r.productionOrder.orderNumber,
      styleAr: r.productionOrder.style.nameAr,
      styleEn: r.productionOrder.style.nameEn,
      type: r.type,
      lineAr: r.line?.nameAr ?? null,
      lineEn: r.line?.nameEn ?? null,
      quantity: r.quantity,
      totalMinutes: r.totalMinutes.toString(),
      minuteRate: r.minuteRate.toString(),
      totalCost: r.totalCost.toString(),
      reason: r.reason,
    })),
  };
}

/** Runs that can be inspected or reworked. */
export async function inspectableRuns() {
  const orders = await db.productionOrder.findMany({
    where: { status: { in: ["CONFIRMED", "IN_PRODUCTION", "COMPLETED"] } },
    include: { style: { select: { code: true, nameAr: true, nameEn: true } } },
    orderBy: { orderDate: "desc" },
    take: 50,
  });

  return orders.map((o) => ({
    id: o.id,
    orderNumber: o.orderNumber,
    styleCode: o.style.code,
    styleAr: o.style.nameAr,
    styleEn: o.style.nameEn,
    plannedQty: o.plannedQty,
    actualQty: o.actualQty,
  }));
}
