import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "./db";
import { postEntry, nextDocumentNumber } from "./ledger";
import { consumeFifo } from "@/core/fifo";
import { dec, type Decimal } from "./money";
import { writeAudit, type AuditContext } from "./audit";
import { approvalThreshold } from "./stocktake";

/**
 * Bazaars: stock goes out for a few days and has to come back.
 *
 * A three-day exhibition is the easiest way in this business to lose stock
 * without anybody stealing anything. Garments go into a van, some sell, some
 * come back, some are still in a box in somebody's boot a fortnight later, and
 * unless the two ends are reconciled the shortfall never surfaces — it just
 * becomes a slow, unexplained drift in the stock figures.
 *
 * So the whole module exists to hold one identity true:
 *
 *     sent = sold + returned + missing
 *
 * Nothing here posts a journal for the movement itself. A bazaar is the same
 * company and the same stock account as the showroom it came from, so sending
 * goods to it changes where they are, not what they are worth. Only two things
 * touch the ledger: the sales, which the till posts as it always does, and the
 * shortfall at close, which is a real loss and posts as one.
 *
 * The exhibition is modelled as a Location rather than as its own kind of
 * record on purpose. That way the till, stocktake, FIFO and every report treat
 * it as what it is — somewhere stock can be — instead of needing a special
 * case in each.
 */

export class ExhibitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExhibitionError";
  }
}

const ACC = {
  FG_BRAND: "1340",
  LOSS_BRAND: "5450",
} as const;

const SEND_REF = "EXHIBITION_SEND";
const RETURN_REF = "EXHIBITION_RETURN";
const LOSS_REF = "EXHIBITION_SHORTFALL";

async function accountId(tx: Prisma.TransactionClient, code: string): Promise<string> {
  const a = await tx.account.findUnique({ where: { code }, select: { id: true } });
  if (!a) throw new ExhibitionError(`Account ${code} is missing from the chart of accounts.`);
  return a.id;
}

/** Midnight, so date-only comparisons do not trip over the clock. */
function asDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ---------------------------------------------------------------- opening

export async function openExhibition(
  input: {
    nameAr: string;
    nameEn: string;
    city?: string | null;
    opensAt: Date;
    closesAt: Date;
    parentLocationId: string;
  },
  ctx: AuditContext,
): Promise<{ id: string; code: string }> {
  const opens = asDay(input.opensAt);
  const closes = asDay(input.closesAt);

  if (closes < opens) {
    throw new ExhibitionError("A bazaar cannot close before it opens.");
  }
  if (!input.nameAr.trim()) {
    throw new ExhibitionError("The bazaar needs a name.");
  }

  const parent = await db.location.findUnique({
    where: { id: input.parentLocationId },
  });
  if (!parent) throw new ExhibitionError("The source location does not exist.");
  if (!parent.isActive) {
    throw new ExhibitionError(`${parent.nameEn} is closed and cannot supply a bazaar.`);
  }
  if (parent.kind === "EXHIBITION") {
    // Otherwise the return path becomes a chain, and closing the first bazaar
    // would be blocked by the second one still holding its stock.
    throw new ExhibitionError("A bazaar cannot be stocked from another bazaar.");
  }
  if (parent.kind === "TRANSIT") {
    throw new ExhibitionError("Goods still in transit have not been counted in yet.");
  }

  return db.$transaction(async (tx) => {
    const code = await nextDocumentNumber(tx, "EXH", opens);

    const location = await tx.location.create({
      data: {
        code,
        nameAr: input.nameAr.trim(),
        nameEn: input.nameEn.trim() || input.nameAr.trim(),
        kind: "EXHIBITION",
        entityId: parent.entityId,
        city: input.city?.trim() || parent.city,
        isActive: true,
        opensAt: opens,
        closesAt: closes,
        parentLocationId: parent.id,
        // Below the permanent locations in every picker: a bazaar is the
        // exception, and should not sit above the showroom people use daily.
        sortOrder: 900,
      },
    });

    await writeAudit(tx, {
      action: "EXHIBITION_OPENED",
      entityName: "Location",
      entityId: location.id,
      after: {
        code,
        name: location.nameAr,
        from: parent.code,
        opensAt: opens.toISOString().slice(0, 10),
        closesAt: closes.toISOString().slice(0, 10),
      },
      ctx,
    });

    return { id: location.id, code };
  });
}

