import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "./db";
import { consumeFifo, type Lot } from "@/core/fifo";
import { postEntry, nextDocumentNumber } from "./ledger";
import { writeAudit, type AuditContext } from "./audit";
import { dec } from "./money";

/**
 * Inventory as a ledger.
 *
 * Every quantity change writes an `InventoryMovement`; nothing ever assigns a
 * balance directly. `remainingQty` on a lot is a running cache of those
 * movements and must always agree with them — `reconcileLot` is what proves it.
 *
 * Each movement also posts its journal in the same transaction, so stock value
 * and the general ledger cannot drift apart.
 */

export class InventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryError";
  }
}

const ACC = {
  RAW: "1310",
  WIP: "1320",
  FG_FACTORY: "1330",
  FG_BRAND: "1340",
  PAYABLES: "2110",
  COGS_MATERIAL: "5100",
  SCRAP_LOSS: "5400",
  CONVERSION_ABSORBED: "6190",
} as const;

async function accountId(tx: Prisma.TransactionClient, code: string): Promise<string> {
  const a = await tx.account.findUnique({ where: { code }, select: { id: true } });
  if (!a) throw new InventoryError(`Account ${code} is missing from the chart of accounts.`);
  return a.id;
}

/** The asset account a given inventory state sits in. */
function stateAccount(state: "RAW_MATERIAL" | "WIP" | "FINISHED_GOODS", isBrand: boolean) {
  if (state === "RAW_MATERIAL") return ACC.RAW;
  if (state === "WIP") return ACC.WIP;
  return isBrand ? ACC.FG_BRAND : ACC.FG_FACTORY;
}

/**
 * Receives material into stock, creating a FIFO lot.
 *
 *   DR raw materials    CR trade payables
 *
 * `unitCost` must be the landed cost — purchase price plus freight and duty —
 * because that is what the material genuinely costs to have on the floor.
 */
export async function receiveMaterial(
  input: {
    materialId: string;
    locationId: string;
    entityId: string;
    quantity: string;
    unitCost: string;
    receivedDate: Date;
    supplierId?: string | null;
    referenceType?: string;
    referenceId?: string;
  },
  ctx: AuditContext,
): Promise<{ lotId: string; lotNumber: string; journalEntryNumber: string }> {
  const quantity = dec(input.quantity);
  const unitCost = dec(input.unitCost);

  if (quantity.lessThanOrEqualTo(0)) {
    throw new InventoryError("Received quantity must be greater than zero.");
  }
  if (unitCost.lessThan(0)) {
    throw new InventoryError("Unit cost cannot be negative.");
  }

  return db.$transaction(async (tx) => {
    const lotNumber = await nextDocumentNumber(tx, "LOT", input.receivedDate);
    const totalCost = quantity.times(unitCost);

    const lot = await tx.inventoryLot.create({
      data: {
        lotNumber,
        state: "RAW_MATERIAL",
        materialId: input.materialId,
        locationId: input.locationId,
        entityId: input.entityId,
        originalQty: quantity.toString(),
        remainingQty: quantity.toString(),
        unitCost: unitCost.toString(),
        receivedDate: input.receivedDate,
      },
    });

    const journal = await postEntry(tx, {
      entityId: input.entityId,
      postingDate: input.receivedDate,
      sourceType: "GOODS_RECEIPT",
      sourceId: lot.id,
      memo: `Material receipt ${lotNumber}`,
      ctx,
      lines: [
        {
          accountId: await accountId(tx, ACC.RAW),
          debit: totalCost,
          entityId: input.entityId,
          supplierId: input.supplierId ?? null,
          description: `Receipt ${lotNumber}`,
        },
        {
          accountId: await accountId(tx, ACC.PAYABLES),
          credit: totalCost,
          entityId: input.entityId,
          supplierId: input.supplierId ?? null,
          description: `Receipt ${lotNumber}`,
        },
      ],
    });

    await tx.inventoryMovement.create({
      data: {
        lotId: lot.id,
        type: "RECEIPT",
        quantity: quantity.toString(),
        unitCost: unitCost.toString(),
        totalCost: totalCost.toString(),
        movementDate: input.receivedDate,
        toLocationId: input.locationId,
        referenceType: input.referenceType ?? "MANUAL_RECEIPT",
        referenceId: input.referenceId ?? null,
        journalEntryId: journal.id,
      },
    });

    await writeAudit(tx, {
      action: "INVENTORY_RECEIVED",
      entityName: "InventoryLot",
      entityId: lot.id,
      after: {
        lotNumber, quantity: quantity.toString(), unitCost: unitCost.toString(),
        totalCost: totalCost.toString(), journalEntry: journal.entryNumber,
      },
      ctx,
    });

    return { lotId: lot.id, lotNumber, journalEntryNumber: journal.entryNumber };
  });
}

