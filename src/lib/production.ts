import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "./db";
import { nextDocumentNumber } from "./ledger";
import { writeAudit, type AuditContext } from "./audit";
import { createCostSnapshot } from "./costing";
import { issueMaterialToProduction, receiveFinishedGoods } from "./inventory";
import { explodeBom, variance, actualWasteRate } from "@/core/production";
import { dec } from "./money";

/**
 * Production orders.
 *
 * Confirming an order freezes its cost basis. From that moment the order
 * carries its own snapshot and minute-rate period, so recosting the style next
 * month cannot retroactively change what this run was priced at.
 *
 * Planned figures are computed at confirmation and never touched again;
 * actuals accumulate as material is issued and garments are received. The gap
 * between them is the variance report.
 */

export class ProductionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionError";
  }
}

export async function createProductionOrder(
  input: {
    styleId: string;
    plannedQty: number;
    orderDate: Date;
    plannedStart?: Date | null;
    plannedFinish?: Date | null;
    lines?: { variantId: string; plannedQty: number }[];
    notes?: string | null;
  },
  ctx: AuditContext,
): Promise<{ productionOrderId: string; orderNumber: string }> {
  if (input.plannedQty <= 0) {
    throw new ProductionError("Planned quantity must be greater than zero.");
  }

  const lineTotal = (input.lines ?? []).reduce((s, l) => s + l.plannedQty, 0);
  if (input.lines?.length && lineTotal !== input.plannedQty) {
    // Otherwise the order claims one quantity and the size breakdown another.
    throw new ProductionError(
      `The size breakdown totals ${lineTotal} but the order is for ${input.plannedQty}.`,
    );
  }

  return db.$transaction(async (tx) => {
    const style = await tx.style.findUnique({
      where: { id: input.styleId },
      include: { bomLines: true, operations: true },
    });
    if (!style) throw new ProductionError("Style not found.");
    if (style.bomLines.length === 0) {
      throw new ProductionError(`Style ${style.code} has no bill of materials.`);
    }
    if (style.operations.length === 0) {
      throw new ProductionError(`Style ${style.code} has no operations, so it has no SMV.`);
    }

    const orderNumber = await nextDocumentNumber(tx, "PO", input.orderDate);

    const order = await tx.productionOrder.create({
      data: {
        orderNumber,
        styleId: style.id,
        status: "DRAFT",
        plannedQty: input.plannedQty,
        orderDate: input.orderDate,
        plannedStart: input.plannedStart ?? null,
        plannedFinish: input.plannedFinish ?? null,
        notes: input.notes ?? null,
        lines: input.lines?.length
          ? {
              create: input.lines.map((l) => ({
                variantId: l.variantId,
                plannedQty: l.plannedQty,
              })),
            }
          : undefined,
      },
    });

    await writeAudit(tx, {
      action: "PRODUCTION_ORDER_CREATED",
      entityName: "ProductionOrder",
      entityId: order.id,
      after: { orderNumber, style: style.code, plannedQty: input.plannedQty },
      ctx,
    });

    return { productionOrderId: order.id, orderNumber };
  });
}

/**
 * Freezes the order's cost basis and books its capacity.
 *
 * This is the point of no return for costing: the snapshot created here is
 * what the order is measured against for the rest of its life.
 */
