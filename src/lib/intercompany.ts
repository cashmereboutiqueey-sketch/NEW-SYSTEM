import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "./db";
import { postEntry, nextDocumentNumber } from "./ledger";
import { consumeFifo } from "@/core/fifo";
import { writeAudit, type AuditContext } from "./audit";
import { dec } from "./money";

/**
 * The Factory → Brand transfer.
 *
 * The Factory raises a real internal invoice and the Brand takes the goods
 * into stock at transfer price. Both sets of books stand alone; the group view
 * removes the internal sale afterwards rather than pretending it never
 * happened.
 *
 *   Factory   DR intercompany receivable   CR intercompany revenue
 *             DR cost of goods sold        CR finished goods
 *   Brand     DR finished goods            CR intercompany payable
 *
 * The margin inside the Brand's new lot is recorded on the lot itself, so
 * consolidation can eliminate exactly the profit still sitting in unsold
 * stock without re-deriving it from prices that may since have changed.
 */

export class IntercompanyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntercompanyError";
  }
}

const ACC = {
  IC_RECEIVABLE: "1250",
  IC_PAYABLE: "2150",
  IC_REVENUE: "4400",
  FG_FACTORY: "1330",
  FG_BRAND: "1340",
  COGS_FACTORY_MATERIAL: "5100",
} as const;

async function accountId(tx: Prisma.TransactionClient, code: string): Promise<string> {
  const a = await tx.account.findUnique({ where: { code }, select: { id: true } });
  if (!a) throw new IntercompanyError(`Account ${code} is missing from the chart of accounts.`);
  return a.id;
}

/**
 * Finished garments sitting at the factory that the Brand has not taken yet.
 *
 * The transfer price is not asked for. Each lot came out of a production
 * order, and that order froze a cost snapshot before the first garment was
 * cut; that snapshot is the price. Letting someone type a price here would let
 * the internal margin be set after the fact, which is exactly the thing a tax
 * inspector looks for.
 */
export async function awaitingTransfer(): Promise<
  {
    variantId: string;
    sku: string;
    styleCode: string;
    styleEn: string;
    styleAr: string;
    colourEn: string;
    colourAr: string;
    size: string;
    locationId: string;
    locationEn: string;
    locationAr: string;
    quantity: string;
    factoryCost: string;
    costSnapshotId: string | null;
    transferPrice: string | null;
    marginPerUnit: string | null;
    retailPrice: string | null;
    /** Why this line cannot be transferred, if it cannot. */
    blockedReason: "NO_SNAPSHOT" | null;
  }[]
