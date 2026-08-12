import "server-only";
import { z } from "zod";
import { db } from "./db";
import { writeAudit, type AuditContext } from "./audit";
import { normalisePhone, normaliseEmail } from "@/core/crm";
import { dec } from "./money";

/**
 * Master data entry.
 *
 * Codes are the one field that cannot be corrected casually: a material code
 * appears inside every historical BOM line and cost snapshot, so it is
 * required, normalised and unique, and never rewritten once transactions
 * reference it.
 */

export class MasterDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MasterDataError";
  }
}

/** Uppercase, no spaces — codes end up printed on labels and documents. */
const codeField = z
  .string()
  .min(2, "A code needs at least two characters.")
  .max(32)
  .transform((s) => s.trim().toUpperCase().replace(/\s+/g, "-"));

const bilingual = {
  nameEn: z.string().min(1, "An English name is required."),
  nameAr: z.string().min(1, "An Arabic name is required."),
};

// ---------------------------------------------------------------- suppliers

export const supplierSchema = z.object({
  code: codeField,
  ...bilingual,
  contactPerson: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  creditDays: z.coerce.number().int().min(0).max(365).default(0),
  notes: z.string().nullable().optional(),
});

export type SupplierInput = z.input<typeof supplierSchema>;

export async function createSupplier(input: SupplierInput, ctx: AuditContext) {
  const data = supplierSchema.parse(input);

  const clash = await db.supplier.findUnique({ where: { code: data.code } });
  if (clash) throw new MasterDataError(`Supplier code ${data.code} is already in use.`);

  return db.$transaction(async (tx) => {
    const supplier = await tx.supplier.create({ data });
    await writeAudit(tx, {
      action: "SUPPLIER_CREATED",
      entityName: "Supplier",
      entityId: supplier.id,
      after: { code: supplier.code, nameEn: supplier.nameEn, creditDays: supplier.creditDays },
      ctx,
    });
    return supplier;
  });
}

export async function updateSupplier(
  input: SupplierInput & { id: string },
  ctx: AuditContext,
) {
  const data = supplierSchema.parse(input);

  return db.$transaction(async (tx) => {
    const before = await tx.supplier.findUnique({ where: { id: input.id } });
    if (!before) throw new MasterDataError("Supplier not found.");

    if (before.code !== data.code) {
      // The code is stamped into purchase orders and price history; changing
      // it would orphan the trail those documents point at.
      const used = await tx.purchaseOrder.count({ where: { supplierId: input.id } });
      if (used > 0) {
        throw new MasterDataError(
          "This supplier already has purchase orders, so its code cannot be changed.",
        );
      }
    }

    const after = await tx.supplier.update({ where: { id: input.id }, data });
    await writeAudit(tx, {
      action: "SUPPLIER_UPDATED",
      entityName: "Supplier",
      entityId: after.id,
      before: { code: before.code, nameEn: before.nameEn, creditDays: before.creditDays },
      after: { code: after.code, nameEn: after.nameEn, creditDays: after.creditDays },
      ctx,
    });
    return after;
  });
}

/**
 * Deactivates rather than deletes.
 *
 * A supplier with history cannot be removed without taking its purchase
 * orders and price history with it, so the record stays and stops being
 * offered for new documents.
 */
export async function setSupplierActive(
  input: { id: string; isActive: boolean },
  ctx: AuditContext,
) {
  return db.$transaction(async (tx) => {
    const after = await tx.supplier.update({
      where: { id: input.id },
      data: { isActive: input.isActive },
    });
    await writeAudit(tx, {
      action: input.isActive ? "SUPPLIER_REACTIVATED" : "SUPPLIER_DEACTIVATED",
      entityName: "Supplier",
      entityId: after.id,
      after: { code: after.code, isActive: after.isActive },
      ctx,
    });
    return after;
  });
}

// ---------------------------------------------------------------- materials

export const materialSchema = z.object({
  code: codeField,
  ...bilingual,
  type: z.enum(["FABRIC", "TRIM", "PACKAGING", "CONSUMABLE"]),
  uomId: z.string().min(1, "Choose a unit of measure."),
  supplierId: z.string().min(1).nullable().optional(),
  basePrice: z.coerce.number().min(0),
  /** Stored as fractions: 2.5% freight is 0.025. */
  freightPct: z.coerce.number().min(0).max(1).default(0),
  dutyPct: z.coerce.number().min(0).max(1).default(0),
  moq: z.coerce.number().min(0).nullable().optional(),
  packSize: z.coerce.number().min(0).nullable().optional(),
  leadTimeDays: z.coerce.number().int().min(0).default(0),
  reorderPoint: z.coerce.number().min(0).nullable().optional(),
  composition: z.string().nullable().optional(),
  gsm: z.coerce.number().min(0).nullable().optional(),
  widthCm: z.coerce.number().min(0).nullable().optional(),
});