export async function confirmProductionOrder(
  input: { productionOrderId: string; minuteRatePeriodId: string; reason?: string },
  ctx: AuditContext,
): Promise<{ costSnapshotId: string; plannedTotalCost: string; orderNumber: string }> {
  const order = await db.productionOrder.findUnique({
    where: { id: input.productionOrderId },
    include: { style: { include: { bomLines: true, operations: true } } },
  });
  if (!order) throw new ProductionError("Production order not found.");
  if (order.status !== "DRAFT") {
    throw new ProductionError(
      `Order ${order.orderNumber} is already ${order.status.toLowerCase()} and cannot be confirmed again.`,
    );
  }

  // Created outside the transaction below because snapshot creation opens its
  // own; nesting Prisma interactive transactions is not supported.
  const snapshot = await createCostSnapshot(
    {
      styleId: order.styleId,
      minuteRatePeriodId: input.minuteRatePeriodId,
      reason: input.reason ?? `Confirming ${order.orderNumber}`,
    },
    ctx,
  );

  return db.$transaction(async (tx) => {
    const snap = await tx.costSnapshot.findUniqueOrThrow({
      where: { id: snapshot.costSnapshotId },
      include: { lines: true },
    });

    const qty = dec(order.plannedQty);
    const plannedTotalCost = dec(snap.factoryTotalCost).times(qty);
    const plannedTotalMinutes = dec(snap.smvMinutes).times(qty);

    // Fabric only, so the figure is comparable with what the cutting room
    // actually issues in metres.
    const plannedFabricQty = snap.lines
      .filter((l) => l.materialType === "FABRIC")
      .reduce((s, l) => s.plus(dec(l.effectiveConsumption)), dec(0))
      .times(qty);

    await tx.productionOrder.update({
      where: { id: order.id },
      data: {
        status: "CONFIRMED",
        costSnapshotId: snap.id,
        minuteRatePeriodId: input.minuteRatePeriodId,
        confirmedAt: new Date(),
        plannedFabricQty: plannedFabricQty.toString(),
        plannedSmvPerUnit: snap.smvMinutes,
        plannedTotalMinutes: plannedTotalMinutes.toString(),
        plannedTotalCost: plannedTotalCost.toString(),
        // Seeded to zero rather than left null: incrementing a null column in
        // SQL yields null, so the first issue would silently vanish.
        actualFabricQty: "0",
      },
    });

    // Booked so idle capacity is visible before the month starts, not after.
    const ratePeriod = await tx.minuteRatePeriod.findUniqueOrThrow({
      where: { id: input.minuteRatePeriodId },
    });
    await tx.capacityBooking.create({
      data: {
        fiscalPeriodId: ratePeriod.fiscalPeriodId,
        source: "PRODUCTION_ORDER",
        productionOrderId: order.id,
        minutes: plannedTotalMinutes.toString(),
        notes: `Confirmed ${order.orderNumber}`,
      },
    });

    await writeAudit(tx, {
      action: "PRODUCTION_ORDER_CONFIRMED",
      entityName: "ProductionOrder",
      entityId: order.id,
      before: { status: "DRAFT" },
      after: {
        status: "CONFIRMED",
        costSnapshot: snap.id,
        transferPrice: snap.transferPrice.toString(),
        plannedTotalCost: plannedTotalCost.toString(),
        plannedFabricQty: plannedFabricQty.toString(),
        plannedTotalMinutes: plannedTotalMinutes.toString(),
      },
      ctx,
    });

    return {
      costSnapshotId: snap.id,
      plannedTotalCost: plannedTotalCost.toString(),
      orderNumber: order.orderNumber,
    };
  });
}

/** What the BOM says this run should consume, per material. */
export async function plannedMaterials(productionOrderId: string) {
  const order = await db.productionOrder.findUniqueOrThrow({
    where: { id: productionOrderId },
    include: { style: { include: { bomLines: { include: { material: true } } } } },
  });

  return explodeBom(
    order.style.bomLines.map((l) => ({
      materialId: l.materialId,
      materialCode: l.material.code,
      standardConsumption: l.standardConsumption.toString(),
      wasteRateOverride: l.wasteRateOverride?.toString() ?? null,
    })),
    order.plannedQty,
    order.style.plannedWasteRate.toString(),
  );
}

/**
 * Issues material against an order and records the waste that actually
 * happened.
 *
 * `standardQty` is stored waste-free so `actualWasteRate` stays comparable
 * with the style's planned rate. Costing continues to use the planned rate —
 * this drives variance and alerts only.
 */
export async function issueForOrder(
  input: {
    productionOrderId: string;
    materialId: string;
    locationId: string;
    entityId: string;
    quantity: string;
    issueDate: Date;
    piecesCut?: number;
    cuttingTicketId?: string | null;
  },
  ctx: AuditContext,
): Promise<{ totalCost: string; actualWasteRate: string | null; journalEntryNumber: string }> {
  const order = await db.productionOrder.findUnique({
    where: { id: input.productionOrderId },
    include: { style: { include: { bomLines: true } } },
  });
  if (!order) throw new ProductionError("Production order not found.");
  if (order.status === "DRAFT") {
    throw new ProductionError(
      `Order ${order.orderNumber} must be confirmed before material is issued, so the cost basis is frozen first.`,
    );
  }
  if (order.status === "CANCELLED" || order.status === "COMPLETED") {
    throw new ProductionError(`Order ${order.orderNumber} is ${order.status.toLowerCase()}.`);
  }

  const bomLine = order.style.bomLines.find((l) => l.materialId === input.materialId);
  if (!bomLine) {
    throw new ProductionError("That material is not in this style's bill of materials.");
  }

  // The FIFO issue and its journal happen here.
  const issue = await issueMaterialToProduction(
    {
      materialId: input.materialId,
      locationId: input.locationId,
      entityId: input.entityId,
      quantity: input.quantity,
      issueDate: input.issueDate,
      productionOrderId: order.id,
      referenceType: "PRODUCTION_ORDER",
      referenceId: order.id,
    },
    ctx,
  );

  const piecesCut = input.piecesCut ?? order.plannedQty;
  const standardQty = dec(bomLine.standardConsumption).times(piecesCut);
  const waste = actualWasteRate(input.quantity, standardQty);

  await db.$transaction(async (tx) => {
    await tx.materialIssue.create({
      data: {
        productionOrderId: order.id,
        cuttingTicketId: input.cuttingTicketId ?? null,
        materialId: input.materialId,
        issueDate: input.issueDate,
        standardQty: standardQty.toString(),
        actualQty: dec(input.quantity).toString(),
        varianceQty: dec(input.quantity).minus(standardQty).toString(),
        actualWasteRate: (waste ?? dec(0)).toString(),
        unitCost: dec(issue.totalCost).div(dec(input.quantity)).toString(),
        varianceValue: dec(issue.totalCost)
          .div(dec(input.quantity))
          .times(dec(input.quantity).minus(standardQty))
          .toString(),
      },
    });

    // Accumulated so the order always knows what it has really consumed.
    const isFabric = await tx.material.findUnique({
      where: { id: input.materialId },
      select: { type: true },
    });
    if (isFabric?.type === "FABRIC") {
      await tx.productionOrder.update({
        where: { id: order.id },
        data: {
          status: order.status === "CONFIRMED" ? "IN_PRODUCTION" : order.status,
          actualFabricQty: { increment: dec(input.quantity).toString() },
        },
      });
    } else if (order.status === "CONFIRMED") {
      await tx.productionOrder.update({
        where: { id: order.id },
        data: { status: "IN_PRODUCTION" },
      });
    }
  });

  return {
    totalCost: issue.totalCost,
    actualWasteRate: waste?.toString() ?? null,
    journalEntryNumber: issue.journalEntryNumber,
  };
}

