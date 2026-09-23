import "server-only";
import { db } from "./db";
import { command } from "./command";
import { writeAudit, type AuditContext } from "./audit";
import { nextDocumentNumber, postEntry } from "./ledger";
import { dec, roundMoney, type Decimal } from "./money";
import { parseDelimited } from "@/core/attendance-import";
import {
  checkRow,
  costFor,
  isMaterial,
  type CountedRow,
  type CostBasis,
} from "@/core/opening-balance";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Loading what the business already had, on the day it starts keeping books.
 *
 * Everything here exists because the alternative — a script somebody ran once
 * — cannot answer the question that gets asked a year later: where did this
 * stock come from and who said it was worth that. So it is a batch with a
 * number, a date, a file name, a person, and every line it refused.
 *
 * Counted and priced first, posted second, and nothing written to the books in
 * between. The preview is where a wrong file is caught, because afterwards it
 * is a posted journal entry and putting that right is a reversal rather than a
 * correction.
 *
 *   DR raw materials / finished goods    CR opening balances
 *
 * Against equity rather than a supplier: the goods are the shop's already. If
 * some of them turn out to be unpaid for, that is a creditor to enter on its
 * own, not a reason to pretend this fabric arrived on an invoice.
 */

export class OpeningBalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpeningBalanceError";
  }
}

const ACC = {
  RAW: "1310",
  FG_FACTORY: "1330",
  FG_BRAND: "1340",
  OPENING: "3400",
} as const;

function asDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export type OpeningPreview = {
  batchId: string;
  number: string;
  totalLines: number;
  acceptedLines: number;
  refusedLines: number;
  totalValue: string;
  estimatedValue: string;
  /** How many lines rest on a guess, which is the figure to argue with. */
  estimatedLines: number;
  problems: { rowNumber: number; reason: string }[];
};