// ---------------------------------------------------------------- sending

/**
 * What the source location could send: tagged, unreserved, in stock.
 *
 * Untagged garments are deliberately excluded rather than merely flagged. A
 * garment with no barcode cannot be rung up at the bazaar and cannot be
 * counted back in afterwards, so sending one guarantees the reconciliation
 * will not close.
 */
export async function sendableStock(fromLocationId: string) {
  const lots = await db.inventoryLot.findMany({
    where: {
      locationId: fromLocationId,
      state: "FINISHED_GOODS",
      remainingQty: { gt: 0 },
      variantId: { not: null },
    },
    include: {
      variant: { include: { style: true, colorCode: true, sizeCode: true } },
    },
    orderBy: [{ receivedDate: "asc" }, { sequence: "asc" }],
  });

  const byVariant = new Map<string, {
    variantId: string;
    sku: string;
    styleName: string;
    size: string;
    colour: string;
    available: Decimal;
    untagged: Decimal;
    unitCost: Decimal;
  }>();

  for (const lot of lots) {
    if (!lot.variant) continue;
    const available = dec(lot.remainingQty).minus(dec(lot.reservedQty));
    if (available.lessThanOrEqualTo(0)) continue;

    const key = lot.variantId!;
    const row = byVariant.get(key) ?? {
      variantId: key,
      sku: lot.variant.sku,
      styleName: lot.variant.style?.nameAr ?? lot.variant.style?.nameEn ?? "",
      size: lot.variant.sizeCode?.code ?? "",
      colour: lot.variant.colorCode?.nameAr ?? lot.variant.colorCode?.code ?? "",
      available: dec(0),
      untagged: dec(0),
      unitCost: dec(lot.unitCost),
    };

    if (lot.labelsPrintedAt) row.available = row.available.plus(available);
    else row.untagged = row.untagged.plus(available);

    byVariant.set(key, row);
  }

  return [...byVariant.values()]
    .filter((r) => r.available.greaterThan(0) || r.untagged.greaterThan(0))
    .map((r) => ({
      ...r,
      available: r.available.toString(),
      untagged: r.untagged.toString(),
      unitCost: r.unitCost.toString(),
    }))
    .sort((a, b) => a.sku.localeCompare(b.sku));
}

