import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "./db";
import { encodeSerial, decodeSerial, normaliseTypedSerial } from "@/core/serial";
import { writeAudit, type AuditContext } from "./audit";

/**
 * Individual garments.
 *
 * A lot is a costing bucket: so many pieces at so much each, consumed oldest
 * first. A unit is a physical object with a tag on it. Both are needed and
 * they are deliberately separate — the accounting runs entirely on lots, and
 * nothing here changes a figure in the ledger. What units add is the ability
 * to answer questions about a *particular* garment: was this one sold, did
 * this one come back, which three of the thirty-one never arrived.
 *
 * Units follow their lot rather than leading it. If the two ever disagree the
 * lot is right about money and the unit is right about where the garment is.
 */

export class GarmentUnitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GarmentUnitError";
  }
}

/**
 * Takes a block of serial ordinals from the database sequence.
 *
 * One statement for the whole run. Reading a counter and writing it back would
 * let two people closing runs at the same moment be handed the same numbers,
 * and the unique constraint would then fail the second one after it had
 * already done its work.
 */
async function nextOrdinals(
  tx: Prisma.TransactionClient,
  count: number,
): Promise<number[]> {
  if (count <= 0) return [];
  const rows = await tx.$queryRaw<{ ordinal: bigint }[]>`
    SELECT nextval('garment_unit_serial_seq') AS ordinal
    FROM generate_series(1, ${count})
  `;
  return rows.map((r) => Number(r.ordinal));
}

/**
 * Creates one unit per garment that came off the line.
 *
 * Called as a run is closed, because that is when the garments start existing.
 * Doing it later — at labelling, say — would mean a delivery that arrives
 * short could not say which pieces are missing, only how many.
 */
export async function mintUnitsForOutput(
  tx: Prisma.TransactionClient,
  input: {
    variantId: string;
    quantity: number;
    lotId: string;
    productionOrderId: string | null;
    entityId: string;
    locationId: string;
  },
): Promise<string[]> {
  if (input.quantity <= 0) return [];

  const ordinals = await nextOrdinals(tx, input.quantity);
  const serials = ordinals.map(encodeSerial);

  await tx.garmentUnit.createMany({
    data: serials.map((serial) => ({
      serial,
      variantId: input.variantId,
      productionOrderId: input.productionOrderId,
      lotId: input.lotId,
      status: "MADE" as const,
      entityId: input.entityId,
      locationId: input.locationId,
    })),
  });

  return serials;
}

/**
 * Marks units as sent, oldest first.
 *
 * Which physical garments went in the box is not recorded by anyone at this
 * point, so the oldest are taken. That matches how the stock itself is
 * relieved, and keeps unit and lot telling the same story.
 */
export async function markUnitsDespatched(
  tx: Prisma.TransactionClient,
  input: {
    variantId: string;
    quantity: number;
    fromLocationId: string;
    toLotId: string;
    transitLocationId: string;
  },
): Promise<number> {
  const units = await tx.garmentUnit.findMany({
    where: {
      variantId: input.variantId,
      locationId: input.fromLocationId,
      status: "MADE",
    },
    orderBy: { serial: "asc" },
    take: input.quantity,
    select: { id: true },
  });

  if (units.length === 0) return 0;

  await tx.garmentUnit.updateMany({
    where: { id: { in: units.map((u) => u.id) } },
    data: {
      status: "IN_TRANSIT",
      lotId: input.toLotId,
      locationId: input.transitLocationId,
    },
  });

  return units.length;
}

/**
 * Settles a delivery: what was counted goes on the floor, the rest is written
 * off.
 *
 * The units written off are chosen by serial order, not by anybody scanning
 * them. Nobody counted *which* garments arrived — only how many — so this is
 * a bookkeeping choice, and the audit record says so rather than implying a
 * precision that was never there. Scanning each piece in would make it exact;
 * that is a heavier job at the receiving bay and a separate decision.
 */
