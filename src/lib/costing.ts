import "server-only";
import { db } from "./db";
import { writeAudit, type AuditContext } from "./audit";
import {
  calculateStyleCost,
  idleCapacityPenalty,
  isBelowArmsLength,
  type BomLineInput,
} from "@/core/style-costing";
import { dec } from "./money";

/**
 * Style costing against a frozen minute rate, stored as an immutable snapshot.
 *
 * A snapshot records the entire basis of a costing — every material price, the
 * minute rate and which period it came from, the SMV, the waste rate and the
 * margin. Changing a fabric price tomorrow creates a *new* snapshot; it never
 * touches yesterday's. This is the most common way a system like this starts
 * quietly lying about historical margins.
 */

export class CostingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CostingError";
  }
}

async function settingValue(key: string, fallback: string): Promise<string> {
  const row = await db.setting.findUnique({ where: { key } });
  return row?.value ?? fallback;
}

/**
 * Computes a style's cost without storing anything.
 *
 * Used by the costing screen so the owner can see the numbers, and by the
 * scenario simulator, which must never write to operational tables.
 */
export async function previewStyleCost(input: {
  styleId: string;
  minuteRatePeriodId: string;
  factoryMarginPct?: string;
}) {
  const style = await db.style.findUnique({
    where: { id: input.styleId },
    include: {
      bomLines: { include: { material: true }, orderBy: { sortOrder: "asc" } },
      operations: true,
    },
  });
  if (!style) throw new CostingError("Style not found.");

  const ratePeriod = await db.minuteRatePeriod.findUnique({
    where: { id: input.minuteRatePeriodId },
    include: { fiscalPeriod: true },
  });
  if (!ratePeriod) throw new CostingError("Minute rate period not found.");
  if (dec(ratePeriod.actualMinuteRate).isZero()) {
    throw new CostingError(
      "That period has no usable minute rate. Calculate it from posted conversion costs first.",
    );
  }

  if (style.bomLines.length === 0) {
    throw new CostingError(
      `Style ${style.code} has no bill of materials, so it cannot be costed.`,
    );
  }

  const defaultMargin = await settingValue("factory.margin.default", "0.18");
  const minimumMargin = await settingValue("factory.margin.armsLengthMinimum", "0.12");
  const factoryMarginPct = input.factoryMarginPct ?? defaultMargin;

  const bomLines: BomLineInput[] = style.bomLines.map((l) => ({
    materialId: l.material.id,
    materialCode: l.material.code,
    materialNameEn: l.material.nameEn,
    materialNameAr: l.material.nameAr,
    materialType: l.material.type,
    standardConsumption: l.standardConsumption.toString(),
    // Landed cost, not the invoice price: purchase plus freight and duty.
    unitCost: dec(l.material.basePrice)
      .times(dec(l.material.freightPct).plus(dec(l.material.dutyPct)).plus(1))
      .toString(),
    wasteRateOverride: l.wasteRateOverride?.toString() ?? null,
  }));

  // Always recomputed from the operation breakdown rather than trusting the
  // cached total, so the SMV shown is the one the operations actually justify.
  const smvMinutes = style.operations
    .reduce((s, o) => s.plus(dec(o.smvMinutes)), dec(0))
    .toString();

  const result = calculateStyleCost({
    bomLines,
    plannedWasteRate: style.plannedWasteRate.toString(),
    smvMinutes,
    minuteRate: ratePeriod.actualMinuteRate.toString(),
    factoryMarginPct,
  });

  return {
    style,
    ratePeriod,
    smvMinutes,
    factoryMarginPct,
    minimumMargin,
    marginBelowArmsLength: isBelowArmsLength(factoryMarginPct, minimumMargin),
    idlePenalty: idleCapacityPenalty(
      ratePeriod.actualMinuteRate.toString(),
      ratePeriod.fullCapacityMinuteRate.toString(),
      smvMinutes,
    ),
    ...result,
  };
}