/** Reads the open lots for a material at a location, in FIFO order. */
async function openLots(
  tx: Prisma.TransactionClient,
  where: { materialId?: string; variantId?: string; locationId: string; state: "RAW_MATERIAL" | "FINISHED_GOODS" },
): Promise<Lot[]> {
  const rows = await tx.inventoryLot.findMany({
    where: {
      ...(where.materialId ? { materialId: where.materialId } : {}),
      ...(where.variantId ? { variantId: where.variantId } : {}),
      locationId: where.locationId,
      state: where.state,
      remainingQty: { gt: 0 },
    },
    orderBy: [{ receivedDate: "asc" }, { sequence: "asc" }],
  });

  return rows.map((r) => ({
    id: r.id,
    receivedDate: r.receivedDate,
    sequence: r.sequence,
    remainingQty: r.remainingQty.toString(),
    unitCost: r.unitCost.toString(),
  }));
}

/**
 * Issues material to production, consuming lots oldest first.
 *
 *   DR work in progress    CR raw materials
 *
 * The value transferred is the FIFO cost of the lots actually consumed, not a
 * standard or current price.
 */
export async function issueMaterialToProduction(
  input: {
    materialId: string;
    locationId: string;
    entityId: string;
    quantity: string;
    issueDate: Date;
    productionOrderId?: string | null;
    referenceType?: string;
    referenceId?: string;
  },
  ctx: AuditContext,
): Promise<{ totalCost: string; allocations: { lotId: string; quantity: string; cost: string }[]; journalEntryNumber: string }> {
  return db.$transaction(async (tx) => {
    const lots = await openLots(tx, {
      materialId: input.materialId,
      locationId: input.locationId,
      state: "RAW_MATERIAL",
    });

    const result = consumeFifo(lots, input.quantity);
    if (!result.ok) {
      // Refused outright: a partial issue would leave production believing it
      // had material it does not have.
      throw new InventoryError(
        `Not enough stock: ${result.requested.toString()} requested, ${result.available.toString()} available, short by ${result.shortfall.toString()}.`,
      );
    }

    const journal = await postEntry(tx, {
      entityId: input.entityId,
      postingDate: input.issueDate,
      sourceType: "MATERIAL_ISSUE",
      sourceId: input.productionOrderId ?? null,
      memo: "Material issued to production",
      ctx,
      lines: [
        {
          accountId: await accountId(tx, ACC.WIP),
          debit: result.totalCost,
          entityId: input.entityId,
          description: "Material issued to production",
        },
        {
          accountId: await accountId(tx, ACC.RAW),
          credit: result.totalCost,
          entityId: input.entityId,
          description: "Material issued to production",
        },
      ],
    });

    for (const a of result.allocations) {
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
          movementDate: input.issueDate,
          fromLocationId: input.locationId,
          referenceType: input.referenceType ?? "PRODUCTION_ORDER",
          referenceId: input.referenceId ?? input.productionOrderId ?? null,
          journalEntryId: journal.id,
        },
      });
    }

    await writeAudit(tx, {
      action: "INVENTORY_ISSUED",
      entityName: "Material",
      entityId: input.materialId,
      after: {
        quantity: result.totalQuantity.toString(),
        totalCost: result.totalCost.toString(),
        lotsConsumed: result.allocations.length,
        journalEntry: journal.entryNumber,
      },
      ctx,
    });

    return {
      totalCost: result.totalCost.toString(),
      allocations: result.allocations.map((a) => ({
        lotId: a.lotId, quantity: a.quantity.toString(), cost: a.cost.toString(),
      })),
      journalEntryNumber: journal.entryNumber,
    };
  });
}

