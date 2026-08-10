import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "./db";
import { postEntry } from "./ledger";
import { dec, type Decimal } from "./money";
import { writeAudit, type AuditContext } from "./audit";

/**
 * Counting the stock, and telling the truth about what is there.
 *
 * Every other movement in this system is a consequence of something — a
 * receipt, an issue, a sale. This one is the exception: it is somebody
 * standing in the warehouse saying the shelf holds twenty-eight and the books
 * say thirty. Without it, inventory drifts away from reality permanently and
 * every figure resting on it — cost of sales, the balance sheet, GMROI —
 * quietly becomes fiction.
 *
 * A shortfall is a real cost and posts as one:
 *
 *   short:  DR stock loss        CR inventory
 *   over:   DR inventory         CR stock loss
 *
 * An overage credits the same account rather than a gain, because finding two
 * garments you had written off is not income — it is an earlier count having
 * been wrong.
 */

export class StocktakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StocktakeError";
  }
}

const ACC = {
  RAW: "1310",
  WIP: "1320",
  FG_FACTORY: "1330",
  FG_BRAND: "1340",
  LOSS_FACTORY: "5400",
  LOSS_BRAND: "5450",
} as const;

async function accountId(tx: Prisma.TransactionClient, code: string): Promise<string> {
  const a = await tx.account.findUnique({ where: { code }, select: { id: true } });
  if (!a) throw new StocktakeError(`Account ${code} is missing from the chart of accounts.`);
  return a.id;
}

function stockAccount(state: string, isBrand: boolean): string {
  if (state === "RAW_MATERIAL") return ACC.RAW;
  if (state === "WIP") return ACC.WIP;
  return isBrand ? ACC.FG_BRAND : ACC.FG_FACTORY;
}

/** What the books say is on each shelf, ready to be counted against. */
export async function countSheet(locationId: string, entityId: string) {
  const lots = await db.inventoryLot.findMany({
    where: { locationId, entityId, remainingQty: { gt: 0 } },
    include: {
      material: { include: { uom: true } },
      variant: { include: { style: true, colorCode: true, sizeCode: true } },
    },
    orderBy: [{ state: "asc" }, { receivedDate: "asc" }],
  });

  return lots.map((lot) => ({
    lotId: lot.id,
    lotNumber: lot.lotNumber,
    state: lot.state,
    code: lot.variant?.sku ?? lot.material?.code ?? "—",
    nameEn: lot.variant
      ? `${lot.variant.style.nameEn} · ${lot.variant.colorCode.nameEn} · ${lot.variant.sizeCode.code}`
      : (lot.material?.nameEn ?? "—"),
    nameAr: lot.variant
      ? `${lot.variant.style.nameAr} · ${lot.variant.colorCode.nameAr} · ${lot.variant.sizeCode.code}`
      : (lot.material?.nameAr ?? "—"),
    uom: lot.material?.uom.code ?? (lot.variant ? "pcs" : ""),
    onBooks: dec(lot.remainingQty),
    unitCost: dec(lot.unitCost),
    value: dec(lot.remainingQty).times(dec(lot.unitCost)),
    receivedDate: lot.receivedDate,
  }));
}

/**
 * Records what was actually counted.
 *
 * `approverUserId` is required once the value of the discrepancy passes the
 * threshold, and must not be the person who counted it. Somebody who can both
 * count the stock and sign off the difference can make any quantity of it
 * disappear, one small adjustment at a time.
 */
