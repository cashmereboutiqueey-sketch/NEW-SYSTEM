import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "./db";
import { nextDocumentNumber, postEntry } from "./ledger";
import { writeAudit, type AuditContext } from "./audit";
import { mintUnitsForOutput } from "./garment-units";
import { createCostSnapshot } from "./costing";
import { issueMaterialToProduction, receiveFinishedGoods } from "./inventory";
import { explodeBom, variance, actualWasteRate } from "@/core/production";
import { dec } from "./money";
import { command } from "./command";

/** Work in progress, and where its unrelieved remainder is cleared to. */
const ACC_WIP = "1320";
const ACC_MATERIAL_VARIANCE = "5150";

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
  return command("production.createProductionOrder", input, ctx, async () => {
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
  return command("production.confirmProductionOrder", input, ctx, async () => {
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
  });
}

type BillLine = {
  materialId: string;
  materialCode: string;
  standardConsumption: Prisma.Decimal;
  wasteRate: Prisma.Decimal;
};

/**
 * The bill of materials a run is held to.
 *
 * Frozen at confirmation, from the cost snapshot, and live only while the
 * order is still a draft. Reading the style's current bill for a run already
 * under way meant an edit made for next season changed what this one was
 * supposed to consume: a material dropped from the style could no longer be
 * issued to a run that was cut with it, and one added could block it from
 * closing.
 */
async function billOf(order: { costSnapshotId: string | null; styleId: string }): Promise<BillLine[]> {
  if (order.costSnapshotId) {
    const lines = await db.costSnapshotLine.findMany({
      where: { costSnapshotId: order.costSnapshotId },
      select: { materialId: true, materialCode: true, standardConsumption: true, wasteRate: true },
    });
    return lines;
  }
  const style = await db.style.findUniqueOrThrow({
    where: { id: order.styleId },
    include: { bomLines: { include: { material: true } } },
  });
  return style.bomLines.map((l) => ({
    materialId: l.materialId,
    materialCode: l.material.code,
    standardConsumption: l.standardConsumption,
    wasteRate: l.wasteRateOverride ?? style.plannedWasteRate,
  }));
}

/**
 * Waste-free consumption per garment, from the bill the run is held to.
 *
 * The same figures the receipt checks issued material against, so a screen
 * that offers to issue what is missing offers exactly what would pass.
 */
export async function billForOrder(productionOrderId: string) {
  const order = await db.productionOrder.findUniqueOrThrow({ where: { id: productionOrderId } });
  return (await billOf(order)).map((l) => ({
    materialId: l.materialId,
    materialCode: l.materialCode,
    perGarment: l.standardConsumption.toString(),
  }));
}

/** What the bill says this run should consume, per material, waste included. */
export async function plannedMaterials(productionOrderId: string) {
  const order = await db.productionOrder.findUniqueOrThrow({ where: { id: productionOrderId } });
  const bill = await billOf(order);

  return explodeBom(
    bill.map((l) => ({
      materialId: l.materialId,
      materialCode: l.materialCode,
      standardConsumption: l.standardConsumption.toString(),
      wasteRateOverride: l.wasteRate.toString(),
    })),
    order.plannedQty,
    0,
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
  return command("production.issueForOrder", input, ctx, async () => {
    const order = await db.productionOrder.findUnique({
      where: { id: input.productionOrderId },
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

    // The bill frozen when the order was confirmed, not the style's today.
    const bomLine = (await billOf(order)).find((l) => l.materialId === input.materialId);
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
  });
}

/**
 * Books finished garments against a run, and closes it when told to.
 *
 * Output is a size curve, not a number: one run of a dress yields so many
 * black mediums, so many cream larges. Each SKU becomes its own lot, because
 * that is the granularity stock is counted and sold at. The unit cost is the
 * same for every size — the snapshot costs the style, not the size — so
 * splitting the run changes how the output is labelled, never what it cost.
 * Garments enter stock at the frozen snapshot cost, not a recomputed one, so
 * what the costing promised is what the balance sheet carries.
 *
 * A run can deliver in parts. With `close: false` the garments go into stock
 * and the order stays in production with the rest still owed — 72 of 100 is
 * 72 received and 28 to come, not a finished run. Closing is a separate,
 * deliberate act, and it is where the work-in-progress left behind is cleared
 * to variance, whether the run made everything or stopped short.
 *
 * Every receipt is checked against the material issued. A garment cannot be
 * made out of fabric that never left the storeroom, so if what was issued
 * does not cover the frozen standard for everything made so far — good and
 * rejected, since a reject consumed its fabric too — the receipt is refused.
 * The standard is the waste-free figure, so this does not second-guess the
 * cutting room's waste; it only refuses output with nothing behind it. When a
 * shortfall is genuine (a bad count, fabric borrowed from another run), the
 * reason is recorded as an approved variance and the run goes through.
 */
export async function completeProductionOrder(
  input: {
    productionOrderId: string;
    /** How many good garments of each SKU came off the line in this receipt. */
    outputs: { variantId: string; goodQty: number }[];
    rejectedQty?: number;
    locationId: string;
    entityId: string;
    completedDate: Date;
    actualTotalMinutes?: string;
    /** Close the run after this receipt. Defaults to true. */
    close?: boolean;
    /** Why the run may go through with less material issued than it made. */
    shortfallReason?: string | null;
  },
  ctx: AuditContext,
): Promise<{
  orderNumber: string;
  /** Good garments in this receipt. */
  goodQty: number;
  /** Good garments across every receipt on the run so far. */
  totalGoodQty: number;
  closed: boolean;
  costVariance: string;
  fabricVariance: string;
  finishedLotNumbers: string[];
  /** The tag code of every garment this receipt produced. */
  serials: string[];
}> {
  return command("production.completeProductionOrder", input, ctx, async () => {
    const close = input.close ?? true;
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
    if (order.status !== "CONFIRMED" && order.status !== "IN_PRODUCTION") {
      throw new ProductionError(
        `Order ${order.orderNumber} is ${order.status.toLowerCase()} and cannot receive output.`,
      );
    }

    const rejectedNow = input.rejectedQty ?? 0;
    if (!Number.isInteger(rejectedNow) || rejectedNow < 0) {
      throw new ProductionError("Rejected garments are counted whole, and cannot be negative.");
    }

    const outputs = input.outputs.filter((o) => o.goodQty > 0);
    if (outputs.some((o) => !Number.isInteger(o.goodQty))) {
      throw new ProductionError("Garments come off the line whole; quantities must be integers.");
    }
    if (new Set(outputs.map((o) => o.variantId)).size !== outputs.length) {
      throw new ProductionError("The same SKU is listed twice in the output.");
    }

    const goodQty = outputs.reduce((s, o) => s + o.goodQty, 0);
    const earlierGood = order.actualQty ?? 0;
    const totalGood = earlierGood + goodQty;
    const totalRejected = order.rejectedQty + rejectedNow;

    // Closing a run that already delivered needs nothing new; anything else
    // must bring garments with it.
    if (goodQty === 0 && !(close && earlierGood > 0)) {
      throw new ProductionError("Completed quantity must be greater than zero.");
    }

    const styleVariants = await db.variant.findMany({
      where: { id: { in: outputs.map((o) => o.variantId) } },
      select: { id: true, sku: true, styleId: true },
    });
    const foreign = styleVariants.find((v) => v.styleId !== order.styleId);
    if (foreign) {
      throw new ProductionError(
        `${foreign.sku} is not a SKU of the style this order was raised for.`,
      );
    }
    if (styleVariants.length !== outputs.length) {
      throw new ProductionError("One of the output SKUs does not exist.");
    }

    const snap = order.costSnapshot;

    const issues = await db.materialIssue.findMany({
      where: { productionOrderId: order.id },
      select: { materialId: true, actualQty: true, unitCost: true },
    });
    const issuedQty = new Map<string, ReturnType<typeof dec>>();
    for (const i of issues) {
      issuedQty.set(i.materialId, dec(issuedQty.get(i.materialId) ?? 0).plus(dec(i.actualQty)));
    }

    // Quantity, not value: material bought below the standard the snapshot
    // froze is an ordinary price difference, and refusing on that would block
    // a perfectly good run every time purchasing negotiated well.
    const made = totalGood + totalRejected;
    const shortfalls = (await billOf(order))
      .map((line) => {
        const required = dec(line.standardConsumption).times(made);
        const issued = dec(issuedQty.get(line.materialId) ?? 0);
        return { material: line.materialCode, issued, required };
      })
      .filter((s) => s.issued.lessThan(s.required.toDecimalPlaces(4)));

    const shortfallReason = input.shortfallReason?.trim() || null;
    if (shortfalls.length > 0 && !shortfallReason) {
      const detail = shortfalls
        .map((s) => `${s.material} ${s.issued.toFixed(2)} of ${s.required.toFixed(2)}`)
        .join(", ");
      throw new ProductionError(
        `Not enough material was issued for ${made} garments: ${detail}. ` +
          `Issue the rest before receiving them, or record why the run used less.`,
      );
    }

    const issuedValue = issues.reduce(
      (s, i) => s.plus(dec(i.actualQty).times(dec(i.unitCost))),
      dec(0),
    );

    // Split so the receipt can credit WIP for material and the absorption
    // account for conversion — see receiveFinishedGoods.
    const finishedLotNumbers: string[] = [];
    const mintedLots: { lotId: string; variantId: string; quantity: number }[] = [];
    for (const output of outputs) {
      const received = await receiveFinishedGoods(
        {
          variantId: output.variantId,
          locationId: input.locationId,
          entityId: input.entityId,
          quantity: String(output.goodQty),
          unitCost: snap.factoryTotalCost.toString(),
          materialUnitCost: snap.materialCost.toString(),
          receivedDate: input.completedDate,
          productionOrderId: order.id,
        },
        ctx,
      );
      finishedLotNumbers.push(received.lotNumber);
      mintedLots.push({
        lotId: received.lotId,
        variantId: output.variantId,
        quantity: output.goodQty,
      });
    }

    // Work in progress was charged with what the material actually cost and has
    // been relieved, receipt by receipt, at the frozen standard. Once the run
    // closes, whatever is left is the difference between the two, and it has
    // to be cleared or WIP carries a balance for a run that finished. That
    // includes material issued for garments the run never made: closing short
    // is a decision, and its cost lands in variance where it can be seen.
    //
    // Under-relieved (material cost more than standard) is an unfavourable
    // variance and a debit; over-relieved is favourable and a credit. Nothing
    // is cleared while the run is still open: the balance is the material
    // waiting to become the garments still owed.
    const relievedValue = dec(snap.materialCost).times(totalGood);
    const materialVariance = close
      ? issuedValue.minus(relievedValue).toDecimalPlaces(4)
      : dec(0);

    if (!materialVariance.isZero()) {
      await db.$transaction(async (tx) => {
        const account = async (code: string) => {
          const a = await tx.account.findUnique({ where: { code }, select: { id: true } });
          if (!a) throw new ProductionError(`Account ${code} is missing from the chart of accounts.`);
          return a.id;
        };

        const unfavourable = materialVariance.greaterThan(0);
        await postEntry(tx, {
          entityId: input.entityId,
          postingDate: input.completedDate,
          sourceType: "PRODUCTION_OUTPUT",
          sourceId: order.id,
          memo: `Material cost variance on ${order.orderNumber}`,
          ctx,
          lines: [
            {
              accountId: await account(ACC_MATERIAL_VARIANCE),
              debit: unfavourable ? materialVariance : undefined,
              credit: unfavourable ? undefined : materialVariance.abs(),
              entityId: input.entityId,
              description: `Issued ${issuedValue.toFixed(2)} against ${relievedValue.toFixed(2)} at standard`,
            },
            {
              accountId: await account(ACC_WIP),
              credit: unfavourable ? materialVariance : undefined,
              debit: unfavourable ? undefined : materialVariance.abs(),
              entityId: input.entityId,
              description: `Work in progress cleared on ${order.orderNumber}`,
            },
          ],
        });
      });
    }

    return db.$transaction(async (tx) => {
      // Every garment gets its own tag code here, as it starts existing. Doing
      // it later would mean a short delivery could say how many were missing
      // but never which ones.
      const serials: string[] = [];
      for (const minted of mintedLots) {
        serials.push(
          ...(await mintUnitsForOutput(tx, {
            variantId: minted.variantId,
            quantity: minted.quantity,
            lotId: minted.lotId,
            productionOrderId: order.id,
            entityId: input.entityId,
            locationId: input.locationId,
          })),
        );
      }

      const actualTotalCost = dec(snap.factoryTotalCost).times(totalGood);
      const costVar = variance(order.plannedTotalCost ?? 0, actualTotalCost);
      const fabricVar = variance(order.plannedFabricQty ?? 0, order.actualFabricQty ?? 0);

      if (close) {
        const actualMinutes = input.actualTotalMinutes
          ? dec(input.actualTotalMinutes)
          : dec(snap.smvMinutes).times(totalGood);

        await tx.productionOrder.update({
          where: { id: order.id },
          data: {
            status: "COMPLETED",
            actualQty: totalGood,
            rejectedQty: totalRejected,
            actualFinish: input.completedDate,
            actualTotalMinutes: actualMinutes.toString(),
            actualSmvPerUnit: actualMinutes.div(totalGood).toString(),
            actualTotalCost: actualTotalCost.toString(),
            costVariance: costVar.variance.toString(),
            fabricVariance: fabricVar.variance.toString(),
          },
        });
      } else {
        await tx.productionOrder.update({
          where: { id: order.id },
          data: { status: "IN_PRODUCTION", actualQty: totalGood, rejectedQty: totalRejected },
        });
      }

      // Planned garments neither made nor rejected when the run closed. Not an
      // error — runs stop short — but the record says so rather than letting
      // a closed order imply it delivered what it planned.
      const closedShort = close ? Math.max(0, order.plannedQty - totalGood - totalRejected) : 0;

      await writeAudit(tx, {
        action: close ? "PRODUCTION_ORDER_COMPLETED" : "PRODUCTION_OUTPUT_RECEIVED",
        entityName: "ProductionOrder",
        entityId: order.id,
        before: { status: order.status, plannedQty: order.plannedQty, goodSoFar: earlierGood },
        after: {
          status: close ? "COMPLETED" : "IN_PRODUCTION",
          goodQty,
          rejectedQty: rejectedNow,
          totalGoodQty: totalGood,
          totalRejectedQty: totalRejected,
          closedShort,
          // The size curve is part of the record: it is what a buyer asks about
          // when the mediums sell out and the extra-larges do not.
          outputs: outputs.map((o) => ({
            sku: styleVariants.find((v) => v.id === o.variantId)?.sku ?? o.variantId,
            goodQty: o.goodQty,
          })),
          // An approved shortfall is the exception the record exists for.
          materialShortfalls: shortfalls.map((s) => ({
            material: s.material,
            issued: s.issued.toString(),
            required: s.required.toString(),
          })),
          shortfallReason,
          actualTotalCost: actualTotalCost.toString(),
          costVariance: costVar.variance.toString(),
          fabricVariance: fabricVar.variance.toString(),
          materialVariance: materialVariance.toString(),
          finishedLots: finishedLotNumbers,
          firstSerial: serials[0] ?? null,
          lastSerial: serials[serials.length - 1] ?? null,
        },
        ctx,
      });

      return {
        orderNumber: order.orderNumber,
        goodQty,
        totalGoodQty: totalGood,
        closed: close,
        serials,
        costVariance: costVar.variance.toString(),
        fabricVariance: fabricVar.variance.toString(),
        finishedLotNumbers,
      };
    });
  });
}