/**
 * Receives finished garments from production.
 *
 *   DR finished goods    CR work in progress          (the material part)
 *                        CR conversion cost absorbed  (the conversion part)
 *
 * The two credits are separate because material and conversion enter
 * inventory by different routes. Material was issued into WIP and is now
 * leaving it. Conversion was never in WIP — it was incurred as a period
 * expense in the 61xx accounts and is absorbed here at the minute rate.
 *
 * Crediting WIP for the whole cost instead would drive WIP negative by
 * exactly the conversion absorbed, which is meaningless. Keeping them apart
 * also leaves the under-absorption visible in 6190: conversion incurred but
 * never absorbed is the cost of capacity that produced nothing.
 *
 * The unit cost comes from the production order's frozen cost snapshot, not a
 * recomputed one, so what enters stock is what the costing said it would be.
 */
export async function receiveFinishedGoods(
  input: {
    variantId: string;
    locationId: string;
    entityId: string;
    quantity: string;
    /**
     * Total frozen cost per garment — the authoritative figure the lot
     * carries, taken straight from the cost snapshot.
     */
    unitCost: string;
    /** The material portion of that total. Conversion is the remainder. */
    materialUnitCost: string;
    receivedDate: Date;
    productionOrderId?: string | null;
  },
  ctx: AuditContext,
): Promise<{ lotId: string; lotNumber: string; journalEntryNumber: string }> {
  const quantity = dec(input.quantity);
  const unitCost = dec(input.unitCost);
  const materialUnitCost = dec(input.materialUnitCost);
  // Derived rather than passed in, so material and conversion always sum to
  // exactly the snapshot total. Adding two separately-rounded figures can
  // differ from the stored sum in the last digit.
  const conversionUnitCost = unitCost.minus(materialUnitCost);

  if (quantity.lessThanOrEqualTo(0)) {
    throw new InventoryError("Output quantity must be greater than zero.");
  }
  if (unitCost.lessThan(0) || materialUnitCost.lessThan(0)) {
    throw new InventoryError("Unit costs cannot be negative.");
  }
  if (conversionUnitCost.lessThan(0)) {
    throw new InventoryError(
      "Material cost exceeds the total unit cost, which would make conversion negative.",
    );
  }

  return db.$transaction(async (tx) => {
    const lotNumber = await nextDocumentNumber(tx, "LOT", input.receivedDate);
    const totalCost = quantity.times(unitCost);
    const isBrand = await isBrandEntity(tx, input.entityId);

    const lot = await tx.inventoryLot.create({
      data: {
        lotNumber,
        state: "FINISHED_GOODS",
        variantId: input.variantId,
        locationId: input.locationId,
        entityId: input.entityId,
        productionOrderId: input.productionOrderId ?? null,
        originalQty: quantity.toString(),
        remainingQty: quantity.toString(),
        unitCost: unitCost.toString(),
        receivedDate: input.receivedDate,
      },
    });

    const journal = await postEntry(tx, {
      entityId: input.entityId,
      postingDate: input.receivedDate,
      sourceType: "PRODUCTION_OUTPUT",
      sourceId: input.productionOrderId ?? lot.id,
      memo: `Finished goods received ${lotNumber}`,
      ctx,
      lines: [
        {
          accountId: await accountId(tx, stateAccount("FINISHED_GOODS", isBrand)),
          debit: totalCost,
          entityId: input.entityId,
          variantId: input.variantId,
          description: `Production output ${lotNumber}`,
        },
        {
          accountId: await accountId(tx, ACC.WIP),
          credit: quantity.times(materialUnitCost),
          entityId: input.entityId,
          variantId: input.variantId,
          description: `Material released from WIP ${lotNumber}`,
        },
        {
          accountId: await accountId(tx, ACC.CONVERSION_ABSORBED),
          credit: quantity.times(conversionUnitCost),
          entityId: input.entityId,
          variantId: input.variantId,
          description: `Conversion absorbed at the minute rate ${lotNumber}`,
        },
      ].filter((l) => dec(l.debit ?? l.credit ?? 0).greaterThan(0)),
    });

    await tx.inventoryMovement.create({
      data: {
        lotId: lot.id,
        type: "PRODUCTION_OUTPUT",
        quantity: quantity.toString(),
        unitCost: unitCost.toString(),
        totalCost: totalCost.toString(),
        movementDate: input.receivedDate,
        toLocationId: input.locationId,
        referenceType: "PRODUCTION_ORDER",
        referenceId: input.productionOrderId ?? null,
        journalEntryId: journal.id,
      },
    });

    await writeAudit(tx, {
      action: "FINISHED_GOODS_RECEIVED",
      entityName: "InventoryLot",
      entityId: lot.id,
      after: {
        lotNumber, quantity: quantity.toString(), unitCost: unitCost.toString(),
        journalEntry: journal.entryNumber,
      },
      ctx,
    });

    return { lotId: lot.id, lotNumber, journalEntryNumber: journal.entryNumber };
  });
}

