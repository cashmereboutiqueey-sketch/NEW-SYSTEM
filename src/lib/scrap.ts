import "server-only";
import { z } from "zod";
import { db } from "./db";
import { dec, roundMoney, type Decimal } from "./money";
import { consumeFifo, type Lot } from "@/core/fifo";
import { postEntry, nextDocumentNumber } from "./ledger";
import { writeAudit, type AuditContext } from "./audit";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Offcuts, and what they cost.
 *
 * The chart of accounts has carried 5400 "Scrap and abnormal loss" since the
 * first migration and nothing ever posted to it. The scrap report existed and
 * read a table nothing wrote, so the screen could only ever say "no scrap has
 * been recorded" — which is not the same claim as "no scrap happened", and a
 * cutting room always produces some.
 *
 * Scrap is not free. The fabric was bought, landed and paid for; when it comes
 * off the table as offcuts it has to leave inventory at what it actually cost,
 * and the loss has to land somewhere a person will see it. Leaving it in stock
 * overstates the assets by exactly the amount of cloth that no longer exists.
 *
 * The disposition decides the accounting, and only one of the four is not a
 * loss:
 *
 *   DISCARDED           the whole book value is gone
 *   SOLD                cash comes back; the loss is the difference
 *   USED_FOR_SAMPLING   consumed for a real purpose, still not sellable goods
 *   RETURNED_TO_STOCK   the offcut is usable and never leaves — no loss at all
 */

export class ScrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScrapError";
  }
}

const ACC = {
  RAW: "1310",
  SCRAP_LOSS: "5400",
  CASH: "1110",
} as const;

const SCRAP_REF = "SCRAP";

async function accountId(tx: Prisma.TransactionClient, code: string): Promise<string> {
  const a = await tx.account.findUnique({ where: { code }, select: { id: true } });
  if (!a) throw new ScrapError(`Account ${code} is missing from the chart of accounts.`);
  return a.id;
}

export const DISPOSITIONS = [
  "DISCARDED",
  "SOLD",
  "USED_FOR_SAMPLING",
  "RETURNED_TO_STOCK",
] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/** The one disposition where the cloth stays in stock and nothing is lost. */
const KEEPS_STOCK: Disposition = "RETURNED_TO_STOCK";

const scrapSchema = z.object({
  materialId: z.string().min(1),
  locationId: z.string().min(1),
  entityId: z.string().min(1),
  productionOrderId: z.string().min(1).nullable().optional(),
  disposition: z.enum(DISPOSITIONS),
  quantity: z.coerce.number().positive("Scrap quantity must be greater than zero."),
  /** Only meaningful when the offcuts were sold. */
  salvageValue: z.coerce.number().min(0).default(0),
  scrapDate: z.coerce.date(),
  notes: z.string().trim().max(500).nullable().optional(),
});

export type RecordScrapInput = z.input<typeof scrapSchema>;

async function openLots(
  tx: Prisma.TransactionClient,
  materialId: string,
  locationId: string,
): Promise<Lot[]> {
  const lots = await tx.inventoryLot.findMany({
    where: { materialId, locationId, state: "RAW_MATERIAL", remainingQty: { gt: 0 } },
    orderBy: [{ receivedDate: "asc" }, { sequence: "asc" }],
    select: { id: true, receivedDate: true, sequence: true, remainingQty: true, unitCost: true },
  });
  return lots.map((l) => ({
    id: l.id,
    receivedDate: l.receivedDate,
    sequence: l.sequence,
    remainingQty: l.remainingQty.toString(),
    unitCost: l.unitCost.toString(),
  }));
}

/**
 * Record cloth that came off the table, and take it out of stock at cost.
 *
 * The book value is never typed in — it is whatever FIFO says the specific
 * metres actually cost, which is the only figure that reconciles against the
 * lots. A scrap loss somebody estimated is a number that makes the inventory
 * account disagree with the inventory.
 */
