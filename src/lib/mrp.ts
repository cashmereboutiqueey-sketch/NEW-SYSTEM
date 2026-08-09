import "server-only";
import { db } from "./db";
import { explodeBom } from "@/core/production";
import {
  planRequirements, checkCapacity, belowReorderPoint,
  type MaterialPosition,
} from "@/core/mrp";
import { dec } from "./money";

/**
 * Material requirements, read from what has actually been committed to.
 *
 * Demand comes from confirmed and in-progress production orders only. A draft
 * order is somebody thinking out loud, and buying fabric against it is how a
 * factory ends up with rolls for a run that never happened.
 */

export type MrpOptions = {
  /** Include draft orders too, to see what a plan would need if approved. */
  includeDrafts?: boolean;
  needBy?: Date | null;
};

export async function materialRequirements(options: MrpOptions = {}) {
  const asOf = new Date();

  const orders = await db.productionOrder.findMany({
    where: {
      status: options.includeDrafts
        ? { in: ["DRAFT", "CONFIRMED", "IN_PRODUCTION"] }
        : { in: ["CONFIRMED", "IN_PRODUCTION"] },
    },
    include: {
      style: { include: { bomLines: { include: { material: true } } } },
      materialIssues: true,
    },
  });

  // --- what the committed runs still need -----------------------------
  const requiredByMaterial = new Map<string, ReturnType<typeof dec>>();

  for (const order of orders) {
    // Only the part not yet produced still needs material. Counting the whole
    // order after most of it has been cut would buy fabric twice.
    const outstanding = Math.max(0, order.plannedQty - (order.actualQty ?? 0));
    if (outstanding === 0) continue;

    const exploded = explodeBom(
      order.style.bomLines.map((l) => ({
        materialId: l.materialId,
        materialCode: l.material.code,
        standardConsumption: l.standardConsumption.toString(),
        wasteRateOverride: l.wasteRateOverride?.toString() ?? null,
      })),
      outstanding,
      order.style.plannedWasteRate.toString(),
    );

    for (const line of exploded) {
      // What has already been issued against this order is not needed again.
      const issued = order.materialIssues
        .filter((i) => i.materialId === line.materialId)
        .reduce((s, i) => s.plus(dec(i.actualQty)), dec(0));

      const stillNeeded = line.requiredQty.minus(issued);
      if (stillNeeded.lessThanOrEqualTo(0)) continue;

      requiredByMaterial.set(
        line.materialId,
        (requiredByMaterial.get(line.materialId) ?? dec(0)).plus(stillNeeded),
      );
    }
  }

  // --- what is on the shelf and what is coming ------------------------
  const materials = await db.material.findMany({
    where: { isActive: true },
    include: { uom: true, supplier: true },
  });

  const lots = await db.inventoryLot.findMany({
    where: { state: "RAW_MATERIAL", remainingQty: { gt: 0 } },
    select: { materialId: true, remainingQty: true, reservedQty: true },
  });

  const openLines = await db.purchaseOrderLine.findMany({
    where: { purchaseOrder: { status: { in: ["CONFIRMED", "PARTIALLY_RECEIVED"] } } },
    select: { materialId: true, quantity: true, receivedQty: true },
  });

  const onHandByMaterial = new Map<string, ReturnType<typeof dec>>();
  for (const lot of lots) {
    if (!lot.materialId) continue;
    const available = dec(lot.remainingQty).minus(dec(lot.reservedQty));
    onHandByMaterial.set(
      lot.materialId,
      (onHandByMaterial.get(lot.materialId) ?? dec(0)).plus(available),
    );
  }

  const onOrderByMaterial = new Map<string, ReturnType<typeof dec>>();
  for (const line of openLines) {
    const outstanding = dec(line.quantity).minus(dec(line.receivedQty));
    if (outstanding.lessThanOrEqualTo(0)) continue;
    onOrderByMaterial.set(
      line.materialId,
      (onOrderByMaterial.get(line.materialId) ?? dec(0)).plus(outstanding),
    );
  }

  const positions: MaterialPosition[] = materials.map((m) => ({
    materialId: m.id,
    materialCode: m.code,
    materialNameEn: m.nameEn,
    materialNameAr: m.nameAr,
    uom: m.uom.code,
    required: requiredByMaterial.get(m.id) ?? dec(0),
    onHand: onHandByMaterial.get(m.id) ?? dec(0),
    onOrder: onOrderByMaterial.get(m.id) ?? dec(0),
    // The reorder point doubles as safety stock: it is the level below which
    // the business has already said it does not want to fall.
    safetyStock: m.reorderPoint ? dec(m.reorderPoint) : dec(0),
    leadTimeDays: m.leadTimeDays,
    moq: m.moq ? dec(m.moq) : null,
    packSize: m.packSize ? dec(m.packSize) : null,
    unitCost: dec(m.basePrice).times(dec(m.freightPct).plus(dec(m.dutyPct)).plus(1)),
  }));

  const suggestions = planRequirements(positions, {
    asOf,
    needBy: options.needBy ?? earliestStart(orders),
  });

  const lowStock = belowReorderPoint(
    materials.map((m) => ({
      materialId: m.id,
      materialCode: m.code,
      onHand: onHandByMaterial.get(m.id) ?? dec(0),
      reorderPoint: m.reorderPoint ? dec(m.reorderPoint) : null,
    })),
  );

  const supplierByMaterial = new Map(
    materials.map((m) => [m.id, m.supplier ? { en: m.supplier.nameEn, ar: m.supplier.nameAr } : null]),
  );

  return {
    suggestions: suggestions.map((s) => ({ ...s, supplier: supplierByMaterial.get(s.materialId) ?? null })),
    lowStock,
    positions,
    ordersConsidered: orders.length,
    estimatedSpend: suggestions.reduce((s, x) => s.plus(x.estimatedCost), dec(0)),
  };
}

/** The earliest date any committed run is due to start. */
function earliestStart(
  orders: { plannedStart: Date | null; orderDate: Date }[],
): Date | null {
  const dates = orders
    .map((o) => o.plannedStart ?? o.orderDate)
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime());
  return dates[0] ?? null;
}

/**
 * Whether the committed runs fit in the month's remaining capacity.
 *
 * Measured against productive minutes, so a factory at 60% utilisation is not
 * told it has its full clock available.
 */
export async function capacityOutlook(entityId: string, fiscalPeriodId: string) {
  const [rate, bookings] = await Promise.all([
    db.minuteRatePeriod.findUnique({
      where: { entityId_fiscalPeriodId: { entityId, fiscalPeriodId } },
    }),
    db.capacityBooking.findMany({ where: { fiscalPeriodId } }),
  ]);

  if (!rate) return null;

  const booked = bookings.reduce((s, b) => s.plus(dec(b.minutes)), dec(0));

  // Unconfirmed drafts are what a planner is deciding about, so they are
  // shown as the thing being checked rather than as already booked.
  const drafts = await db.productionOrder.findMany({
    where: { status: "DRAFT" },
    include: { style: true },
  });
  const draftMinutes = drafts.reduce(
    (s, o) => s.plus(dec(o.style.totalSmvMinutes).times(o.plannedQty)),
    dec(0),
  );

  return {
    ...checkCapacity({
      productiveMinutes: rate.productiveMinutes,
      alreadyBookedMinutes: booked,
      minutesRequired: draftMinutes,
    }),
    draftOrders: drafts.length,
    utilisationRate: rate.utilisationRate.toString(),
    efficiencyRate: rate.efficiencyRate.toString(),
    grossAvailableMinutes: rate.grossAvailableMinutes,
  };
}