export async function sendToExhibition(
  input: {
    exhibitionId: string;
    lines: { variantId: string; quantity: string }[];
    sendDate: Date;
    notes?: string | null;
  },
  ctx: AuditContext,
): Promise<{ despatchNumber: string; totalQty: string; totalCost: string }> {
  const exhibition = await db.location.findUnique({
    where: { id: input.exhibitionId },
    include: { parent: true },
  });
  if (!exhibition) throw new ExhibitionError("Bazaar not found.");
  if (exhibition.kind !== "EXHIBITION") {
    throw new ExhibitionError(`${exhibition.nameEn} is not a bazaar.`);
  }
  if (!exhibition.isActive) {
    throw new ExhibitionError("This bazaar has been closed and reconciled; nothing more can go to it.");
  }
  if (!exhibition.parent) {
    throw new ExhibitionError("This bazaar has no source location, so nothing can be sent or returned.");
  }

  const lines = input.lines.filter((l) => dec(l.quantity).greaterThan(0));
  if (lines.length === 0) throw new ExhibitionError("Nothing was selected to send.");

  const sendDate = asDay(input.sendDate);
  const parentId = exhibition.parent.id;

  return db.$transaction(async (tx) => {
    const despatchNumber = await nextDocumentNumber(tx, "EXS", sendDate);
    let totalQty = dec(0);
    let totalCost = dec(0);

    for (const line of lines) {
      const quantity = dec(line.quantity);

      const lots = await tx.inventoryLot.findMany({
        where: {
          variantId: line.variantId,
          locationId: parentId,
          state: "FINISHED_GOODS",
          remainingQty: { gt: 0 },
          // The tagging rule, enforced rather than advertised.
          labelsPrintedAt: { not: null },
        },
        orderBy: [{ receivedDate: "asc" }, { sequence: "asc" }],
      });

      const consumed = consumeFifo(
        lots.map((l) => ({
          id: l.id,
          receivedDate: l.receivedDate,
          sequence: l.sequence,
          // Reserved stock is spoken for by an order already placed; sending
          // it to a bazaar would sell the same garment twice.
          remainingQty: dec(l.remainingQty).minus(dec(l.reservedQty)).toString(),
          unitCost: l.unitCost.toString(),
        })),
        quantity,
      );

      if (!consumed.ok) {
        const variant = await tx.variant.findUnique({
          where: { id: line.variantId },
          select: { sku: true },
        });
        throw new ExhibitionError(
          `${exhibition.parent!.nameAr} does not hold enough tagged ${variant?.sku ?? "stock"}: ` +
            `${consumed.requested.toString()} asked for, ${consumed.available.toString()} available.`,
        );
      }

      for (const a of consumed.allocations) {
        const source = lots.find((l) => l.id === a.lotId)!;

        await tx.inventoryLot.update({
          where: { id: a.lotId },
          data: { remainingQty: { decrement: a.quantity.toString() } },
        });

        // One bazaar lot per source lot, so each keeps its own cost and FIFO
        // still means something when the goods come back.
        const lotNumber = await nextDocumentNumber(tx, "LOT", sendDate);
        const bazaarLot = await tx.inventoryLot.create({
          data: {
            lotNumber,
            state: "FINISHED_GOODS",
            variantId: line.variantId,
            locationId: exhibition.id,
            entityId: source.entityId,
            productionOrderId: source.productionOrderId,
            originalQty: a.quantity.toString(),
            remainingQty: a.quantity.toString(),
            unitCost: a.unitCost.toString(),
            receivedDate: source.receivedDate,
            // The goods were tagged before they left; they are still tagged.
            labelsPrintedAt: source.labelsPrintedAt,
            transferMarginPerUnit: source.transferMarginPerUnit,
            sourceCostSnapshotId: source.sourceCostSnapshotId,
          },
        });

        await tx.inventoryMovement.create({
          data: {
            lotId: bazaarLot.id,
            type: "TRANSFER",
            quantity: a.quantity.toString(),
            unitCost: a.unitCost.toString(),
            totalCost: a.cost.toString(),
            movementDate: sendDate,
            fromLocationId: parentId,
            toLocationId: exhibition.id,
            referenceType: SEND_REF,
            referenceId: exhibition.id,
            notes: input.notes ?? null,
            // No journal: same company, same stock account, same value. What
            // changed is where the goods are, not what they are worth.
          },
        });

        await moveUnits(tx, {
          variantId: line.variantId,
          quantity: Number(a.quantity),
          fromLocationId: parentId,
          toLocationId: exhibition.id,
          toLotId: bazaarLot.id,
        });

        totalQty = totalQty.plus(a.quantity);
        totalCost = totalCost.plus(a.cost);
      }
    }

    await writeAudit(tx, {
      action: "EXHIBITION_STOCK_SENT",
      entityName: "Location",
      entityId: exhibition.id,
      after: {
        despatchNumber,
        bazaar: exhibition.code,
        from: exhibition.parent!.code,
        quantity: totalQty.toString(),
        cost: totalCost.toString(),
      },
      ctx,
    });

    return {
      despatchNumber,
      totalQty: totalQty.toString(),
      totalCost: totalCost.toString(),
    };
  });
}

/**
 * The tagged garments travel with the stock they belong to.
 *
 * Serial-level tracking is what makes the count at the end an actual count
 * rather than an assertion: the person closing scans what is in front of them.
 */
async function moveUnits(
  tx: Prisma.TransactionClient,
  input: {
    variantId: string;
    quantity: number;
    fromLocationId: string;
    toLocationId: string;
    toLotId: string;
  },
): Promise<void> {
  const units = await tx.garmentUnit.findMany({
    where: {
      variantId: input.variantId,
      locationId: input.fromLocationId,
      status: "IN_STOCK",
    },
    orderBy: { createdAt: "asc" },
    take: input.quantity,
    select: { id: true },
  });

  if (units.length === 0) return;

  await tx.garmentUnit.updateMany({
    where: { id: { in: units.map((u) => u.id) } },
    data: { locationId: input.toLocationId, lotId: input.toLotId },
  });
}