export async function recordScrap(input: RecordScrapInput, ctx: AuditContext) {
  const data = scrapSchema.parse(input);

  if (data.salvageValue > 0 && data.disposition !== "SOLD") {
    throw new ScrapError(
      "Only scrap that was sold can have a salvage value. Nothing came back for the rest.",
    );
  }

  return db.$transaction(async (tx) => {
    const material = await tx.material.findUnique({
      where: { id: data.materialId },
      select: { id: true, code: true, nameAr: true, nameEn: true },
    });
    if (!material) throw new ScrapError("Material not found.");

    // The offcut is usable and goes back on the shelf. Nothing left inventory,
    // so nothing is written off — the record exists to show the cutting room
    // recovered it rather than to move money.
    if (data.disposition === KEEPS_STOCK) {
      const record = await tx.scrapRecord.create({
        data: {
          materialId: data.materialId,
          productionOrderId: data.productionOrderId ?? null,
          disposition: data.disposition,
          quantity: data.quantity.toString(),
          bookValue: "0",
          salvageValue: "0",
          netLoss: "0",
          scrapDate: data.scrapDate,
          notes: data.notes ?? null,
        },
      });

      await writeAudit(tx, {
        action: "SCRAP_RECOVERED",
        entityName: "ScrapRecord",
        entityId: record.id,
        ctx,
        after: {
          material: material.code,
          quantity: data.quantity,
          disposition: data.disposition,
        },
      });

      return {
        scrapRecordId: record.id,
        bookValue: "0",
        salvageValue: "0",
        netLoss: "0",
        journalEntryNumber: null as string | null,
      };
    }

    const lots = await openLots(tx, data.materialId, data.locationId);
    const consumed = consumeFifo(lots, data.quantity);
    if (!consumed.ok) {
      // Refused rather than partly written off: scrapping cloth that is not
      // there would drive the inventory account negative and hide whichever
      // earlier issue was really wrong.
      throw new ScrapError(
        `Not enough ${material.code} in stock to scrap: ${consumed.requested.toString()} asked for, ` +
          `${consumed.available.toString()} on hand, short by ${consumed.shortfall.toString()}.`,
      );
    }

    const bookValue = roundMoney(consumed.totalCost);
    const salvage = roundMoney(dec(data.salvageValue));
    const netLoss = roundMoney(bookValue.minus(salvage));

    if (salvage.greaterThan(bookValue)) {
      // Selling offcuts for more than the cloth cost is not a scrap loss, it
      // is a sale, and booking it here would credit a COGS account with a
      // profit nobody could find later.
      throw new ScrapError(
        `Salvage of ${salvage.toString()} exceeds the book value of ${bookValue.toString()}. ` +
          "That is a sale, not a scrap recovery — record it as one.",
      );
    }

    const lines: Parameters<typeof postEntry>[1]["lines"] = [];
    if (salvage.greaterThan(0)) {
      lines.push({
        accountId: await accountId(tx, ACC.CASH),
        debit: salvage,
        entityId: data.entityId,
        description: `Scrap sold — ${material.code}`,
      });
    }
    if (netLoss.greaterThan(0)) {
      lines.push({
        accountId: await accountId(tx, ACC.SCRAP_LOSS),
        debit: netLoss,
        entityId: data.entityId,
        description: `Scrap ${data.disposition.toLowerCase()} — ${material.code}`,
      });
    }
    lines.push({
      accountId: await accountId(tx, ACC.RAW),
      credit: bookValue,
      entityId: data.entityId,
      description: `Cloth off the table — ${material.code}`,
    });

    const reference = await nextDocumentNumber(tx, "SCR", data.scrapDate);

    const journal = await postEntry(tx, {
      entityId: data.entityId,
      postingDate: data.scrapDate,
      sourceType: "MANUAL",
      sourceId: data.productionOrderId ?? null,
      memo: `Scrap ${reference} — ${material.nameEn}`,
      ctx,
      lines,
    });

    for (const a of consumed.allocations) {
      await tx.inventoryLot.update({
        where: { id: a.lotId },
        data: { remainingQty: { decrement: a.quantity.toString() } },
      });
      await tx.inventoryMovement.create({
        data: {
          lotId: a.lotId,
          type: "SCRAP",
          quantity: a.quantity.toString(),
          unitCost: a.unitCost.toString(),
          totalCost: a.cost.toString(),
          movementDate: data.scrapDate,
          fromLocationId: data.locationId,
          referenceType: SCRAP_REF,
          referenceId: reference,
          journalEntryId: journal.id,
        },
      });
    }

    const record = await tx.scrapRecord.create({
      data: {
        materialId: data.materialId,
        productionOrderId: data.productionOrderId ?? null,
        disposition: data.disposition,
        quantity: data.quantity.toString(),
        bookValue: bookValue.toString(),
        salvageValue: salvage.toString(),
        netLoss: netLoss.toString(),
        scrapDate: data.scrapDate,
        notes: data.notes ?? null,
      },
    });

    await writeAudit(tx, {
      action: "SCRAP_RECORDED",
      entityName: "ScrapRecord",
      entityId: record.id,
      ctx,
      after: {
        material: material.code,
        quantity: data.quantity,
        disposition: data.disposition,
        bookValue: bookValue.toString(),
        salvageValue: salvage.toString(),
        netLoss: netLoss.toString(),
        journal: journal.entryNumber,
      },
    });

    return {
      scrapRecordId: record.id,
      bookValue: bookValue.toString(),
      salvageValue: salvage.toString(),
      netLoss: netLoss.toString(),
      journalEntryNumber: journal.entryNumber as string | null,
    };
  });
}

