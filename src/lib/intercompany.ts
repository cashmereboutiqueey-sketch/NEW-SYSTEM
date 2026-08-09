import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "./db";
import { postEntry, nextDocumentNumber } from "./ledger";
import { consumeFifo } from "@/core/fifo";
import { writeAudit, type AuditContext } from "./audit";
import { markUnitsDespatched, settleUnitsOnIntake } from "./garment-units";
import { dec } from "./money";

/**
 * Moving garments from the Factory to the Brand.
 *
 * These are two companies, so stock crosses between them by invoice rather
 * than by being carried across the yard. It happens in two steps, for the same
 * reason a courier makes you sign for a parcel:
 *
 *   despatch — the factory sends the goods. They leave the warehouse but stay
 *              the factory's, sitting in transit. Nothing is invoiced yet, so
 *              nothing is claimed as sold.
 *   intake   — the shop counts what arrived and tags it. Only then is the
 *              internal invoice raised, and only for what was actually
 *              counted.
 *
 *   Factory   DR intercompany receivable   CR intercompany revenue
 *             DR cost of goods sold        CR finished goods
 *   Brand     DR finished goods            CR intercompany payable
 *
 * Anything despatched but not counted in is the factory's loss, charged to
 * abnormal loss at factory cost — the goods were in its hands until they
 * arrived. Invoicing on despatch instead would let the factory book revenue
 * for garments that never reached a shelf.
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
  ABNORMAL_LOSS: "5400",
} as const;

async function accountId(tx: Prisma.TransactionClient, code: string): Promise<string> {
  const a = await tx.account.findUnique({ where: { code }, select: { id: true } });
  if (!a) throw new IntercompanyError(`Account ${code} is missing from the chart of accounts.`);
  return a.id;
}

/** Where goods sit between leaving the factory and being counted in. */
async function transitLocation() {
  const location = await db.location.findUnique({ where: { code: "LOC-TRANSIT" } });
  if (!location) {
    throw new IntercompanyError(
      "The in-transit location is missing. Re-run the seed so despatched goods have somewhere to sit.",
    );
  }
  return location;
}

/* ────────────────────────────────────────────────────── despatch, at the factory */

/**
 * Finished garments at the factory that the Brand has not been sent yet.
 *
 * The transfer price is not asked for. Each lot came out of a production
 * order, and that order froze a cost snapshot before the first garment was
 * cut; that snapshot is the price. Letting someone type a price here would let
 * the internal margin be set after the fact, which is exactly the thing a tax
 * inspector looks for.
 */
export async function awaitingDespatch(): Promise<
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
    /** Why this line cannot be despatched, if it cannot. */
    blockedReason: "NO_SNAPSHOT" | null;
  }[]