export type MaterialInput = z.input<typeof materialSchema>;

/** Purchase price plus freight and duty — what the metre really costs. */
function landedCost(basePrice: number, freightPct: number, dutyPct: number) {
  return dec(basePrice).times(dec(freightPct).plus(dec(dutyPct)).plus(1));
}

export async function createMaterial(input: MaterialInput, ctx: AuditContext) {
  const data = materialSchema.parse(input);

  const clash = await db.material.findUnique({ where: { code: data.code } });
  if (clash) throw new MasterDataError(`Material code ${data.code} is already in use.`);

  return db.$transaction(async (tx) => {
    const material = await tx.material.create({
      data: {
        ...data,
        basePrice: dec(data.basePrice).toString(),
        freightPct: dec(data.freightPct).toString(),
        dutyPct: dec(data.dutyPct).toString(),
        moq: data.moq != null ? dec(data.moq).toString() : null,
        packSize: data.packSize != null ? dec(data.packSize).toString() : null,
        reorderPoint: data.reorderPoint != null ? dec(data.reorderPoint).toString() : null,
        gsm: data.gsm != null ? dec(data.gsm).toString() : null,
        widthCm: data.widthCm != null ? dec(data.widthCm).toString() : null,
      },
    });

    // The opening price is written to history immediately, so a costing done
    // today can still be explained after the price moves.
    await tx.materialPriceHistory.create({
      data: {
        materialId: material.id,
        basePrice: material.basePrice,
        freightPct: material.freightPct,
        dutyPct: material.dutyPct,
        effectiveCost: landedCost(data.basePrice, data.freightPct, data.dutyPct).toString(),
        effectiveFrom: new Date(),
        source: "Opening price",
      },
    });

    await writeAudit(tx, {
      action: "MATERIAL_CREATED",
      entityName: "Material",
      entityId: material.id,
      after: { code: material.code, type: material.type, basePrice: material.basePrice.toString() },
      ctx,
    });
    return material;
  });
}

/**
 * Updates a material, recording a price change as history rather than an edit.
 *
 * Existing cost snapshots keep the price they were built on; the new price
 * applies to costings made from now on.
 */
export async function updateMaterial(
  input: MaterialInput & { id: string; priceChangeReason?: string | null },
  ctx: AuditContext,
) {
  const data = materialSchema.parse(input);

  return db.$transaction(async (tx) => {
    const before = await tx.material.findUnique({ where: { id: input.id } });
    if (!before) throw new MasterDataError("Material not found.");

    if (before.code !== data.code) {
      const used = await tx.styleBomLine.count({ where: { materialId: input.id } });
      if (used > 0) {
        throw new MasterDataError(
          "This material is used in a bill of materials, so its code cannot be changed.",
        );
      }
    }

    const priceMoved =
      !dec(before.basePrice).equals(dec(data.basePrice)) ||
      !dec(before.freightPct).equals(dec(data.freightPct)) ||
      !dec(before.dutyPct).equals(dec(data.dutyPct));

    const after = await tx.material.update({
      where: { id: input.id },
      data: {
        ...data,
        basePrice: dec(data.basePrice).toString(),
        freightPct: dec(data.freightPct).toString(),
        dutyPct: dec(data.dutyPct).toString(),
        moq: data.moq != null ? dec(data.moq).toString() : null,
        packSize: data.packSize != null ? dec(data.packSize).toString() : null,
        reorderPoint: data.reorderPoint != null ? dec(data.reorderPoint).toString() : null,
        gsm: data.gsm != null ? dec(data.gsm).toString() : null,
        widthCm: data.widthCm != null ? dec(data.widthCm).toString() : null,
      },
    });

    if (priceMoved) {
      await tx.materialPriceHistory.create({
        data: {
          materialId: after.id,
          basePrice: after.basePrice,
          freightPct: after.freightPct,
          dutyPct: after.dutyPct,
          effectiveCost: landedCost(data.basePrice, data.freightPct, data.dutyPct).toString(),
          effectiveFrom: new Date(),
          source: input.priceChangeReason ?? "Price updated",
        },
      });
    }

    await writeAudit(tx, {
      action: priceMoved ? "MATERIAL_PRICE_CHANGED" : "MATERIAL_UPDATED",
      entityName: "Material",
      entityId: after.id,
      before: { basePrice: before.basePrice.toString(), code: before.code },
      after: { basePrice: after.basePrice.toString(), code: after.code },
      ctx: { ...ctx, reason: input.priceChangeReason ?? null },
    });
    return after;
  });
}