/**
 * Freezes a costing into an immutable `CostSnapshot`.
 *
 * A below-floor margin is allowed only with an explicit approval note, and the
 * snapshot records that it was below floor. Blocking it outright would push
 * the decision outside the system; recording it keeps it visible.
 */
export async function createCostSnapshot(
  input: {
    styleId: string;
    minuteRatePeriodId: string;
    factoryMarginPct?: string;
    reason?: string;
    approvalNote?: string;
  },
  ctx: AuditContext,
): Promise<{ costSnapshotId: string; transferPrice: string; belowFloor: boolean }> {
  const preview = await previewStyleCost(input);

  if (preview.marginBelowArmsLength && !input.approvalNote?.trim()) {
    throw new CostingError(
      `Margin ${(Number(preview.factoryMarginPct) * 100).toFixed(1)}% is below the arm's-length minimum of ${(Number(preview.minimumMargin) * 100).toFixed(1)}%. Record an approval note to proceed.`,
    );
  }

  return db.$transaction(async (tx) => {
    const snapshot = await tx.costSnapshot.create({
      data: {
        styleId: preview.style.id,
        minuteRatePeriodId: preview.ratePeriod.id,
        minuteRate: preview.ratePeriod.actualMinuteRate,
        fullCapacityRate: preview.ratePeriod.fullCapacityMinuteRate,
        smvMinutes: preview.smvMinutes,
        wasteRate: preview.style.plannedWasteRate,
        factoryMarginPct: preview.factoryMarginPct,
        fabricCost: preview.fabricCost.toString(),
        trimCost: preview.trimCost.toString(),
        materialCost: preview.materialCost.toString(),
        cmtCost: preview.cmtCost.toString(),
        factoryTotalCost: preview.factoryTotalCost.toString(),
        transferPrice: preview.transferPrice.toString(),
        idleCapacityPenalty: preview.idlePenalty.toString(),
        marginBelowArmsLength: preview.marginBelowArmsLength,
        approvedByUserId: preview.marginBelowArmsLength ? ctx.userId : null,
        approvalNote: input.approvalNote ?? null,
        reason: input.reason ?? null,
        lines: {
          create: preview.lines.map((l) => ({
            materialId: l.materialId,
            materialCode: l.materialCode,
            materialNameEn: l.materialNameEn,
            materialNameAr: l.materialNameAr,
            materialType: l.materialType,
            standardConsumption: dec(l.standardConsumption).toString(),
            wasteRate: l.wasteRate.toString(),
            effectiveConsumption: l.effectiveConsumption.toString(),
            unitCost: dec(l.unitCost).toString(),
            lineCost: l.lineCost.toString(),
          })),
        },
      },
      select: { id: true, transferPrice: true },
    });

    await writeAudit(tx, {
      action: preview.marginBelowArmsLength
        ? "COST_SNAPSHOT_CREATED_BELOW_FLOOR"
        : "COST_SNAPSHOT_CREATED",
      entityName: "CostSnapshot",
      entityId: snapshot.id,
      after: {
        style: preview.style.code,
        transferPrice: preview.transferPrice.toString(),
        factoryTotalCost: preview.factoryTotalCost.toString(),
        minuteRate: preview.ratePeriod.actualMinuteRate.toString(),
        minuteRatePeriod: `${preview.ratePeriod.fiscalPeriod.year}-${String(preview.ratePeriod.fiscalPeriod.month).padStart(2, "0")}`,
        marginPct: preview.factoryMarginPct,
        belowFloor: preview.marginBelowArmsLength,
      },
      ctx: { ...ctx, reason: input.approvalNote ?? input.reason ?? null },
    });

    return {
      costSnapshotId: snapshot.id,
      transferPrice: snapshot.transferPrice.toString(),
      belowFloor: preview.marginBelowArmsLength,
    };
  });
}