export async function settleUnitsOnIntake(
  tx: Prisma.TransactionClient,
  input: {
    variantId: string;
    transitLotIds: string[];
    countedQty: number;
    brandLotId: string;
    toLocationId: string;
    entityId: string;
    receivedDate: Date;
    shortfallNote: string | null;
  },
): Promise<{ received: string[]; lost: string[] }> {
  const units = await tx.garmentUnit.findMany({
    where: {
      variantId: input.variantId,
      lotId: { in: input.transitLotIds },
      status: "IN_TRANSIT",
    },
    orderBy: { serial: "asc" },
    select: { id: true, serial: true },
  });

  const received = units.slice(0, input.countedQty);
  const lost = units.slice(input.countedQty);

  if (received.length > 0) {
    await tx.garmentUnit.updateMany({
      where: { id: { in: received.map((u) => u.id) } },
      data: {
        status: "IN_STOCK",
        lotId: input.brandLotId,
        entityId: input.entityId,
        locationId: input.toLocationId,
        labelPrintedAt: input.receivedDate,
      },
    });
  }

  if (lost.length > 0) {
    await tx.garmentUnit.updateMany({
      where: { id: { in: lost.map((u) => u.id) } },
      data: {
        status: "LOST",
        lotId: null,
        locationId: null,
        writeOffNote:
          input.shortfallNote ??
          "Short on delivery. Identified by count, not by scanning each garment.",
      },
    });
  }

  return {
    received: received.map((u) => u.serial),
    lost: lost.map((u) => u.serial),
  };
}

/**
 * Marks garments sold.
 *
 * Serials the cashier actually scanned are used first, so the record names the
 * exact pieces that left the shop. The rest of the line falls back to oldest
 * first, which is what happens when someone taps a tile instead of scanning.
 */
export async function markUnitsSold(
  tx: Prisma.TransactionClient,
  input: {
    variantId: string;
    quantity: number;
    locationId: string;
    entityId: string;
    salesOrderLineId: string;
    soldAt: Date;
    scannedSerials?: string[];
  },
): Promise<string[]> {
  const scanned = (input.scannedSerials ?? [])
    .map(normaliseTypedSerial)
    .filter((s) => decodeSerial(s) !== null);

  const picked: { id: string; serial: string }[] = [];

  if (scanned.length > 0) {
    const matched = await tx.garmentUnit.findMany({
      where: {
        serial: { in: scanned },
        variantId: input.variantId,
        locationId: input.locationId,
        status: "IN_STOCK",
      },
      take: input.quantity,
      select: { id: true, serial: true },
    });
    picked.push(...matched);
  }

  if (picked.length < input.quantity) {
    const rest = await tx.garmentUnit.findMany({
      where: {
        variantId: input.variantId,
        locationId: input.locationId,
        entityId: input.entityId,
        status: "IN_STOCK",
        id: { notIn: picked.map((u) => u.id) },
      },
      orderBy: { serial: "asc" },
      take: input.quantity - picked.length,
      select: { id: true, serial: true },
    });
    picked.push(...rest);
  }

  if (picked.length === 0) return [];

  await tx.garmentUnit.updateMany({
    where: { id: { in: picked.map((u) => u.id) } },
    data: {
      status: "SOLD",
      salesOrderLineId: input.salesOrderLineId,
      soldAt: input.soldAt,
      lotId: null,
    },
  });

  return picked.map((u) => u.serial);
}

/* ──────────────────────────────────────────────────────────────── lookups */

export type ScannedUnit = {
  serial: string;
  variantId: string;
  sku: string;
  styleEn: string;
  styleAr: string;
  colourEn: string;
  colourAr: string;
  size: string;
  retailPrice: string | null;
  status: "MADE" | "IN_TRANSIT" | "IN_STOCK" | "SOLD" | "LOST" | "RETURNED";
  locationId: string | null;
  locationEn: string | null;
  locationAr: string | null;
  soldAt: Date | null;
};

