import "server-only";
import { z } from "zod";
import { db } from "./db";
import { writeAudit, type AuditContext } from "./audit";
import { buildSku, styleCodeSchema } from "@/core/sku";
import { dec } from "./money";

/**
 * Products: collections, styles, bills of materials, operations and variants.
 *
 * A style is the costing level, so the two things that decide what a garment
 * costs — its BOM and its operations — are edited here and nowhere else. SMV
 * is never typed in as a single number: it is the sum of the operations, so
 * the minute count can be argued with operation by operation.
 */

export class ProductError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductError";
  }
}

/**
 * Refuses a change to a style whose cost has already been frozen.
 *
 * Existing snapshots keep their own copy, so history is safe either way — but
 * silently changing the BOM under a confirmed production order means the
 * order is being made to a different specification than it was costed for.
 */
async function assertNotInProduction(styleId: string, what: string) {
  const orders = await db.productionOrder.count({
    where: { styleId, status: { in: ["CONFIRMED", "IN_PRODUCTION"] } },
  });
  if (orders > 0) {
    throw new ProductError(
      `This style has ${orders} production order(s) in progress. Changing its ${what} now would mean making garments to a different specification than they were costed for.`,
    );
  }
}

// -------------------------------------------------------------- collections

export const collectionSchema = z.object({
  code: z.string().min(2).max(24).transform((s) => s.trim().toUpperCase().replace(/\s+/g, "-")),
  nameEn: z.string().min(1, "An English name is required."),
  nameAr: z.string().min(1, "An Arabic name is required."),
  season: z.string().min(1, "A season is required."),
  year: z.coerce.number().int().min(2020).max(2100),
});

export async function createCollection(
  input: z.input<typeof collectionSchema>,
  ctx: AuditContext,
) {
  const data = collectionSchema.parse(input);
  const clash = await db.collection.findUnique({ where: { code: data.code } });
  if (clash) throw new ProductError(`Collection code ${data.code} is already in use.`);

  return db.$transaction(async (tx) => {
    const collection = await tx.collection.create({ data });
    await writeAudit(tx, {
      action: "COLLECTION_CREATED",
      entityName: "Collection",
      entityId: collection.id,
      after: { code: collection.code, season: collection.season, year: collection.year },
      ctx,
    });
    return collection;
  });
}

// ------------------------------------------------------------------- styles

export const styleSchema = z.object({
  code: styleCodeSchema,
  nameEn: z.string().min(1, "An English name is required."),
  nameAr: z.string().min(1, "An Arabic name is required."),
  collectionId: z.string().min(1, "Choose a collection."),
  /** Entered as a percentage, stored as a fraction. */
  plannedWasteRate: z.coerce.number().min(0).max(1).default(0),
  retailPrice: z.coerce.number().min(0).nullable().optional(),
  targetMarginPct: z.coerce.number().min(0).max(1).nullable().optional(),
});

export async function createStyle(input: z.input<typeof styleSchema>, ctx: AuditContext) {
  const data = styleSchema.parse(input);

  const clash = await db.style.findUnique({ where: { code: data.code } });
  if (clash) throw new ProductError(`Style code ${data.code} is already in use.`);

  return db.$transaction(async (tx) => {
    const style = await tx.style.create({
      data: {
        ...data,
        plannedWasteRate: dec(data.plannedWasteRate).toString(),
        retailPrice: data.retailPrice != null ? dec(data.retailPrice).toString() : null,
        targetMarginPct:
          data.targetMarginPct != null ? dec(data.targetMarginPct).toString() : null,
      },
    });
    await writeAudit(tx, {
      action: "STYLE_CREATED",
      entityName: "Style",
      entityId: style.id,
      after: { code: style.code, plannedWasteRate: style.plannedWasteRate.toString() },
      ctx,
    });
    return style;
  });
}