/**
 * Receives good output and closes the order, computing the variance.
 *
 * Garments enter stock at the frozen snapshot cost, not a recomputed one, so
 * what the costing promised is what the balance sheet carries.
 */
export async function completeProductionOrder(
  input: {
    productionOrderId: string;
    goodQty: number;
    rejectedQty?: number;
    variantId: string;
    locationId: string;
    entityId: string;
    completedDate: Date;
    actualTotalMinutes?: string;
  },
  ctx: AuditContext,
): Promise<{
  orderNumber: string;
  costVariance: string;
  fabricVariance: string;
  finishedLotNumber: string;
}> {
  const order = await db.productionOrder.findUnique({
    where: { id: input.productionOrderId },
    include: { costSnapshot: true },
  });
  if (!order) throw new ProductionError("Production order not found.");
  if (!order.costSnapshot) {
    throw new ProductionError("Order has no frozen cost snapshot; confirm it first.");
  }
  if (order.status === "COMPLETED") {
    throw new ProductionError(`Order ${order.orderNumber} is already complete.`);
  }
  if (input.goodQty <= 0) {
    throw new ProductionError("Completed quantity must be greater than zero.");
  }

  const snap = order.costSnapshot;

  // Split so the receipt can credit WIP for material and the absorption
  // account for conversion — see receiveFinishedGoods.
  const received = await receiveFinishedGoods(
    {
      variantId: input.variantId,
      locationId: input.locationId,
      entityId: input.entityId,
      quantity: String(input.goodQty),
      unitCost: snap.factoryTotalCost.toString(),
      materialUnitCost: snap.materialCost.toString(),
      receivedDate: input.completedDate,
      productionOrderId: order.id,
    },
    ctx,
  );

  return db.$transaction(async (tx) => {
    const actualTotalCost = dec(snap.factoryTotalCost).times(input.goodQty);
    const costVar = variance(order.plannedTotalCost ?? 0, actualTotalCost);
    const fabricVar = variance(order.plannedFabricQty ?? 0, order.actualFabricQty ?? 0);

    const actualMinutes = input.actualTotalMinutes
      ? dec(input.actualTotalMinutes)
      : dec(snap.smvMinutes).times(input.goodQty);

    await tx.productionOrder.update({
      where: { id: order.id },
      data: {
        status: "COMPLETED",
        actualQty: input.goodQty,
        rejectedQty: input.rejectedQty ?? 0,
        actualFinish: input.completedDate,
        actualTotalMinutes: actualMinutes.toString(),
        actualSmvPerUnit: actualMinutes.div(input.goodQty).toString(),
        actualTotalCost: actualTotalCost.toString(),
        costVariance: costVar.variance.toString(),
        fabricVariance: fabricVar.variance.toString(),
      },
    });

    await writeAudit(tx, {
      action: "PRODUCTION_ORDER_COMPLETED",
      entityName: "ProductionOrder",
      entityId: order.id,
      before: { status: order.status, plannedQty: order.plannedQty },
      after: {
        status: "COMPLETED",
        goodQty: input.goodQty,
        rejectedQty: input.rejectedQty ?? 0,
        actualTotalCost: actualTotalCost.toString(),
        costVariance: costVar.variance.toString(),
        fabricVariance: fabricVar.variance.toString(),
        finishedLot: received.lotNumber,
      },
      ctx,
    });

    return {
      orderNumber: order.orderNumber,
      costVariance: costVar.variance.toString(),
      fabricVariance: fabricVar.variance.toString(),
      finishedLotNumber: received.lotNumber,
    };
  });
}