// ------------------------------------------------------------- the picture

/**
 * Where a bazaar stands: what went out, what sold, what should still be there.
 *
 * `expected` is what the books say is on the stand right now. The person
 * closing counts against it, and any gap is the point of the whole exercise.
 */
export async function exhibitionPosition(exhibitionId: string) {
  const exhibition = await db.location.findUnique({
    where: { id: exhibitionId },
    include: { parent: true },
  });
  if (!exhibition) throw new ExhibitionError("Bazaar not found.");

  const [sent, lots, soldLines] = await Promise.all([
    db.inventoryMovement.findMany({
      where: { referenceType: SEND_REF, referenceId: exhibitionId },
      include: {
        lot: {
          include: {
            variant: { include: { style: true, colorCode: true, sizeCode: true } },
          },
        },
      },
    }),
    db.inventoryLot.findMany({
      where: { locationId: exhibitionId, remainingQty: { gt: 0 } },
      include: {
        variant: { include: { style: true, colorCode: true, sizeCode: true } },
      },
    }),
    db.salesOrderLine.findMany({
      where: { salesOrder: { locationId: exhibitionId, status: { not: "CANCELLED" } } },
      include: {
        variant: { include: { style: true, colorCode: true, sizeCode: true } },
      },
    }),
  ]);

  type Row = {
    variantId: string;
    sku: string;
    styleName: string;
    size: string;
    colour: string;
    sent: Decimal;
    sold: Decimal;
    expected: Decimal;
    unitCost: Decimal;
    revenue: Decimal;
  };
  const rows = new Map<string, Row>();

  type VariantShape = {
    sku: string;
    style?: { nameAr: string; nameEn: string } | null;
    colorCode?: { code: string; nameAr: string } | null;
    sizeCode?: { code: string } | null;
  };

  const touch = (
    variantId: string,
    v: VariantShape | null,
    unitCost?: Decimal,
  ): Row => {
    const existing = rows.get(variantId);
    if (existing) {
      if (unitCost && existing.unitCost.isZero()) existing.unitCost = unitCost;
      return existing;
    }
    const row: Row = {
      variantId,
      sku: v?.sku ?? "",
      styleName: v?.style?.nameAr ?? v?.style?.nameEn ?? "",
      size: v?.sizeCode?.code ?? "",
      colour: v?.colorCode?.nameAr ?? v?.colorCode?.code ?? "",
      sent: dec(0),
      sold: dec(0),
      expected: dec(0),
      unitCost: unitCost ?? dec(0),
      revenue: dec(0),
    };
    rows.set(variantId, row);
    return row;
  };

  for (const m of sent) {
    if (!m.lot.variantId) continue;
    const row = touch(m.lot.variantId, m.lot.variant, dec(m.unitCost));
    row.sent = row.sent.plus(dec(m.quantity));
  }

  for (const lot of lots) {
    if (!lot.variantId) continue;
    const row = touch(lot.variantId, lot.variant, dec(lot.unitCost));
    row.expected = row.expected.plus(dec(lot.remainingQty));
  }

  for (const line of soldLines) {
    const row = touch(line.variantId, line.variant);
    row.sold = row.sold.plus(dec(line.quantity));
    row.revenue = row.revenue.plus(dec(line.lineTotal));
  }

  const list = [...rows.values()].sort((a, b) => a.sku.localeCompare(b.sku));

  const totals = list.reduce(
    (acc, r) => ({
      sent: acc.sent.plus(r.sent),
      sold: acc.sold.plus(r.sold),
      expected: acc.expected.plus(r.expected),
      revenue: acc.revenue.plus(r.revenue),
      costOnStand: acc.costOnStand.plus(r.expected.times(r.unitCost)),
    }),
    { sent: dec(0), sold: dec(0), expected: dec(0), revenue: dec(0), costOnStand: dec(0) },
  );

  return {
    exhibition: {
      id: exhibition.id,
      code: exhibition.code,
      nameAr: exhibition.nameAr,
      nameEn: exhibition.nameEn,
      city: exhibition.city,
      opensAt: exhibition.opensAt,
      closesAt: exhibition.closesAt,
      isActive: exhibition.isActive,
      parentName: exhibition.parent?.nameAr ?? exhibition.parent?.nameEn ?? null,
      parentId: exhibition.parentLocationId,
    },
    lines: list.map((r) => ({
      variantId: r.variantId,
      sku: r.sku,
      styleName: r.styleName,
      size: r.size,
      colour: r.colour,
      sent: r.sent.toString(),
      sold: r.sold.toString(),
      expected: r.expected.toString(),
      unitCost: r.unitCost.toString(),
      revenue: r.revenue.toString(),
    })),
    totals: {
      sent: totals.sent.toString(),
      sold: totals.sold.toString(),
      expected: totals.expected.toString(),
      revenue: totals.revenue.toString(),
      costOnStand: totals.costOnStand.toString(),
    },
  };
}