export async function updateStyle(
  input: z.input<typeof styleSchema> & { id: string },
  ctx: AuditContext,
) {
  const data = styleSchema.parse(input);

  return db.$transaction(async (tx) => {
    const before = await tx.style.findUnique({ where: { id: input.id } });
    if (!before) throw new ProductError("Style not found.");

    if (before.code !== data.code) {
      // The style code is the first segment of every SKU it owns.
      const variants = await tx.variant.count({ where: { styleId: input.id } });
      if (variants > 0) {
        throw new ProductError(
          "This style already has SKUs, so its code cannot be changed.",
        );
      }
    }

    const after = await tx.style.update({
      where: { id: input.id },
      data: {
        ...data,
        plannedWasteRate: dec(data.plannedWasteRate).toString(),
        retailPrice: data.retailPrice != null ? dec(data.retailPrice).toString() : null,
        targetMarginPct:
          data.targetMarginPct != null ? dec(data.targetMarginPct).toString() : null,
      },
    });

    await writeAudit(tx, {
      action: "STYLE_UPDATED",
      entityName: "Style",
      entityId: after.id,
      before: {
        code: before.code,
        plannedWasteRate: before.plannedWasteRate.toString(),
        retailPrice: before.retailPrice?.toString() ?? null,
      },
      after: {
        code: after.code,
        plannedWasteRate: after.plannedWasteRate.toString(),
        retailPrice: after.retailPrice?.toString() ?? null,
      },
      ctx,
    });
    return after;
  });
}

// -------------------------------------------------------------- bill of materials

export const bomLineSchema = z.object({
  styleId: z.string().min(1),
  materialId: z.string().min(1, "Choose a material."),
  standardConsumption: z.coerce.number().positive("Consumption must be greater than zero."),
  wasteRateOverride: z.coerce.number().min(0).max(1).nullable().optional(),
  notes: z.string().nullable().optional(),
});

export async function addBomLine(input: z.input<typeof bomLineSchema>, ctx: AuditContext) {
  const data = bomLineSchema.parse(input);
  await assertNotInProduction(data.styleId, "bill of materials");

  const existing = await db.styleBomLine.findUnique({
    where: { styleId_materialId: { styleId: data.styleId, materialId: data.materialId } },
  });
  if (existing) {
    throw new ProductError(
      "That material is already on this style's bill of materials. Edit the existing line instead of adding it twice.",
    );
  }

  return db.$transaction(async (tx) => {
    const count = await tx.styleBomLine.count({ where: { styleId: data.styleId } });
    const line = await tx.styleBomLine.create({
      data: {
        styleId: data.styleId,
        materialId: data.materialId,
        standardConsumption: dec(data.standardConsumption).toString(),
        wasteRateOverride:
          data.wasteRateOverride != null ? dec(data.wasteRateOverride).toString() : null,
        notes: data.notes ?? null,
        sortOrder: count,
      },
      include: { material: true },
    });

    await writeAudit(tx, {
      action: "BOM_LINE_ADDED",
      entityName: "Style",
      entityId: data.styleId,
      after: {
        material: line.material.code,
        standardConsumption: line.standardConsumption.toString(),
      },
      ctx,
    });
    return line;
  });
}

export async function removeBomLine(
  input: { id: string; styleId: string },
  ctx: AuditContext,
) {
  await assertNotInProduction(input.styleId, "bill of materials");

  return db.$transaction(async (tx) => {
    const line = await tx.styleBomLine.findUnique({
      where: { id: input.id },
      include: { material: true },
    });
    if (!line) throw new ProductError("Bill of materials line not found.");

    await tx.styleBomLine.delete({ where: { id: input.id } });
    await writeAudit(tx, {
      action: "BOM_LINE_REMOVED",
      entityName: "Style",
      entityId: input.styleId,
      before: {
        material: line.material.code,
        standardConsumption: line.standardConsumption.toString(),
      },
      ctx,
    });
  });
}

// --------------------------------------------------------------- operations

export const operationSchema = z.object({
  styleId: z.string().min(1),
  nameEn: z.string().min(1, "An English name is required."),
  nameAr: z.string().min(1, "An Arabic name is required."),
  smvMinutes: z.coerce.number().positive("Standard minutes must be greater than zero."),
  lineId: z.string().min(1).nullable().optional(),
  machineType: z.string().nullable().optional(),
});

/**
 * Adds an operation and refreshes the style's cached SMV.
 *
 * The cached total is only ever a sum of the rows — it is never typed in — so
 * the minute count on a garment can always be taken apart and argued with.
 */
export async function addOperation(
  input: z.input<typeof operationSchema>,
  ctx: AuditContext,
) {
  const data = operationSchema.parse(input);
  await assertNotInProduction(data.styleId, "operations");

  return db.$transaction(async (tx) => {
    const last = await tx.styleOperation.findFirst({
      where: { styleId: data.styleId },
      orderBy: { sequence: "desc" },
    });

    const operation = await tx.styleOperation.create({
      data: {
        styleId: data.styleId,
        sequence: (last?.sequence ?? 0) + 10,
        nameEn: data.nameEn,
        nameAr: data.nameAr,
        smvMinutes: dec(data.smvMinutes).toString(),
        lineId: data.lineId ?? null,
        machineType: data.machineType ?? null,
      },
    });

    const total = await tx.styleOperation.aggregate({
      where: { styleId: data.styleId },
      _sum: { smvMinutes: true },
    });
    await tx.style.update({
      where: { id: data.styleId },
      data: { totalSmvMinutes: total._sum.smvMinutes ?? "0" },
    });

    await writeAudit(tx, {
      action: "OPERATION_ADDED",
      entityName: "Style",
      entityId: data.styleId,
      after: {
        operation: operation.nameEn,
        smvMinutes: operation.smvMinutes.toString(),
        styleTotalSmv: (total._sum.smvMinutes ?? 0).toString(),
      },
      ctx,
    });
    return operation;
  });
}