> {
  const [factory, transit] = await Promise.all([
    db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } }),
    transitLocation(),
  ]);

  const lots = await db.inventoryLot.findMany({
    where: {
      entityId: factory.id,
      state: "FINISHED_GOODS",
      remainingQty: { gt: 0 },
      variantId: { not: null },
      locationId: { not: null, notIn: [transit.id] },
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

/**
 * Sends garments to the Brand.
 *
 * No journal: the goods are still the factory's, still finished goods, and
 * have only changed shelf. What this creates is the despatch note the shop
 * will count against.
 */
export async function despatchToBrand(
  input: {
    variantId: string;
    quantity: string;
    fromLocationId: string;
    despatchDate: Date;
    costSnapshotId: string;
    notes?: string | null;
  },
  ctx: AuditContext,
): Promise<{ despatchNumber: string; quantity: string; transferPrice: string }> {
  const quantity = dec(input.quantity);
  if (quantity.lessThanOrEqualTo(0)) {
    throw new IntercompanyError("Despatch quantity must be greater than zero.");
  }

  const [factory, transit, snapshot] = await Promise.all([
    db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } }),
    transitLocation(),
    db.costSnapshot.findUnique({ where: { id: input.costSnapshotId } }),
  ]);
  if (!snapshot) throw new IntercompanyError("Cost snapshot not found.");
  if (input.fromLocationId === transit.id) {
    throw new IntercompanyError("Goods already in transit cannot be despatched again.");
  }

  return db.$transaction(async (tx) => {
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

    const despatchNumber = await nextDocumentNumber(tx, "DSP", input.despatchDate);

    // One transit lot per source lot, so each keeps its own factory cost and
    // FIFO stays meaningful once the shop counts it in.
    for (const a of consumed.allocations) {
      await tx.inventoryLot.update({
        where: { id: a.lotId },
        data: { remainingQty: { decrement: a.quantity.toString() } },
      });

      const source = lots.find((l) => l.id === a.lotId)!;
      const transitLotNumber = await nextDocumentNumber(tx, "LOT", input.despatchDate);

      const transitLot = await tx.inventoryLot.create({
        data: {
          lotNumber: transitLotNumber,
          state: "FINISHED_GOODS",
          variantId: input.variantId,
          locationId: transit.id,
          entityId: factory.id,
          productionOrderId: source.productionOrderId,
          originalQty: a.quantity.toString(),
          remainingQty: a.quantity.toString(),
          unitCost: a.unitCost.toString(),
          receivedDate: input.despatchDate,
          sourceCostSnapshotId: snapshot.id,
        },
      });

      await tx.inventoryMovement.create({
        data: {
          lotId: transitLot.id,
          type: "TRANSFER",
          quantity: a.quantity.toString(),
          unitCost: a.unitCost.toString(),
          totalCost: a.cost.toString(),
          movementDate: input.despatchDate,
          fromLocationId: input.fromLocationId,
          toLocationId: transit.id,
          referenceType: "DESPATCH_NOTE",
          referenceId: despatchNumber,
          notes: input.notes ?? null,
          // Deliberately no journal: same account, same entity, same value.
        },
      });

      // The tagged garments travel with the stock they belong to.
      await markUnitsDespatched(tx, {
        variantId: input.variantId,
        quantity: Number(a.quantity),
        fromLocationId: input.fromLocationId,
        toLotId: transitLot.id,
        transitLocationId: transit.id,
      });
    }

    await writeAudit(tx, {
      action: "DESPATCHED_TO_BRAND",
      entityName: "InventoryLot",
      entityId: input.variantId,
      after: {
        despatchNumber,
        quantity: quantity.toString(),
        factoryCost: consumed.totalCost.toString(),
        transferPrice: snapshot.transferPrice.toString(),
      },
      ctx,
    });

    return {
      despatchNumber,
      quantity: quantity.toString(),
      transferPrice: snapshot.transferPrice.toString(),
    };
  });
}

/* ───────────────────────────────────────────────────────── intake, at the shop */

/** Goods on the road: sent by the factory, not yet counted in by the shop. */
export async function awaitingIntake(): Promise<
  {
    despatchNumber: string;
    despatchedOn: Date;
    variantId: string;
    sku: string;
    styleId: string;
    styleCode: string;
    styleEn: string;
    styleAr: string;
    colourEn: string;
    colourAr: string;
    size: string;
    /** How many the factory says it sent. */
    expectedQty: string;
    factoryCost: string;
    costSnapshotId: string | null;
    transferPrice: string | null;
    marginPerUnit: string | null;
    retailPrice: string | null;
    blockedReason: "NO_SNAPSHOT" | null;
  }[]
