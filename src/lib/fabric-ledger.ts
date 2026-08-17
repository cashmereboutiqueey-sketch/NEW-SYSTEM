import "server-only";
import { db } from "./db";
import { dec, safeDiv, type Decimal } from "./money";

/**
 * كشف القماش — what came in, what was drawn, and what is still on the shelf.
 *
 * The inventory screen answers "what do I have". It does not answer the
 * question a factory manager actually asks standing in the store, which is
 * "this roll — how much did I buy, how much have I pulled, and what is left".
 *
 * Every one of those three is already recorded. A lot carries `originalQty`
 * from the day it was received and `remainingQty` as it is drawn down, and
 * every movement against it says where the cloth went. Nothing here is
 * computed from an assumption; it is the same rows FIFO consumes, read the
 * other way round.
 *
 * Drawn is broken out by destination rather than left as one number, because
 * cloth issued to a run and cloth thrown away are the same subtraction and
 * completely different problems.
 */

export type FabricMovementSplit = {
  /** Issued against a production order — the cloth did its job. */
  toProduction: Decimal;
  /** Written off: offcuts, damage, samples. */
  scrapped: Decimal;
  /** Moved to another store. Still ours, just not here. */
  transferredOut: Decimal;
  /** Counted differently from the book. Positive means the count found more. */
  adjusted: Decimal;
};

export type FabricLine = {
  materialId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  type: string;
  uom: string;

  /** Everything ever received into this store, at the quantity received. */
  purchased: Decimal;
  /** Still on the shelf. */
  remaining: Decimal;
  /** purchased − remaining. What has left, however it left. */
  drawn: Decimal;
  movements: FabricMovementSplit;

  /** What the remaining cloth is worth at what it actually cost. */
  value: Decimal;
  /** Weighted average of what the remaining lots cost. */
  averageCost: Decimal | null;
  /** Share of what was bought that has been used. */
  usedPct: Decimal | null;

  deliveries: number;
  firstReceived: Date | null;
  lastReceived: Date | null;
  /** Days the oldest remaining lot has been standing. */
  oldestAgeDays: number | null;

  lots: {
    lotNumber: string;
    receivedDate: Date;
    originalQty: string;
    remainingQty: string;
    unitCost: string;
    value: string;
    locationAr: string | null;
    locationEn: string | null;
    supplierAr: string | null;
    supplierEn: string | null;
    ageDays: number;
  }[];
};

/**
 * Fabric that has not gone into production yet.
 *
 * Raw material only, and only what is still in stock or has been in stock:
 * work in progress and finished goods are cloth that already became something,
 * and counting them here would answer a different question.
 *
 * `includeFinished` keeps materials that are fully drawn down. Off by default
 * — the store manager wants the shelf — but the history is what shows how fast
 * a cloth actually moves.
 */