export async function setMaterialActive(
  input: { id: string; isActive: boolean },
  ctx: AuditContext,
) {
  return db.$transaction(async (tx) => {
    const after = await tx.material.update({
      where: { id: input.id },
      data: { isActive: input.isActive },
    });
    await writeAudit(tx, {
      action: input.isActive ? "MATERIAL_REACTIVATED" : "MATERIAL_DEACTIVATED",
      entityName: "Material",
      entityId: after.id,
      after: { code: after.code, isActive: after.isActive },
      ctx,
    });
    return after;
  });
}

// ---------------------------------------------------------------- customers

export const customerSchema = z.object({
  code: codeField.optional(),
  name: z.string().min(1, "A name is required."),
  phone: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  channelId: z.string().min(1).nullable().optional(),
  acquiredVia: z
    .enum(["SHOPIFY", "MODERATOR", "POS", "EXHIBITION", "WHOLESALE", "MANUAL"])
    .nullable()
    .optional(),
  marketingConsent: z.boolean().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export type CustomerInput = z.input<typeof customerSchema>;

export async function createCustomer(input: CustomerInput, ctx: AuditContext) {
  const data = customerSchema.parse(input);

  // A code is generated when nobody supplies one, because a cashier adding a
  // walk-in mid-queue should not have to invent an identifier.
  const code =
    data.code ?? `CUST-${String((await db.customer.count()) + 1).padStart(5, "0")}`;

  const clash = await db.customer.findUnique({ where: { code } });
  if (clash) throw new MasterDataError(`Customer code ${code} is already in use.`);

  const phoneNormalised = normalisePhone(data.phone);

  return db.$transaction(async (tx) => {
    const customer = await tx.customer.create({
      data: {
        code,
        name: data.name,
        phone: data.phone ?? null,
        email: data.email ?? null,
        city: data.city ?? null,
        channelId: data.channelId ?? null,
        acquiredVia: data.acquiredVia ?? null,
        notes: data.notes ?? null,
        phoneNormalised,
        emailNormalised: normaliseEmail(data.email),
        ...(data.marketingConsent != null
          ? { marketingConsent: data.marketingConsent, consentRecordedAt: new Date() }
          : {}),
      },
    });

    // Flagged, not blocked: a shared family phone is common, so the duplicate
    // is surfaced for review rather than refusing a real customer.
    const possibleDuplicate = phoneNormalised
      ? await tx.customer.findFirst({
          where: { phoneNormalised, id: { not: customer.id }, mergedIntoId: null },
          select: { code: true, name: true },
        })
      : null;

    await writeAudit(tx, {
      action: "CUSTOMER_CREATED",
      entityName: "Customer",
      entityId: customer.id,
      after: {
        code: customer.code,
        name: customer.name,
        possibleDuplicateOf: possibleDuplicate?.code ?? null,
      },
      ctx,
    });

    return { customer, possibleDuplicate };
  });
}

// ---------------------------------------------------------- the small lists
//
// Cost categories, colours, sizes and units were seeded once and had no way in
// after that. Every one of them blocks something real: no colour means no new
// variant, no cost category means an expense that has to be filed under
// roughly the right heading, and "roughly" is how a cost pool stops meaning
// anything. They are here rather than on a settings page because the moment
// somebody needs one is the moment they are filling in a form that lacks it.

export const costCategorySchema = z.object({
  entityId: z.string().min(1),
  code: z.string().trim().min(1).max(40),
  nameEn: z.string().trim().min(1),
  nameAr: z.string().trim().min(1),
  behaviour: z.enum(["FIXED", "VARIABLE", "SEMI_VARIABLE"]).default("FIXED"),
  /** Whether this cost belongs in the minute-rate numerator. */
  includeInMinuteRate: z.boolean().default(false),
  /** Whether it belongs in the brand fixed pool that break-even reads. */
  includeInBrandFixedPool: z.boolean().default(false),
  accountId: z.string().min(1).nullable().optional(),
});

export async function createCostCategory(
  input: z.input<typeof costCategorySchema>,
  ctx: AuditContext,
) {
  const data = costCategorySchema.parse(input);
  const code = data.code.toUpperCase();

  const clash = await db.costCategory.findFirst({
    where: { entityId: data.entityId, code },
  });
  if (clash) {
    throw new MasterDataError(`${code} is already "${clash.nameAr || clash.nameEn}".`);
  }

  return db.$transaction(async (tx) => {
    const category = await tx.costCategory.create({
      data: {
        entityId: data.entityId,
        code,
        nameEn: data.nameEn,
        nameAr: data.nameAr,
        behaviour: data.behaviour,
        includeInMinuteRate: data.includeInMinuteRate,
        includeInBrandFixedPool: data.includeInBrandFixedPool,
        accountId: data.accountId ?? null,
      },
    });

    await writeAudit(tx, {
      action: "COST_CATEGORY_CREATED",
      entityName: "CostCategory",
      entityId: category.id,
      after: {
        code,
        name: category.nameAr,
        // Recorded because it changes the minute rate every garment is costed
        // at, which is not obvious from a tick box on a form.
        includeInMinuteRate: data.includeInMinuteRate,
        includeInBrandFixedPool: data.includeInBrandFixedPool,
      },
      ctx,
    });

    return { id: category.id, code };
  });
}

export const colourSchema = z.object({
  code: z.string().trim().min(1).max(20),
  nameEn: z.string().trim().min(1),
  nameAr: z.string().trim().min(1),
  /** Shown as a swatch at the till, so a cashier can find it by eye. */
  hex: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, "A colour is a hex value like #1b1b1b.")
    .nullable()
    .optional(),
});

export async function createColour(
  input: z.input<typeof colourSchema>,
  ctx: AuditContext,
) {
  const data = colourSchema.parse(input);
  const code = data.code.toUpperCase();

  const clash = await db.colorCode.findUnique({ where: { code } });
  if (clash) throw new MasterDataError(`${code} is already "${clash.nameAr}".`);

  return db.$transaction(async (tx) => {
    const highest = await tx.colorCode.findFirst({
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });

    const colour = await tx.colorCode.create({
      data: {
        code,
        nameEn: data.nameEn,
        nameAr: data.nameAr,
        hex: data.hex ?? null,
        sortOrder: (highest?.sortOrder ?? 0) + 10,
      },
    });

    await writeAudit(tx, {
      action: "COLOUR_CREATED",
      entityName: "ColorCode",
      entityId: colour.id,
      after: { code, name: colour.nameAr },
      ctx,
    });

    return { id: colour.id, code };
  });
}

export const sizeSchema = z.object({
  code: z.string().trim().min(1).max(20),
  nameEn: z.string().trim().min(1),
  nameAr: z.string().trim().min(1),
  /**
   * How much cloth this size uses against the base size, which is 1.0.
   *
   * An XL in the same style genuinely uses more fabric, and costing every size
   * as though it were a medium quietly understates the large ones — the sizes
   * that usually sell last and at a markdown.
   */
  consumptionFactor: z.coerce.number().positive().default(1),
  /** Where it sits in a size run: S before M before L, not alphabetically. */
  sortOrder: z.coerce.number().int().optional(),
});

export async function createSize(
  input: z.input<typeof sizeSchema>,
  ctx: AuditContext,
) {
  const data = sizeSchema.parse(input);
  const code = data.code.toUpperCase();

  const clash = await db.sizeCode.findUnique({ where: { code } });
  if (clash) throw new MasterDataError(`${code} is already "${clash.nameAr}".`);

  return db.$transaction(async (tx) => {
    const highest = await tx.sizeCode.findFirst({
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });

    const size = await tx.sizeCode.create({
      data: {
        code,
        nameEn: data.nameEn,
        nameAr: data.nameAr,
        consumptionFactor: String(data.consumptionFactor),
        sortOrder: data.sortOrder ?? (highest?.sortOrder ?? 0) + 10,
      },
    });

    await writeAudit(tx, {
      action: "SIZE_CREATED",
      entityName: "SizeCode",
      entityId: size.id,
      after: { code, name: size.nameAr, consumptionFactor: data.consumptionFactor },
      ctx,
    });

    return { id: size.id, code };
  });
}

export const uomSchema = z.object({
  code: z.string().trim().min(1).max(20),
  nameEn: z.string().trim().min(1),
  nameAr: z.string().trim().min(1),
  kind: z.enum(["LENGTH", "MASS", "PIECE", "AREA"]),
});

export async function createUnitOfMeasure(
  input: z.input<typeof uomSchema>,
  ctx: AuditContext,
) {
  const data = uomSchema.parse(input);
  const code = data.code.trim();

  const clash = await db.unitOfMeasure.findUnique({ where: { code } });
  if (clash) throw new MasterDataError(`${code} is already "${clash.nameAr}".`);

  return db.$transaction(async (tx) => {
    const uom = await tx.unitOfMeasure.create({
      data: { code, nameEn: data.nameEn, nameAr: data.nameAr, kind: data.kind },
    });

    await writeAudit(tx, {
      action: "UOM_CREATED",
      entityName: "UnitOfMeasure",
      entityId: uom.id,
      after: { code, name: uom.nameAr, kind: data.kind },
      ctx,
    });

    return { id: uom.id, code };
  });
}