> {
  const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });

  const lots = await db.inventoryLot.findMany({
    where: {
      entityId: factory.id,
      state: "FINISHED_GOODS",
      remainingQty: { gt: 0 },
      variantId: { not: null },
      locationId: { not: null },
    },
    include: {
      location: true,
      productionOrder: { include: { costSnapshot: true } },
      variant: {
        include: { style: true, colorCode: true, sizeCode: true },
      },
    },
    orderBy: [{ receivedDate: "asc" }, { sequence: "asc" }],
  });

  // Lots of the same SKU at the same place, priced off the same snapshot, are
  // one movement. Two runs costed differently stay apart, because merging them
  // would blur two different transfer prices into an average that matches
  // neither invoice.
  const groups = new Map<string, (typeof lots)[number][]>();
  for (const lot of lots) {
    const key = `${lot.variantId}|${lot.locationId}|${lot.productionOrder?.costSnapshotId ?? "none"}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(lot);
    else groups.set(key, [lot]);
  }

  const rows = [...groups.values()].map((bucket) => {
    const first = bucket[0];
    const v = first.variant!;
    const snapshot = first.productionOrder?.costSnapshot ?? null;

    const quantity = bucket.reduce((s, l) => s.plus(dec(l.remainingQty)), dec(0));
    const cost = bucket.reduce(
      (s, l) => s.plus(dec(l.remainingQty).times(dec(l.unitCost))),
      dec(0),
    );

    return {
      variantId: v.id,
      sku: v.sku,
      styleCode: v.style.code,
      styleEn: v.style.nameEn,
      styleAr: v.style.nameAr,
      colourEn: v.colorCode.nameEn,
      colourAr: v.colorCode.nameAr,
      size: v.sizeCode.code,
      locationId: first.locationId!,
      locationEn: first.location!.nameEn,
      locationAr: first.location!.nameAr,
      quantity: quantity.toString(),
      factoryCost: cost.toString(),
      costSnapshotId: snapshot?.id ?? null,
      transferPrice: snapshot ? dec(snapshot.transferPrice).toString() : null,
      marginPerUnit: snapshot
        ? dec(snapshot.transferPrice).minus(dec(snapshot.factoryTotalCost)).toString()
        : null,
      retailPrice: v.style.retailPrice?.toString() ?? null,
      blockedReason: snapshot ? null : ("NO_SNAPSHOT" as const),
    };
  });

  return rows.sort((a, b) => a.sku.localeCompare(b.sku));
}

/** Transfers already invoiced, newest first. */
export async function recentTransfers(limit = 25) {
  const movements = await db.inventoryMovement.findMany({
    where: { referenceType: "TRANSFER_INVOICE", type: "RECEIPT" },
    include: {
      lot: {
        include: {
          location: true,
          variant: { include: { style: true, colorCode: true, sizeCode: true } },
        },
      },
    },
    orderBy: [{ movementDate: "desc" }, { createdAt: "desc" }],
    take: limit,
  });

  return movements.map((m) => ({
    transferNumber: m.referenceId ?? "—",
    date: m.movementDate,
    sku: m.lot.variant?.sku ?? "—",
    styleEn: m.lot.variant?.style.nameEn ?? "—",
    styleAr: m.lot.variant?.style.nameAr ?? "—",
    toLocationEn: m.lot.location?.nameEn ?? "—",
    toLocationAr: m.lot.location?.nameAr ?? "—",
    quantity: m.quantity.toString(),
    transferPrice: m.unitCost.toString(),
    total: m.totalCost.toString(),
    // Still unsold means the group has not earned this margin yet.
    marginPerUnit: m.lot.transferMarginPerUnit?.toString() ?? null,
    unsoldQty: m.lot.remainingQty.toString(),
  }));
}

export async function transferToBrand(
  input: {
    variantId: string;
    quantity: string;
    fromLocationId: string;
    toLocationId: string;
    transferDate: Date;
    costSnapshotId: string;
  },
  ctx: AuditContext,
): Promise<{
  transferNumber: string;
  factoryCost: string;
  transferPrice: string;
  marginPerUnit: string;
  brandLotNumber: string;
}> {
  const quantity = dec(input.quantity);
  if (quantity.lessThanOrEqualTo(0)) {
    throw new IntercompanyError("Transfer quantity must be greater than zero.");
  }

  const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });
  const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });

  const snapshot = await db.costSnapshot.findUnique({ where: { id: input.costSnapshotId } });
  if (!snapshot) throw new IntercompanyError("Cost snapshot not found.");

  const transferUnitPrice = dec(snapshot.transferPrice);
  const marginPerUnit = transferUnitPrice.minus(dec(snapshot.factoryTotalCost));

  return db.$transaction(async (tx) => {
    // --- relieve factory stock, oldest first ---------------------------
    const lots = await tx.inventoryLot.findMany({
      where: {
        variantId: input.variantId,
        locationId: input.fromLocationId,
        entityId: factory.id,
        state: "FINISHED_GOODS",
        remainingQty: { gt: 0 },
      },
      orderBy: [{ receivedDate: "asc" }, { sequence: "asc" }],
    });

    const consumed = consumeFifo(
      lots.map((l) => ({
        id: l.id,
        receivedDate: l.receivedDate,
        sequence: l.sequence,
        remainingQty: l.remainingQty.toString(),
        unitCost: l.unitCost.toString(),
      })),
      quantity,
    );

    if (!consumed.ok) {
      throw new IntercompanyError(
        `The factory does not hold enough finished goods: ${consumed.requested.toString()} requested, ${consumed.available.toString()} available.`,
      );
    }

    const transferNumber = await nextDocumentNumber(tx, "TRF", input.transferDate);
    const factoryCost = consumed.totalCost;
    const transferTotal = transferUnitPrice.times(quantity);

    // --- factory books: an ordinary sale, to a related party ------------
    const factoryJournal = await postEntry(tx, {
      entityId: factory.id,
      postingDate: input.transferDate,
      sourceType: "TRANSFER_INVOICE",
      sourceId: transferNumber,
      memo: `Transfer to Brand ${transferNumber}`,
      ctx,
      lines: [
        {
          accountId: await accountId(tx, ACC.IC_RECEIVABLE),
          debit: transferTotal,
          entityId: factory.id,
          variantId: input.variantId,
          description: `Internal invoice ${transferNumber}`,
        },
        {
          accountId: await accountId(tx, ACC.IC_REVENUE),
          credit: transferTotal,
          entityId: factory.id,
          variantId: input.variantId,
          description: `Internal invoice ${transferNumber}`,
        },
        {
          accountId: await accountId(tx, ACC.COGS_FACTORY_MATERIAL),
          debit: factoryCost,
          entityId: factory.id,
          variantId: input.variantId,
          description: `Cost of goods transferred ${transferNumber}`,
        },
        {
          accountId: await accountId(tx, ACC.FG_FACTORY),
          credit: factoryCost,
          entityId: factory.id,
          variantId: input.variantId,
          description: `Cost of goods transferred ${transferNumber}`,
        },
      ],
    });

    for (const a of consumed.allocations) {
      await tx.inventoryLot.update({
        where: { id: a.lotId },
        data: { remainingQty: { decrement: a.quantity.toString() } },
      });
      await tx.inventoryMovement.create({
        data: {
          lotId: a.lotId,
          type: "TRANSFER",
          quantity: a.quantity.toString(),
          unitCost: a.unitCost.toString(),
          totalCost: a.cost.toString(),
          movementDate: input.transferDate,
          fromLocationId: input.fromLocationId,
          toLocationId: input.toLocationId,
          referenceType: "TRANSFER_INVOICE",
          referenceId: transferNumber,
          journalEntryId: factoryJournal.id,
        },
      });
    }

    // --- brand books: stock in at transfer price ------------------------
    const brandLotNumber = await nextDocumentNumber(tx, "LOT", input.transferDate);

    const brandJournal = await postEntry(tx, {
      entityId: brand.id,
      postingDate: input.transferDate,
      sourceType: "TRANSFER_INVOICE",
      sourceId: transferNumber,
      memo: `Goods received from Factory ${transferNumber}`,
      ctx,
      lines: [
        {
          accountId: await accountId(tx, ACC.FG_BRAND),
          debit: transferTotal,
          entityId: brand.id,
          variantId: input.variantId,
          description: `Stock received ${transferNumber}`,
        },
        {
          accountId: await accountId(tx, ACC.IC_PAYABLE),
          credit: transferTotal,
          entityId: brand.id,
          variantId: input.variantId,
          description: `Owed to the factory ${transferNumber}`,
        },
      ],
    });

    const brandLot = await tx.inventoryLot.create({
      data: {
        lotNumber: brandLotNumber,
        state: "FINISHED_GOODS",
        variantId: input.variantId,
        locationId: input.toLocationId,
        entityId: brand.id,
        originalQty: quantity.toString(),
        remainingQty: quantity.toString(),
        unitCost: transferUnitPrice.toString(),
        receivedDate: input.transferDate,
        // Recorded on the lot so consolidation eliminates exactly the profit
        // still held, even if prices change afterwards.
        transferMarginPerUnit: marginPerUnit.toString(),
        sourceCostSnapshotId: snapshot.id,
      },
    });

    await tx.inventoryMovement.create({
      data: {
        lotId: brandLot.id,
        type: "RECEIPT",
        quantity: quantity.toString(),
        unitCost: transferUnitPrice.toString(),
        totalCost: transferTotal.toString(),
        movementDate: input.transferDate,
        toLocationId: input.toLocationId,
        referenceType: "TRANSFER_INVOICE",
        referenceId: transferNumber,
        journalEntryId: brandJournal.id,
      },
    });

    await writeAudit(tx, {
      action: "INTERCOMPANY_TRANSFER",
      entityName: "InventoryLot",
      entityId: brandLot.id,
      after: {
        transferNumber,
        quantity: quantity.toString(),
        factoryCost: factoryCost.toString(),
        transferPrice: transferTotal.toString(),
        marginPerUnit: marginPerUnit.toString(),
        unrealisedIfUnsold: marginPerUnit.times(quantity).toString(),
      },
      ctx,
    });

    return {
      transferNumber,
      factoryCost: factoryCost.toString(),
      transferPrice: transferTotal.toString(),
      marginPerUnit: marginPerUnit.toString(),
      brandLotNumber,
    };
  });
}