export async function exhibitionList() {
  const locations = await db.location.findMany({
    where: { kind: "EXHIBITION" },
    include: { parent: true },
    orderBy: [{ isActive: "desc" }, { opensAt: "desc" }],
  });

  return Promise.all(
    locations.map(async (l) => {
      const [onStand, sales] = await Promise.all([
        db.inventoryLot.aggregate({
          where: { locationId: l.id, remainingQty: { gt: 0 } },
          _sum: { remainingQty: true },
        }),
        db.salesOrder.aggregate({
          where: { locationId: l.id, status: { not: "CANCELLED" } },
          _sum: { netAmount: true },
          _count: true,
        }),
      ]);

      return {
        id: l.id,
        code: l.code,
        nameAr: l.nameAr,
        nameEn: l.nameEn,
        city: l.city,
        opensAt: l.opensAt,
        closesAt: l.closesAt,
        isActive: l.isActive,
        parentName: l.parent?.nameAr ?? l.parent?.nameEn ?? null,
        onStand: dec(onStand._sum.remainingQty ?? 0).toString(),
        orderCount: sales._count,
        revenue: dec(sales._sum.netAmount ?? 0).toString(),
      };
    }),
  );
}

/** Where a bazaar can be stocked from: the permanent, active locations. */
export async function sourceLocations() {
  return db.location.findMany({
    where: {
      isActive: true,
      kind: { in: ["SHOWROOM", "STORE", "FACTORY_WAREHOUSE"] },
    },
    orderBy: { sortOrder: "asc" },
    select: { id: true, code: true, nameAr: true, nameEn: true, kind: true },
  });
}

// ---------------------------------------------------------------- closing

/**
 * Close the bazaar: count what is left, send it home, and own the difference.
 *
 * The count is the whole point, so it is required per line rather than
 * defaulted to what the books expect. A screen that pre-fills the expected
 * number and asks someone to confirm it will be confirmed without anybody
 * opening a box.
 */