> {
  const [factory, transit] = await Promise.all([
    db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } }),
    transitLocation(),
  ]);

  const lots = await db.inventoryLot.findMany({
    where: {
      entityId: factory.id,
      locationId: transit.id,
      state: "FINISHED_GOODS",
      remainingQty: { gt: 0 },
      variantId: { not: null },
    },
    include: {
      sourceCostSnapshot: true,
      variant: { include: { style: true, colorCode: true, sizeCode: true } },
      movements: {
        where: { referenceType: "DESPATCH_NOTE" },
        orderBy: { createdAt: "asc" },
        take: 1,
      },
    },
    orderBy: [{ receivedDate: "asc" }, { sequence: "asc" }],
  });

  // One row per despatch note and SKU: that is the unit the shop counts.
  const groups = new Map<string, (typeof lots)[number][]>();
  for (const lot of lots) {
    const note = lot.movements[0]?.referenceId ?? "—";
    const key = `${note}|${lot.variantId}|${lot.sourceCostSnapshotId ?? "none"}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(lot);
    else groups.set(key, [lot]);
  }

  const rows = [...groups.values()].map((bucket) => {
    const first = bucket[0];
    const v = first.variant!;
    const snapshot = first.sourceCostSnapshot;

    const expected = bucket.reduce((s, l) => s.plus(dec(l.remainingQty)), dec(0));
    const cost = bucket.reduce(
      (s, l) => s.plus(dec(l.remainingQty).times(dec(l.unitCost))),
      dec(0),
    );

    return {
      despatchNumber: first.movements[0]?.referenceId ?? "—",
      despatchedOn: first.receivedDate,
      variantId: v.id,
      sku: v.sku,
      styleId: v.style.id,
      styleCode: v.style.code,
      styleEn: v.style.nameEn,
      styleAr: v.style.nameAr,
      colourEn: v.colorCode.nameEn,
      colourAr: v.colorCode.nameAr,
      size: v.sizeCode.code,
      expectedQty: expected.toString(),
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

  return rows.sort(
    (a, b) => a.despatchNumber.localeCompare(b.despatchNumber) || a.sku.localeCompare(b.sku),
  );
}

/**
 * The shop counts a despatch in, tags it, and takes it onto the floor.
 *
 * `countedQty` is what the shop actually found, not what the note claimed.
 * Anything missing is written off against the factory at factory cost: the
 * goods were the factory's until they arrived, so the brand is invoiced for
 * what it received and nothing more.
 */
export async function receiveAtBrand(
  input: {
    despatchNumber: string;
    variantId: string;
    /** What the shop counted. May be fewer than were sent, never more. */
    countedQty: string;
    toLocationId: string;
    receivedDate: Date;
    /** Set once the batch has been tagged; nothing reaches a shelf without it. */
    labelsPrinted: boolean;
    shortfallNote?: string | null;
  },
  ctx: AuditContext,
): Promise<{
  transferNumber: string;
  countedQty: string;
  shortfallQty: string;
  factoryCost: string;
  transferPrice: string;
  marginPerUnit: string;
  brandLotNumber: string;
  /** The tags that went on the floor, and the tags that never turned up. */
  receivedSerials: string[];
  lostSerials: string[];
}> {
  if (!input.labelsPrinted) {
    throw new IntercompanyError(
      "Print and apply the labels before taking this batch onto the floor — an untagged garment cannot be rung up or counted.",
    );
  }

  const counted = dec(input.countedQty);
  if (counted.lessThanOrEqualTo(0)) {
    throw new IntercompanyError("Counted quantity must be greater than zero.");
  }

  const [factory, brand, transit] = await Promise.all([
    db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } }),
    db.entity.findFirstOrThrow({ where: { kind: "BRAND" } }),
    transitLocation(),
  ]);

  const destination = await db.location.findUnique({ where: { id: input.toLocationId } });
  if (!destination || destination.entityId !== brand.id) {
    throw new IntercompanyError("Goods can only be received into one of the Brand's locations.");
  }

  return db.$transaction(async (tx) => {
    // The lots this despatch note put into transit for this SKU.
    const movements = await tx.inventoryMovement.findMany({
      where: { referenceType: "DESPATCH_NOTE", referenceId: input.despatchNumber },
      select: { lotId: true },
    });

    const lots = await tx.inventoryLot.findMany({
      where: {
        id: { in: movements.map((m) => m.lotId) },
        variantId: input.variantId,
        locationId: transit.id,
        entityId: factory.id,
        remainingQty: { gt: 0 },
      },
      include: { sourceCostSnapshot: true },
      orderBy: [{ receivedDate: "asc" }, { sequence: "asc" }],
    });

    if (lots.length === 0) {
      throw new IntercompanyError(
        `Nothing from ${input.despatchNumber} is still in transit for this SKU.`,
      );
    }

    const despatched = lots.reduce((s, l) => s.plus(dec(l.remainingQty)), dec(0));
    if (counted.greaterThan(despatched)) {
      throw new IntercompanyError(
        `The note says ${despatched.toString()} were sent but ${counted.toString()} were counted. More cannot arrive than left; check the count, or receive the rest against another note.`,
      );
    }

    const snapshot = lots[0].sourceCostSnapshot;
    if (!snapshot) {
      throw new IntercompanyError(
        "These garments carry no frozen cost, so there is no transfer price to invoice at.",
      );
    }

    const transferUnitPrice = dec(snapshot.transferPrice);
    const marginPerUnit = transferUnitPrice.minus(dec(snapshot.factoryTotalCost));
    const shortfall = despatched.minus(counted);

    // The whole despatch leaves transit: what was counted becomes brand stock,
    // what was not is gone. Leaving the shortfall in transit would show stock
    // that nobody can find.
    const consumed = consumeFifo(
      lots.map((l) => ({
        id: l.id,
        receivedDate: l.receivedDate,
        sequence: l.sequence,
        remainingQty: l.remainingQty.toString(),
        unitCost: l.unitCost.toString(),
      })),
      despatched,
    );
    if (!consumed.ok) {
      throw new IntercompanyError("The goods in transit changed while this was being received.");
    }

    // Factory cost splits by quantity across the same unit costs, so the part
    // written off and the part sold on always sum to what was despatched.
    const averageFactoryCost = consumed.totalCost.div(despatched);
    const soldCost = averageFactoryCost.times(counted).toDecimalPlaces(4);
    const lostCost = consumed.totalCost.minus(soldCost);

    const transferNumber = await nextDocumentNumber(tx, "TRF", input.receivedDate);
    const transferTotal = transferUnitPrice.times(counted);

    // --- factory books: a sale of what arrived, a loss on what did not ------
    const factoryLines = [
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
        debit: soldCost,
        entityId: factory.id,
        variantId: input.variantId,
        description: `Cost of goods transferred ${transferNumber}`,
      },
      {
        accountId: await accountId(tx, ACC.FG_FACTORY),
        credit: consumed.totalCost,
        entityId: factory.id,
        variantId: input.variantId,
        description: `Finished goods released ${transferNumber}`,
      },
    ];

    if (shortfall.greaterThan(0)) {
      factoryLines.push({
        accountId: await accountId(tx, ACC.ABNORMAL_LOSS),
        debit: lostCost,
        entityId: factory.id,
        variantId: input.variantId,
        description: `Short on delivery ${input.despatchNumber}: ${shortfall.toString()} garments`,
      });
    }

    const factoryJournal = await postEntry(tx, {
      entityId: factory.id,
      postingDate: input.receivedDate,
      sourceType: "TRANSFER_INVOICE",
      sourceId: transferNumber,
      memo: `Transfer to Brand ${transferNumber}`,
      ctx,
      lines: factoryLines,
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
          movementDate: input.receivedDate,
          fromLocationId: transit.id,
          toLocationId: input.toLocationId,
          referenceType: "TRANSFER_INVOICE",
          referenceId: transferNumber,
          journalEntryId: factoryJournal.id,
        },
      });
    }

    // --- brand books: stock in at transfer price, for what arrived ---------
    const brandLotNumber = await nextDocumentNumber(tx, "LOT", input.receivedDate);

    const brandJournal = await postEntry(tx, {
      entityId: brand.id,
      postingDate: input.receivedDate,
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
        originalQty: counted.toString(),
        remainingQty: counted.toString(),
        unitCost: transferUnitPrice.toString(),
        receivedDate: input.receivedDate,
        // Recorded on the lot so consolidation eliminates exactly the profit
        // still held, even if prices change afterwards.
        transferMarginPerUnit: marginPerUnit.toString(),
        sourceCostSnapshotId: snapshot.id,
        labelsPrintedAt: input.receivedDate,
      },
    });

    const settled = await settleUnitsOnIntake(tx, {
      variantId: input.variantId,
      transitLotIds: lots.map((l) => l.id),
      countedQty: Number(counted),
      brandLotId: brandLot.id,
      toLocationId: input.toLocationId,
      entityId: brand.id,
      receivedDate: input.receivedDate,
      shortfallNote: input.shortfallNote ?? null,
    });

    await tx.inventoryMovement.create({
      data: {
        lotId: brandLot.id,
        type: "RECEIPT",
        quantity: counted.toString(),
        unitCost: transferUnitPrice.toString(),
        totalCost: transferTotal.toString(),
        movementDate: input.receivedDate,
        toLocationId: input.toLocationId,
        referenceType: "TRANSFER_INVOICE",
        referenceId: transferNumber,
        journalEntryId: brandJournal.id,
      },
    });

    await writeAudit(tx, {
      action: "RECEIVED_FROM_FACTORY",
      entityName: "InventoryLot",
      entityId: brandLot.id,
      after: {
        despatchNumber: input.despatchNumber,
        transferNumber,
        despatchedQty: despatched.toString(),
        countedQty: counted.toString(),
        shortfallQty: shortfall.toString(),
        shortfallCost: shortfall.greaterThan(0) ? lostCost.toString() : null,
        shortfallNote: input.shortfallNote ?? null,
        // Named so a missing garment can be looked for by its tag rather than
        // being only a number in a variance column.
        lostSerials: settled.lost,
        transferPrice: transferTotal.toString(),
        marginPerUnit: marginPerUnit.toString(),
        unrealisedIfUnsold: marginPerUnit.times(counted).toString(),
      },
      ctx,
    });

    return {
      transferNumber,
      countedQty: counted.toString(),
      shortfallQty: shortfall.toString(),
      factoryCost: soldCost.toString(),
      transferPrice: transferTotal.toString(),
      marginPerUnit: marginPerUnit.toString(),
      brandLotNumber,
      receivedSerials: settled.received,
      lostSerials: settled.lost,
    };
  });
}

/**
 * Send a batch and count it all in, in one go.
 *
 * Convenience only, for a delivery that arrives complete and is tagged on the
 * spot — a van from the factory's own yard, say. Anything that travels far
 * enough to go missing should use the two steps, so the count is done against
 * a note rather than assumed.
 */
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
  despatchNumber: string;
  transferNumber: string;
  factoryCost: string;
  transferPrice: string;
  marginPerUnit: string;
  brandLotNumber: string;
}> {
  const despatch = await despatchToBrand(
    {
      variantId: input.variantId,
      quantity: input.quantity,
      fromLocationId: input.fromLocationId,
      despatchDate: input.transferDate,
      costSnapshotId: input.costSnapshotId,
    },
    ctx,
  );

  const received = await receiveAtBrand(
    {
      despatchNumber: despatch.despatchNumber,
      variantId: input.variantId,
      countedQty: input.quantity,
      toLocationId: input.toLocationId,
      receivedDate: input.transferDate,
      labelsPrinted: true,
    },
    ctx,
  );

  return {
    despatchNumber: despatch.despatchNumber,
    transferNumber: received.transferNumber,
    factoryCost: received.factoryCost,
    transferPrice: received.transferPrice,
    marginPerUnit: received.marginPerUnit,
    brandLotNumber: received.brandLotNumber,
  };
}

/* ─────────────────────────────────────────────────────────────────── history */

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