/**
 * Resolves a scanned or typed tag.
 *
 * The check character is verified before the database is touched: a scanner
 * that misreads one bar produces a code that looks entirely ordinary, and
 * catching it here means the till says "bad scan" rather than silently finding
 * nothing and leaving the cashier to wonder.
 */
export async function findUnitBySerial(input: string): Promise<
  { ok: true; unit: ScannedUnit } | { ok: false; reason: "MALFORMED" | "UNKNOWN" }
> {
  const serial = normaliseTypedSerial(input);
  if (decodeSerial(serial) === null) return { ok: false, reason: "MALFORMED" };

  const unit = await db.garmentUnit.findUnique({
    where: { serial },
    include: {
      location: true,
      variant: { include: { style: true, colorCode: true, sizeCode: true } },
    },
  });
  if (!unit) return { ok: false, reason: "UNKNOWN" };

  return {
    ok: true,
    unit: {
      serial: unit.serial,
      variantId: unit.variantId,
      sku: unit.variant.sku,
      styleEn: unit.variant.style.nameEn,
      styleAr: unit.variant.style.nameAr,
      colourEn: unit.variant.colorCode.nameEn,
      colourAr: unit.variant.colorCode.nameAr,
      size: unit.variant.sizeCode.code,
      retailPrice: unit.variant.style.retailPrice?.toString() ?? null,
      status: unit.status,
      locationId: unit.locationId,
      locationEn: unit.location?.nameEn ?? null,
      locationAr: unit.location?.nameAr ?? null,
      soldAt: unit.soldAt,
    },
  };
}

/** The tags to print for one delivery, one label per garment. */
export async function unitsForDespatch(despatchNumber: string) {
  const movements = await db.inventoryMovement.findMany({
    where: { referenceType: "DESPATCH_NOTE", referenceId: despatchNumber },
    select: { lotId: true },
  });
  if (movements.length === 0) return [];

  return db.garmentUnit.findMany({
    where: { lotId: { in: movements.map((m) => m.lotId) } },
    include: { variant: { include: { style: true, colorCode: true, sizeCode: true } } },
    orderBy: { serial: "asc" },
  });
}

/** The tags to print for one production run. */
export async function unitsForProductionOrder(productionOrderId: string) {
  return db.garmentUnit.findMany({
    where: { productionOrderId },
    include: { variant: { include: { style: true, colorCode: true, sizeCode: true } } },
    orderBy: { serial: "asc" },
  });
}

/** Where every garment of a style currently is. */
export async function unitCountsByStatus(styleId: string) {
  const rows = await db.garmentUnit.groupBy({
    by: ["status"],
    where: { variant: { styleId } },
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((r) => [r.status, r._count._all])) as Partial<
    Record<ScannedUnit["status"], number>
  >;
}

/** Writes off a garment that cannot be found, without touching the ledger. */
export async function writeOffUnit(
  input: { serial: string; note: string },
  ctx: AuditContext,
): Promise<void> {
  const serial = normaliseTypedSerial(input.serial);
  const unit = await db.garmentUnit.findUnique({ where: { serial } });
  if (!unit) throw new GarmentUnitError(`No garment carries the code ${serial}.`);
  if (unit.status === "SOLD") {
    throw new GarmentUnitError(
      `${serial} was sold on ${unit.soldAt?.toISOString().slice(0, 10)}; it cannot be written off.`,
    );
  }

  await db.$transaction(async (tx) => {
    await tx.garmentUnit.update({
      where: { id: unit.id },
      data: { status: "LOST", lotId: null, locationId: null, writeOffNote: input.note },
    });
    await writeAudit(tx, {
      action: "GARMENT_UNIT_WRITTEN_OFF",
      entityName: "GarmentUnit",
      entityId: unit.id,
      before: { status: unit.status, lotId: unit.lotId },
      // The stock ledger is not touched here: this records that a tagged
      // garment is missing, and the lot it belonged to is adjusted through
      // the ordinary stock adjustment, which does post.
      after: { status: "LOST", note: input.note },
      ctx,
    });
  });
}