export async function closeExhibition(
  input: {
    exhibitionId: string;
    closeDate: Date;
    counts: { variantId: string; countedQty: string }[];
    approvedByUserId?: string | null;
    notes?: string | null;
  },
  ctx: AuditContext,
): Promise<{
  returned: string;
  missing: string;
  overage: string;
  shortfallValue: string;
  journalEntryId: string | null;
}> {
  const exhibition = await db.location.findUnique({
    where: { id: input.exhibitionId },
    include: { parent: true },
  });
  if (!exhibition) throw new ExhibitionError("Bazaar not found.");
  if (exhibition.kind !== "EXHIBITION") {
    throw new ExhibitionError(`${exhibition.nameEn} is not a bazaar.`);
  }
  if (!exhibition.isActive) {
    throw new ExhibitionError("This bazaar has already been closed and reconciled.");
  }
  if (!exhibition.parent) {
    throw new ExhibitionError("This bazaar has no source location to return stock to.");
  }

  const openTill = await db.posSession.findFirst({
    where: { locationId: exhibition.id, closedAt: null },
  });
  if (openTill) {
    // Closing with a till still open would count stock that a sale in progress
    // is about to remove.
    throw new ExhibitionError(
      "There is still a till session open at this bazaar. Close the till first.",
    );
  }

  const closeDate = asDay(input.closeDate);
  const position = await exhibitionPosition(input.exhibitionId);
  const threshold = await approvalThreshold();

  const counted = new Map(
    input.counts.map((c) => [c.variantId, dec(c.countedQty)]),
  );

  // Anything on the stand that nobody counted is counted as zero — that is
  // what "it is not here" means. Silently skipping it would hide the loss.
  for (const line of position.lines) {
    if (dec(line.expected).greaterThan(0) && !counted.has(line.variantId)) {
      counted.set(line.variantId, dec(0));
    }
  }

  for (const [, qty] of counted) {
    if (qty.lessThan(0)) throw new ExhibitionError("A count cannot be negative.");
  }

  return db.$transaction(async (tx) => {
    const returnNumber = await nextDocumentNumber(tx, "EXR", closeDate);
    const parentId = exhibition.parent!.id;

    let returnedQty = dec(0);
    let missingQty = dec(0);
    let overageQty = dec(0);
    let shortfallValue = dec(0);
    let overageValue = dec(0);

    for (const [variantId, countedQty] of counted) {
      const lots = await tx.inventoryLot.findMany({
        where: {
          variantId,
          locationId: exhibition.id,
          remainingQty: { gt: 0 },
        },
        orderBy: [{ receivedDate: "asc" }, { sequence: "asc" }],
      });

      const expected = lots.reduce((s, l) => s.plus(dec(l.remainingQty)), dec(0));

      // Return what is actually there, oldest first, so the aging clock the
      // showroom sees is the real one rather than restarted by the trip.
      let toReturn = countedQty.greaterThan(expected) ? expected : countedQty;
      const shortage = expected.minus(toReturn);

      for (const lot of lots) {
        if (toReturn.lessThanOrEqualTo(0)) break;
        const take = dec(lot.remainingQty).greaterThan(toReturn)
          ? toReturn
          : dec(lot.remainingQty);

        await tx.inventoryLot.update({
          where: { id: lot.id },
          data: { remainingQty: { decrement: take.toString() } },
        });

        const lotNumber = await nextDocumentNumber(tx, "LOT", closeDate);
        const homeLot = await tx.inventoryLot.create({
          data: {
            lotNumber,
            state: "FINISHED_GOODS",
            variantId,
            locationId: parentId,
            entityId: lot.entityId,
            productionOrderId: lot.productionOrderId,
            originalQty: take.toString(),
            remainingQty: take.toString(),
            unitCost: lot.unitCost.toString(),
            receivedDate: lot.receivedDate,
            labelsPrintedAt: lot.labelsPrintedAt,
            transferMarginPerUnit: lot.transferMarginPerUnit,
            sourceCostSnapshotId: lot.sourceCostSnapshotId,
          },
        });

        await tx.inventoryMovement.create({
          data: {
            lotId: homeLot.id,
            type: "TRANSFER",
            quantity: take.toString(),
            unitCost: lot.unitCost.toString(),
            totalCost: take.times(dec(lot.unitCost)).toString(),
            movementDate: closeDate,
            fromLocationId: exhibition.id,
            toLocationId: parentId,
            referenceType: RETURN_REF,
            referenceId: exhibition.id,
            notes: input.notes ?? null,
          },
        });

        await moveUnits(tx, {
          variantId,
          quantity: Number(take),
          fromLocationId: exhibition.id,
          toLocationId: parentId,
          toLotId: homeLot.id,
        });

        returnedQty = returnedQty.plus(take);
        toReturn = toReturn.minus(take);
      }

      // Whatever is still on the books at the bazaar and was not counted is
      // gone. Write it off against the lots it belonged to, so the loss
      // carries the cost those particular garments actually had.
      if (shortage.greaterThan(0)) {
        let left = shortage;
        const stranded = await tx.inventoryLot.findMany({
          where: { variantId, locationId: exhibition.id, remainingQty: { gt: 0 } },
          orderBy: [{ receivedDate: "asc" }, { sequence: "asc" }],
        });

        for (const lot of stranded) {
          if (left.lessThanOrEqualTo(0)) break;
          const take = dec(lot.remainingQty).greaterThan(left) ? left : dec(lot.remainingQty);

          await tx.inventoryLot.update({
            where: { id: lot.id },
            data: { remainingQty: { decrement: take.toString() } },
          });

          await tx.inventoryMovement.create({
            data: {
              lotId: lot.id,
              type: "ADJUSTMENT",
              quantity: take.toString(),
              unitCost: lot.unitCost.toString(),
              totalCost: take.times(dec(lot.unitCost)).toString(),
              movementDate: closeDate,
              fromLocationId: exhibition.id,
              referenceType: LOSS_REF,
              referenceId: exhibition.id,
              notes: input.notes ?? null,
            },
          });

          shortfallValue = shortfallValue.plus(take.times(dec(lot.unitCost)));
          missingQty = missingQty.plus(take);
          left = left.minus(take);
        }

        // The garments that did not come back are named, not just counted.
        const lostUnits = await tx.garmentUnit.findMany({
          where: { locationId: exhibition.id, variantId, status: "IN_STOCK" },
          orderBy: { createdAt: "asc" },
          take: Number(shortage),
          select: { id: true },
        });
        if (lostUnits.length > 0) {
          await tx.garmentUnit.updateMany({
            where: { id: { in: lostUnits.map((u) => u.id) } },
            data: {
              status: "LOST",
              lotId: null,
              writeOffNote: `Did not come back from ${exhibition.code}`,
            },
          });
        }
      }

      if (countedQty.greaterThan(expected)) {
        // More on the stand than the books expect. Almost always a sale that
        // was not rung up, or an earlier count that was wrong. It is recorded
        // rather than quietly absorbed, but it does not create stock out of
        // nothing: it needs a stocktake to bring in properly.
        overageQty = overageQty.plus(countedQty.minus(expected));
        overageValue = overageValue.plus(
          countedQty.minus(expected).times(dec(position.lines.find((l) => l.variantId === variantId)?.unitCost ?? 0)),
        );
      }
    }

    // A large shortfall needs a second pair of eyes, on the same rule as any
    // other stock adjustment — and not the eyes of whoever ran the bazaar.
    if (shortfallValue.greaterThan(threshold)) {
      if (!input.approvedByUserId) {
        throw new ExhibitionError(
          `Missing stock is worth ${shortfallValue.toFixed(2)}, over the ${threshold.toFixed(2)} limit. ` +
            `Closing this bazaar needs an approver.`,
        );
      }
      if (input.approvedByUserId === ctx.userId) {
        throw new ExhibitionError("The person closing the bazaar cannot approve their own shortfall.");
      }
    }

    let journalEntryId: string | null = null;
    if (shortfallValue.greaterThan(0)) {
      const [loss, stock] = await Promise.all([
        accountId(tx, ACC.LOSS_BRAND),
        accountId(tx, ACC.FG_BRAND),
      ]);

      const entry = await postEntry(tx, {
        entityId: exhibition.entityId!,
        postingDate: closeDate,
        sourceType: "ADJUSTMENT",
        sourceId: exhibition.id,
        memo: `Stock that did not come back from ${exhibition.nameAr} (${exhibition.code})`,
        lines: [
          { accountId: loss, entityId: exhibition.entityId!, debit: shortfallValue.toString(), credit: "0" },
          { accountId: stock, entityId: exhibition.entityId!, debit: "0", credit: shortfallValue.toString() },
        ],
        ctx,
      });
      journalEntryId = entry.id;
    }

    await tx.location.update({
      where: { id: exhibition.id },
      data: { isActive: false, closesAt: closeDate },
    });

    await writeAudit(tx, {
      action: "EXHIBITION_CLOSED",
      entityName: "Location",
      entityId: exhibition.id,
      after: {
        returnNumber,
        bazaar: exhibition.code,
        returnedTo: exhibition.parent!.code,
        sent: position.totals.sent,
        sold: position.totals.sold,
        returned: returnedQty.toString(),
        missing: missingQty.toString(),
        overage: overageQty.toString(),
        shortfallValue: shortfallValue.toString(),
        approvedBy: input.approvedByUserId ?? null,
      },
      ctx,
    });

    return {
      returned: returnedQty.toString(),
      missing: missingQty.toString(),
      overage: overageQty.toString(),
      shortfallValue: shortfallValue.toString(),
      journalEntryId,
    };
  });
}