export async function removeOperation(
  input: { id: string; styleId: string },
  ctx: AuditContext,
) {
  await assertNotInProduction(input.styleId, "operations");

  return db.$transaction(async (tx) => {
    const operation = await tx.styleOperation.findUnique({ where: { id: input.id } });
    if (!operation) throw new ProductError("Operation not found.");

    await tx.styleOperation.delete({ where: { id: input.id } });

    const total = await tx.styleOperation.aggregate({
      where: { styleId: input.styleId },
      _sum: { smvMinutes: true },
    });
    await tx.style.update({
      where: { id: input.styleId },
      data: { totalSmvMinutes: total._sum.smvMinutes ?? "0" },
    });

    await writeAudit(tx, {
      action: "OPERATION_REMOVED",
      entityName: "Style",
      entityId: input.styleId,
      before: { operation: operation.nameEn, smvMinutes: operation.smvMinutes.toString() },
      after: { styleTotalSmv: (total._sum.smvMinutes ?? 0).toString() },
      ctx,
    });
  });
}

// ----------------------------------------------------------------- variants

/**
 * Creates the SKUs for a style from the chosen colours and sizes.
 *
 * Combinations that already exist are skipped rather than failing the whole
 * batch, so adding one new colour to an existing style is a normal, repeatable
 * action instead of an error to work around.
 */
export async function generateVariants(
  input: { styleId: string; colorCodeIds: string[]; sizeCodeIds: string[] },
  ctx: AuditContext,
): Promise<{ created: number; skipped: number; skus: string[] }> {
  if (input.colorCodeIds.length === 0 || input.sizeCodeIds.length === 0) {
    throw new ProductError("Choose at least one colour and one size.");
  }

  const style = await db.style.findUnique({ where: { id: input.styleId } });
  if (!style) throw new ProductError("Style not found.");

  const [colours, sizes] = await Promise.all([
    db.colorCode.findMany({ where: { id: { in: input.colorCodeIds } } }),
    db.sizeCode.findMany({ where: { id: { in: input.sizeCodeIds } } }),
  ]);

  return db.$transaction(async (tx) => {
    const skus: string[] = [];
    let created = 0;
    let skipped = 0;

    for (const colour of colours) {
      for (const size of sizes) {
        const existing = await tx.variant.findUnique({
          where: {
            styleId_colorCodeId_sizeCodeId: {
              styleId: style.id,
              colorCodeId: colour.id,
              sizeCodeId: size.id,
            },
          },
        });
        if (existing) {
          skipped += 1;
          continue;
        }

        const sku = buildSku({
          styleCode: style.code,
          colorCode: colour.code,
          sizeCode: size.code,
        });

        await tx.variant.create({
          data: {
            styleId: style.id,
            colorCodeId: colour.id,
            sizeCodeId: size.id,
            sku,
            // The SKU doubles as the barcode until real barcodes are printed,
            // so the till can scan a garment the day it is made.
            barcode: sku,
          },
        });
        skus.push(sku);
        created += 1;
      }
    }

    await writeAudit(tx, {
      action: "VARIANTS_GENERATED",
      entityName: "Style",
      entityId: style.id,
      after: { created, skipped, colours: colours.length, sizes: sizes.length },
      ctx,
    });

    return { created, skipped, skus };
  });
}

/** Everything the costing screen needs to explain a style's cost. */
export async function styleDetail(styleId: string) {
  return db.style.findUnique({
    where: { id: styleId },
    include: {
      collection: true,
      bomLines: { include: { material: { include: { uom: true } } }, orderBy: { sortOrder: "asc" } },
      operations: { include: { line: true }, orderBy: { sequence: "asc" } },
      variants: {
        include: { colorCode: true, sizeCode: true },
        orderBy: { sku: "asc" },
      },
      _count: { select: { costSnapshots: true, productionOrders: true } },
    },
  });
}