/** Materials with stock on hand, for the form to pick from. */
export async function scrappableMaterials(entityId: string) {
  const lots = await db.inventoryLot.findMany({
    where: { entityId, state: "RAW_MATERIAL", remainingQty: { gt: 0 } },
    include: {
      material: { include: { uom: true } },
      location: true,
    },
    orderBy: [{ receivedDate: "asc" }],
  });

  const byMaterial = new Map<
    string,
    {
      materialId: string;
      locationId: string;
      code: string;
      nameAr: string;
      nameEn: string;
      uom: string;
      onHand: Decimal;
      value: Decimal;
      locationAr: string;
      locationEn: string;
    }
  >();

  for (const lot of lots) {
    if (!lot.material || !lot.locationId) continue;
    // Keyed by material *and* location: the same cloth in two places is two
    // different piles, and scrapping draws from one of them.
    const key = `${lot.materialId}:${lot.locationId}`;
    const at = byMaterial.get(key) ?? {
      materialId: lot.material.id,
      locationId: lot.locationId,
      code: lot.material.code,
      nameAr: lot.material.nameAr,
      nameEn: lot.material.nameEn,
      uom: lot.material.uom?.code ?? "",
      onHand: dec(0),
      value: dec(0),
      locationAr: lot.location?.nameAr ?? "",
      locationEn: lot.location?.nameEn ?? "",
    };
    at.onHand = at.onHand.plus(dec(lot.remainingQty));
    at.value = at.value.plus(dec(lot.remainingQty).times(dec(lot.unitCost)));
    byMaterial.set(key, at);
  }

  return [...byMaterial.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/** Runs still open, so scrap can be pinned to the job that produced it. */
export async function openRuns() {
  const orders = await db.productionOrder.findMany({
    where: { status: { in: ["CONFIRMED", "IN_PRODUCTION", "COMPLETED"] } },
    include: { style: { select: { nameAr: true, nameEn: true } } },
    orderBy: { orderDate: "desc" },
    take: 50,
  });

  return orders.map((o) => ({
    id: o.id,
    orderNumber: o.orderNumber,
    styleAr: o.style.nameAr,
    styleEn: o.style.nameEn,
    status: o.status,
  }));
}