export async function recordCount(
  input: {
    lotId: string;
    countedQty: string;
    reason: string;
    countDate: Date;
    approverUserId?: string | null;
  },
  ctx: AuditContext,
): Promise<{
  lotNumber: string;
  difference: string;
  value: string;
  direction: "SHORT" | "OVER" | "EXACT";
  journalEntryNumber: string | null;
}> {
  const counted = dec(input.countedQty);
  if (counted.lessThan(0)) throw new StocktakeError("A count cannot be negative.");
  if (!input.reason.trim()) {
    throw new StocktakeError("A difference needs a reason; an unexplained adjustment is a hole.");
  }

  const lot = await db.inventoryLot.findUnique({
    where: { id: input.lotId },
    include: { entity: true },
  });
  if (!lot) throw new StocktakeError("That lot no longer exists.");

  const onBooks = dec(lot.remainingQty);
  const difference = counted.minus(onBooks);
  const value = difference.abs().times(dec(lot.unitCost)).toDecimalPlaces(4);

  if (difference.isZero()) {
    // Still worth recording: a count that agreed is evidence the shelf was
    // looked at, which is the difference between a clean stocktake and one
    // nobody did.
    await db.$transaction(async (tx) => {
      await writeAudit(tx, {
        action: "STOCK_COUNTED",
        entityName: "InventoryLot",
        entityId: lot.id,
        after: { countedQty: counted.toString(), agreed: true, reason: input.reason },
        ctx,
      });
    });
    return {
      lotNumber: lot.lotNumber,
      difference: "0",
      value: "0",
      direction: "EXACT",
      journalEntryNumber: null,
    };
  }

  const threshold = await approvalThreshold();
  if (value.greaterThan(threshold)) {
    if (!input.approverUserId) {
      throw new StocktakeError(
        `A difference worth ${value.toFixed(2)} is over the ${threshold.toFixed(2)} limit and needs a second person to approve it.`,
      );
    }
    if (input.approverUserId === ctx.userId) {
      throw new StocktakeError(
        "The person who counted the stock cannot also approve the difference.",
      );
    }
  }

  const isBrand = lot.entity?.kind === "BRAND";
  const short = difference.lessThan(0);

  return db.$transaction(async (tx) => {
    const stock = await accountId(tx, stockAccount(lot.state, isBrand));
    const loss = await accountId(tx, isBrand ? ACC.LOSS_BRAND : ACC.LOSS_FACTORY);

    const journal = await postEntry(tx, {
      entityId: lot.entityId!,
      postingDate: input.countDate,
      sourceType: "ADJUSTMENT",
      sourceId: lot.lotNumber,
      memo: `Stock count ${lot.lotNumber}: ${input.reason}`,
      ctx,
      lines: short
        ? [
            {
              accountId: loss,
              debit: value,
              entityId: lot.entityId!,
              variantId: lot.variantId,
              description: `Short on count ${lot.lotNumber}`,
            },
            {
              accountId: stock,
              credit: value,
              entityId: lot.entityId!,
              variantId: lot.variantId,
              description: `Short on count ${lot.lotNumber}`,
            },
          ]
        : [
            {
              accountId: stock,
              debit: value,
              entityId: lot.entityId!,
              variantId: lot.variantId,
              description: `Over on count ${lot.lotNumber}`,
            },
            {
              // Credited back to the loss account, not to income: finding
              // stock means an earlier count was wrong, not that anything was
              // earned.
              accountId: loss,
              credit: value,
              entityId: lot.entityId!,
              variantId: lot.variantId,
              description: `Over on count ${lot.lotNumber}`,
            },
          ],
    });

    await tx.inventoryLot.update({
      where: { id: lot.id },
      data: { remainingQty: counted.toString() },
    });

    await tx.inventoryMovement.create({
      data: {
        lotId: lot.id,
        type: "ADJUSTMENT",
        quantity: difference.abs().toString(),
        unitCost: lot.unitCost.toString(),
        totalCost: value.toString(),
        movementDate: input.countDate,
        referenceType: "STOCK_COUNT",
        referenceId: lot.lotNumber,
        journalEntryId: journal.id,
        notes: input.reason,
      },
    });

    // Tagged garments that are no longer on the shelf are marked missing, so
    // the till refuses them rather than failing at checkout.
    if (short && lot.variantId) {
      const gone = await tx.garmentUnit.findMany({
        where: { lotId: lot.id, status: "IN_STOCK" },
        orderBy: { serial: "desc" },
        take: Number(difference.abs()),
        select: { id: true },
      });
      if (gone.length > 0) {
        await tx.garmentUnit.updateMany({
          where: { id: { in: gone.map((g) => g.id) } },
          data: {
            status: "LOST",
            lotId: null,
            locationId: null,
            writeOffNote: `Short on stock count: ${input.reason}`,
          },
        });
      }
    }

    await writeAudit(tx, {
      action: "STOCK_ADJUSTED",
      entityName: "InventoryLot",
      entityId: lot.id,
      before: { remainingQty: onBooks.toString() },
      after: {
        countedQty: counted.toString(),
        difference: difference.toString(),
        value: value.toString(),
        reason: input.reason,
        approvedBy: input.approverUserId ?? null,
      },
      ctx,
    });

    return {
      lotNumber: lot.lotNumber,
      difference: difference.toString(),
      value: value.toString(),
      direction: short ? ("SHORT" as const) : ("OVER" as const),
      journalEntryNumber: journal.entryNumber,
    };
  });
}

/** Above this value a difference needs a second person. */
export async function approvalThreshold(): Promise<Decimal> {
  const setting = await db.setting.findUnique({
    where: { key: "inventory.adjustmentApprovalLimit" },
  });
  return dec(setting?.value ?? "5000");
}

/** Adjustments already made, so a pattern in one place is visible. */
export async function recentAdjustments(limit = 50) {
  const movements = await db.inventoryMovement.findMany({
    where: { type: "ADJUSTMENT" },
    include: {
      lot: {
        include: {
          location: true,
          material: true,
          variant: { include: { style: true } },
        },
      },
    },
    orderBy: [{ movementDate: "desc" }, { createdAt: "desc" }],
    take: limit,
  });

  return movements.map((m) => ({
    id: m.id,
    date: m.movementDate,
    lotNumber: m.lot.lotNumber,
    code: m.lot.variant?.sku ?? m.lot.material?.code ?? "—",
    nameEn: m.lot.variant?.style.nameEn ?? m.lot.material?.nameEn ?? "—",
    nameAr: m.lot.variant?.style.nameAr ?? m.lot.material?.nameAr ?? "—",
    locationEn: m.lot.location?.nameEn ?? "—",
    locationAr: m.lot.location?.nameAr ?? "—",
    quantity: dec(m.quantity),
    value: dec(m.totalCost),
    reason: m.notes ?? "—",
  }));
}