/** Reads the counted file into rows, whatever the operator's spreadsheet wrote. */
export function parseCountedFile(text: string): CountedRow[] {
  const table = parseDelimited(text);
  const lower = table.headers.map((h) => h.trim().toLowerCase().replace(/[\s_-]+/g, ""));
  const at = (...names: string[]) => {
    for (const n of names) {
      const i = lower.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };

  const kind = at("kind", "type", "نوع");
  const code = at("code", "sku", "كود");
  const location = at("location", "where", "مكان", "مخزن");
  const quantity = at("quantity", "qty", "كمية");
  const cost = at("unitcost", "cost", "تكلفة");

  return table.rows.map((cells, i) => ({
    rowNumber: i + 2,
    kind: kind >= 0 ? (cells[kind] ?? "") : "",
    code: code >= 0 ? (cells[code] ?? "") : "",
    location: location >= 0 ? (cells[location] ?? "") : "",
    quantity: quantity >= 0 ? (cells[quantity] ?? "") : "",
    unitCost: cost >= 0 ? (cells[cost] ?? "") : "",
  }));
}

/**
 * Counts and prices the file, and writes no stock.
 *
 * Every line is resolved against the real tables here rather than at posting,
 * so a code nobody recognises is a line on a screen instead of a failure half
 * way through a journal entry.
 */
export async function previewOpeningBalance(
  input: {
    entityId: string;
    asOfDate: Date;
    /** What fraction of a selling price is cost, where nothing better exists. */
    retailCostRatio?: string | null;
    filename?: string | null;
    notes?: string | null;
    rows: CountedRow[];
  },
  ctx: AuditContext,
): Promise<OpeningPreview> {
  return command("openingBalance.preview", { ...input, rows: input.rows.length }, ctx, async () => {
    const entity = await db.entity.findUnique({ where: { id: input.entityId } });
    if (!entity) throw new OpeningBalanceError("Choose which set of books this stock belongs to.");
    if (input.rows.length === 0) throw new OpeningBalanceError("That file has no rows.");

    const asOf = asDay(input.asOfDate);
    const ratio = input.retailCostRatio ? dec(input.retailCostRatio) : null;

    // Everything the rows might name, read once.
    const codes = input.rows.map((r) => r.code.trim()).filter(Boolean);
    const places = input.rows.map((r) => r.location.trim()).filter(Boolean);
    const [materials, variants, locations] = await Promise.all([
      db.material.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } }),
      db.variant.findMany({
        where: { sku: { in: codes } },
        select: {
          id: true,
          sku: true,
          styleId: true,
          style: { select: { retailPrice: true } },
        },
      }),
      db.location.findMany({
        where: { OR: [{ code: { in: places } }, { nameEn: { in: places } }, { nameAr: { in: places } }] },
        select: { id: true, code: true, nameEn: true, nameAr: true, entityId: true },
      }),
    ]);

    // The last costing anybody did for these styles, which beats a guess.
    const snapshots = await db.costSnapshot.findMany({
      where: { styleId: { in: variants.map((v) => v.styleId) } },
      select: { styleId: true, factoryTotalCost: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
    const bomCost = new Map<string, string>();
    for (const s of snapshots) {
      if (!bomCost.has(s.styleId)) bomCost.set(s.styleId, s.factoryTotalCost.toString());
    }

    const byMaterial = new Map(materials.map((m) => [m.code, m]));
    const byVariant = new Map(variants.map((v) => [v.sku, v]));
    const byPlace = new Map<string, (typeof locations)[number]>();
    for (const l of locations) {
      for (const key of [l.code, l.nameEn, l.nameAr]) byPlace.set(key, l);
    }

    type Accepted = {
      rowNumber: number;
      materialId: string | null;
      variantId: string | null;
      locationId: string;
      quantity: Decimal;
      unitCost: Decimal;
      costBasis: CostBasis;
      raw: CountedRow;
    };
    const accepted: Accepted[] = [];
    const refused: { rowNumber: number; reason: string; raw: CountedRow }[] = [];

    for (const row of input.rows) {
      const verdict = checkRow(row);
      if (verdict.kind === "invalid") {
        refused.push({ rowNumber: row.rowNumber, reason: verdict.reason, raw: row });
        continue;
      }

      const place = byPlace.get(row.location.trim());
      if (!place) {
        refused.push({ rowNumber: row.rowNumber, reason: `No location called "${row.location}".`, raw: row });
        continue;
      }
      if (place.entityId !== entity.id) {
        // One batch, one set of books. Mixing them would need two journal
        // entries under one number and nobody could read it back.
        refused.push({
          rowNumber: row.rowNumber,
          reason: `"${row.location}" does not belong to ${entity.nameEn}. Load its stock as its own batch.`,
          raw: row,
        });
        continue;
      }

      const material = isMaterial(row.kind) ? byMaterial.get(row.code.trim()) : undefined;
      const variant = isMaterial(row.kind) ? undefined : byVariant.get(row.code.trim());
      if (isMaterial(row.kind) && !material) {
        refused.push({ rowNumber: row.rowNumber, reason: `No material with the code "${row.code}".`, raw: row });
        continue;
      }
      if (!isMaterial(row.kind) && !variant) {
        refused.push({ rowNumber: row.rowNumber, reason: `No garment with the SKU "${row.code}".`, raw: row });
        continue;
      }

      const cost = costFor({
        statedCost: row.unitCost,
        // Fabric has no selling price and no bill: its cost is typed or it is
        // not known, and pretending otherwise would invent a number.
        bomCost: variant ? (bomCost.get(variant.styleId) ?? null) : null,
        retailPrice: variant?.style.retailPrice?.toString() ?? null,
        retailCostRatio: ratio?.toString() ?? null,
      });

      if (cost.refusal) {
        refused.push({ rowNumber: row.rowNumber, reason: cost.refusal, raw: row });
        continue;
      }

      accepted.push({
        rowNumber: row.rowNumber,
        materialId: material?.id ?? null,
        variantId: variant?.id ?? null,
        locationId: place.id,
        quantity: verdict.quantity,
        unitCost: cost.unitCost,
        costBasis: cost.basis,
        raw: row,
      });
    }

    const totalValue = accepted.reduce((s, a) => s.plus(a.unitCost.times(a.quantity)), dec(0));
    const estimated = accepted.filter((a) => a.costBasis === "ESTIMATED_FROM_RETAIL");
    const estimatedValue = estimated.reduce((s, a) => s.plus(a.unitCost.times(a.quantity)), dec(0));

    const number = await db.$transaction((tx) => nextDocumentNumber(tx, "OPEN", asOf));

    const batch = await db.openingBalanceBatch.create({
      data: {
        number,
        status: "PREVIEWED",
        asOfDate: asOf,
        entityId: entity.id,
        retailCostRatio: ratio ? ratio.toString() : null,
        filename: input.filename ?? null,
        notes: input.notes ?? null,
        totalLines: accepted.length,
        totalValue: roundMoney(totalValue).toString(),
        estimatedValue: roundMoney(estimatedValue).toString(),
        createdByUserId: ctx.userId ?? null,
        lines: {
          create: [
            ...accepted.map((a) => ({
              rowNumber: a.rowNumber,
              materialId: a.materialId,
              variantId: a.variantId,
              locationId: a.locationId,
              quantity: a.quantity.toString(),
              unitCost: a.unitCost.toString(),
              costBasis: a.costBasis,
              raw: a.raw as unknown as Prisma.InputJsonValue,
            })),
          ],
        },
      },
    });

    await db.$transaction(async (tx) => {
      await writeAudit(tx, {
        action: "OPENING_BALANCE_PREVIEWED",
        entityName: "OpeningBalanceBatch",
        entityId: batch.id,
        after: {
          number,
          asOf: asOf.toISOString().slice(0, 10),
          lines: accepted.length,
          refused: refused.length,
          value: roundMoney(totalValue).toString(),
          estimated: roundMoney(estimatedValue).toString(),
        },
        ctx,
      });
    });

    return {
      batchId: batch.id,
      number,
      totalLines: input.rows.length,
      acceptedLines: accepted.length,
      refusedLines: refused.length,
      totalValue: roundMoney(totalValue).toString(),
      estimatedValue: roundMoney(estimatedValue).toString(),
      estimatedLines: estimated.length,
      problems: refused.slice(0, 40).map((r) => ({ rowNumber: r.rowNumber, reason: r.reason })),
    };
  });
}

/**
 * Posts the batch: the lots come into existence and the books balance.
 *
 * One journal entry for the whole batch, because it is one event — the day the
 * books opened — and a hundred entries dated the same day would say nothing a
 * hundred lines on one entry does not.
 */
export async function commitOpeningBalance(
  input: { batchId: string },
  ctx: AuditContext,
): Promise<{ number: string; lots: number; value: string }> {
  return command("openingBalance.commit", input, ctx, async () => {
    const batch = await db.openingBalanceBatch.findUnique({
      where: { id: input.batchId },
      include: {
        entity: true,
        lines: { include: { location: true }, orderBy: { rowNumber: "asc" } },
      },
    });
    if (!batch) throw new OpeningBalanceError("That batch was not found.");
    if (batch.status === "COMMITTED") {
      throw new OpeningBalanceError(`${batch.number} has already been posted.`);
    }
    if (batch.status === "CANCELLED") {
      throw new OpeningBalanceError(`${batch.number} was cancelled. Start again.`);
    }
    if (batch.lines.length === 0) {
      throw new OpeningBalanceError("Nothing on this batch was accepted, so there is nothing to post.");
    }

    const isBrand = batch.entity.kind === "BRAND";

    return db.$transaction(async (tx) => {
      const [raw, fg, opening] = await Promise.all([
        tx.account.findUniqueOrThrow({ where: { code: ACC.RAW }, select: { id: true } }),
        tx.account.findUniqueOrThrow({
          where: { code: isBrand ? ACC.FG_BRAND : ACC.FG_FACTORY },
          select: { id: true },
        }),
        tx.account.findUniqueOrThrow({ where: { code: ACC.OPENING }, select: { id: true } }),
      ]);

      let rawValue = dec(0);
      let goodsValue = dec(0);
      let lots = 0;

      for (const line of batch.lines) {
        const value = roundMoney(dec(line.unitCost).times(dec(line.quantity)));
        const lotNumber = await nextDocumentNumber(tx, "LOT", batch.asOfDate);

        await tx.inventoryLot.create({
          data: {
            lotNumber,
            state: line.materialId ? "RAW_MATERIAL" : "FINISHED_GOODS",
            materialId: line.materialId,
            variantId: line.variantId,
            locationId: line.locationId,
            entityId: batch.entityId,
            openingBatchId: batch.id,
            originalQty: line.quantity.toString(),
            remainingQty: line.quantity.toString(),
            unitCost: line.unitCost.toString(),
            costEstimated: line.costBasis === "ESTIMATED_FROM_RETAIL",
            receivedDate: batch.asOfDate,
          },
        });
        lots += 1;

        if (line.materialId) rawValue = rawValue.plus(value);
        else goodsValue = goodsValue.plus(value);
      }

      const total = rawValue.plus(goodsValue);

      const entry = await postEntry(tx, {
        entityId: batch.entityId,
        postingDate: batch.asOfDate,
        sourceType: "ADJUSTMENT",
        sourceId: batch.id,
        memo: `${batch.number} — opening stock at ${batch.asOfDate.toISOString().slice(0, 10)}`,
        ctx,
        lines: [
          ...(rawValue.greaterThan(0)
            ? [{ accountId: raw.id, debit: rawValue, entityId: batch.entityId, description: "Opening raw material" }]
            : []),
          ...(goodsValue.greaterThan(0)
            ? [{ accountId: fg.id, debit: goodsValue, entityId: batch.entityId, description: "Opening finished goods" }]
            : []),
          {
            accountId: opening.id,
            credit: total,
            entityId: batch.entityId,
            description: `${batch.number} opening balance`,
          },
        ],
      });

      await tx.openingBalanceBatch.update({
        where: { id: batch.id },
        data: {
          status: "COMMITTED",
          committedAt: new Date(),
          journalEntryId: entry.id,
          totalValue: total.toString(),
        },
      });

      await writeAudit(tx, {
        action: "OPENING_BALANCE_POSTED",
        entityName: "OpeningBalanceBatch",
        entityId: batch.id,
        after: {
          number: batch.number,
          lots,
          raw: rawValue.toString(),
          goods: goodsValue.toString(),
          total: total.toString(),
        },
        ctx,
      });

      return { number: batch.number, lots, value: total.toString() };
    });
  });
}

/** What has been loaded so far, for the screen. */
export async function openingBatches(limit = 25) {
  const rows = await db.openingBalanceBatch.findMany({
    include: {
      entity: { select: { nameAr: true, nameEn: true } },
      createdBy: { select: { name: true } },
      _count: { select: { lines: true, lots: true } },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return rows.map((b) => ({
    id: b.id,
    number: b.number,
    status: b.status,
    asOfDate: b.asOfDate,
    entityAr: b.entity.nameAr,
    entityEn: b.entity.nameEn,
    filename: b.filename,
    lines: b._count.lines,
    lots: b._count.lots,
    totalValue: b.totalValue.toString(),
    estimatedValue: b.estimatedValue.toString(),
    by: b.createdBy?.name ?? null,
    committedAt: b.committedAt,
  }));
}

/** How much of what the books carry rests on a guess, for the screen to say so. */
export async function estimatedStockValue(): Promise<{ estimated: Decimal; total: Decimal }> {
  const [estimated, total] = await Promise.all([
    db.inventoryLot.findMany({
      where: { costEstimated: true, remainingQty: { gt: 0 } },
      select: { remainingQty: true, unitCost: true },
    }),
    db.inventoryLot.findMany({
      where: { remainingQty: { gt: 0 } },
      select: { remainingQty: true, unitCost: true },
    }),
  ]);
  const value = (rows: { remainingQty: Prisma.Decimal; unitCost: Prisma.Decimal }[]) =>
    rows.reduce((s, l) => s.plus(dec(l.remainingQty).times(dec(l.unitCost))), dec(0));

  return { estimated: value(estimated), total: value(total) };
}