async function isBrandEntity(tx: Prisma.TransactionClient, entityId: string): Promise<boolean> {
  const e = await tx.entity.findUnique({ where: { id: entityId }, select: { kind: true } });
  return e?.kind === "BRAND";
}

/**
 * Relieves finished goods on a sale and books cost of goods sold.
 *
 *   DR cost of goods sold    CR finished goods
 *
 * Only the units actually sold are relieved. Everything still on the shelf
 * stays on the balance sheet at cost — which is what stops the system
 * reporting profit on garments nobody has bought.
 */
export async function relieveFinishedGoodsForSale(
  input: {
    variantId: string;
    locationId: string;
    entityId: string;
    quantity: string;
    saleDate: Date;
    cogsAccountCode?: string;
    customerId?: string | null;
    referenceType?: string;
    referenceId?: string;
  },
  ctx: AuditContext,
): Promise<{ cogs: string; journalEntryNumber: string }> {
  return db.$transaction(async (tx) => {
    const lots = await openLots(tx, {
      variantId: input.variantId,
      locationId: input.locationId,
      state: "FINISHED_GOODS",
    });

    const result = consumeFifo(lots, input.quantity);
    if (!result.ok) {
      throw new InventoryError(
        `Not enough finished goods: ${result.requested.toString()} requested, ${result.available.toString()} available.`,
      );
    }

    const isBrand = await isBrandEntity(tx, input.entityId);

    const journal = await postEntry(tx, {
      entityId: input.entityId,
      postingDate: input.saleDate,
      sourceType: "SALES_ORDER",
      sourceId: input.referenceId ?? null,
      memo: "Cost of goods sold",
      ctx,
      lines: [
        {
          accountId: await accountId(tx, input.cogsAccountCode ?? ACC.COGS_MATERIAL),
          debit: result.totalCost,
          entityId: input.entityId,
          variantId: input.variantId,
          customerId: input.customerId ?? null,
          description: "Cost of goods sold",
        },
        {
          accountId: await accountId(tx, stateAccount("FINISHED_GOODS", isBrand)),
          credit: result.totalCost,
          entityId: input.entityId,
          variantId: input.variantId,
          description: "Cost of goods sold",
        },
      ],
    });

    for (const a of result.allocations) {
      await tx.inventoryLot.update({
        where: { id: a.lotId },
        data: { remainingQty: { decrement: a.quantity.toString() } },
      });
      await tx.inventoryMovement.create({
        data: {
          lotId: a.lotId,
          type: "SALE",
          quantity: a.quantity.toString(),
          unitCost: a.unitCost.toString(),
          totalCost: a.cost.toString(),
          movementDate: input.saleDate,
          fromLocationId: input.locationId,
          referenceType: input.referenceType ?? "SALES_ORDER",
          referenceId: input.referenceId ?? null,
          journalEntryId: journal.id,
        },
      });
    }

    await writeAudit(tx, {
      action: "INVENTORY_SOLD",
      entityName: "Variant",
      entityId: input.variantId,
      after: {
        quantity: result.totalQuantity.toString(),
        cogs: result.totalCost.toString(),
        journalEntry: journal.entryNumber,
      },
      ctx,
    });

    return { cogs: result.totalCost.toString(), journalEntryNumber: journal.entryNumber };
  });
}

/**
 * Proves a lot's cached `remainingQty` still equals what its movements say.
 *
 * This is the check that catches silent stock drift, which is otherwise
 * invisible until a stock count months later.
 */
export async function reconcileLot(lotId: string): Promise<{
  ok: boolean;
  cached: string;
  fromMovements: string;
}> {
  const lot = await db.inventoryLot.findUniqueOrThrow({
    where: { id: lotId },
    include: { movements: true },
  });

  const inbound = new Set(["RECEIPT", "PRODUCTION_OUTPUT", "RETURN_IN"]);
  const fromMovements = lot.movements.reduce((acc, m) => {
    const q = dec(m.quantity);
    return inbound.has(m.type) ? acc.plus(q) : acc.minus(q);
  }, dec(0));

  const cached = dec(lot.remainingQty);
  return {
    ok: cached.equals(fromMovements),
    cached: cached.toString(),
    fromMovements: fromMovements.toString(),
  };
}