export async function fabricLedger(
  entityId: string,
  options: { includeFinished?: boolean; materialType?: "FABRIC" | "TRIM" | "ALL" } = {},
): Promise<FabricLine[]> {
  const type = options.materialType ?? "FABRIC";

  const lots = await db.inventoryLot.findMany({
    where: {
      entityId,
      state: "RAW_MATERIAL",
      materialId: { not: null },
      ...(type === "ALL" ? {} : { material: { type } }),
    },
    include: {
      material: { include: { uom: true } },
      location: { select: { nameAr: true, nameEn: true } },
      goodsReceiptLine: {
        select: {
          goodsReceipt: {
            select: {
              purchaseOrder: {
                select: { supplier: { select: { nameAr: true, nameEn: true } } },
              },
            },
          },
        },
      },
      movements: { select: { type: true, quantity: true } },
    },
    orderBy: [{ receivedDate: "asc" }, { sequence: "asc" }],
  });

  const today = Date.now();
  const byMaterial = new Map<string, FabricLine>();

  for (const lot of lots) {
    if (!lot.material) continue;

    const line =
      byMaterial.get(lot.material.id) ??
      ({
        materialId: lot.material.id,
        code: lot.material.code,
        nameAr: lot.material.nameAr,
        nameEn: lot.material.nameEn,
        type: lot.material.type,
        uom: lot.material.uom?.code ?? "",
        purchased: dec(0),
        remaining: dec(0),
        drawn: dec(0),
        movements: {
          toProduction: dec(0),
          scrapped: dec(0),
          transferredOut: dec(0),
          adjusted: dec(0),
        },
        value: dec(0),
        averageCost: null,
        usedPct: null,
        deliveries: 0,
        firstReceived: null,
        lastReceived: null,
        oldestAgeDays: null,
        lots: [],
      } satisfies FabricLine);

    const original = dec(lot.originalQty);
    const remaining = dec(lot.remainingQty);
    const value = remaining.times(dec(lot.unitCost));

    line.purchased = line.purchased.plus(original);
    line.remaining = line.remaining.plus(remaining);
    line.value = line.value.plus(value);
    line.deliveries += 1;

    if (!line.firstReceived || lot.receivedDate < line.firstReceived) {
      line.firstReceived = lot.receivedDate;
    }
    if (!line.lastReceived || lot.receivedDate > line.lastReceived) {
      line.lastReceived = lot.receivedDate;
    }

    // Where the cloth went, read off the movements rather than inferred from
    // the difference: the difference says how much left, not what happened.
    for (const movement of lot.movements) {
      const quantity = dec(movement.quantity);
      switch (movement.type) {
        case "ISSUE_TO_PRODUCTION":
          line.movements.toProduction = line.movements.toProduction.plus(quantity);
          break;
        case "SCRAP":
          line.movements.scrapped = line.movements.scrapped.plus(quantity);
          break;
        case "TRANSFER":
          line.movements.transferredOut = line.movements.transferredOut.plus(quantity);
          break;
        case "ADJUSTMENT":
          line.movements.adjusted = line.movements.adjusted.plus(quantity);
          break;
        default:
          // RECEIPT is the lot itself and is already counted as purchased.
          break;
      }
    }

    const ageDays = Math.max(
      0,
      Math.floor((today - lot.receivedDate.getTime()) / 86_400_000),
    );
    if (remaining.greaterThan(0)) {
      line.oldestAgeDays =
        line.oldestAgeDays === null ? ageDays : Math.max(line.oldestAgeDays, ageDays);
    }

    const supplier =
      lot.goodsReceiptLine?.goodsReceipt?.purchaseOrder?.supplier ?? null;

    line.lots.push({
      lotNumber: lot.lotNumber,
      receivedDate: lot.receivedDate,
      originalQty: original.toString(),
      remainingQty: remaining.toString(),
      unitCost: lot.unitCost.toString(),
      value: value.toString(),
      locationAr: lot.location?.nameAr ?? null,
      locationEn: lot.location?.nameEn ?? null,
      supplierAr: supplier?.nameAr ?? null,
      supplierEn: supplier?.nameEn ?? null,
      ageDays,
    });

    byMaterial.set(lot.material.id, line);
  }

  const rows = [...byMaterial.values()].map((line) => {
    line.drawn = line.purchased.minus(line.remaining);
    line.usedPct = safeDiv(line.drawn, line.purchased);
    // Weighted by what is left, not by what was bought: the average that
    // matters is the cost of the cloth still on the shelf.
    line.averageCost = line.remaining.greaterThan(0)
      ? line.value.div(line.remaining)
      : null;
    return line;
  });

  return rows
    .filter((r) => options.includeFinished || r.remaining.greaterThan(0))
    .sort((a, b) => Number(b.value.minus(a.value)));
}

/** The totals a store manager reads first. */
export function fabricTotals(rows: FabricLine[]) {
  const purchased = rows.reduce((t, r) => t.plus(r.purchased), dec(0));
  const remaining = rows.reduce((t, r) => t.plus(r.remaining), dec(0));
  const value = rows.reduce((t, r) => t.plus(r.value), dec(0));
  const scrapped = rows.reduce((t, r) => t.plus(r.movements.scrapped), dec(0));

  return {
    materials: rows.length,
    purchased,
    remaining,
    drawn: purchased.minus(remaining),
    value,
    scrapped,
    /** Share of everything bought that is still standing in the store. */
    stillOnShelf: safeDiv(remaining, purchased),
    /** Cloth standing over ninety days, which is where the cash is stuck. */
    standing: rows.filter((r) => (r.oldestAgeDays ?? 0) > 90).length,
  };
}
