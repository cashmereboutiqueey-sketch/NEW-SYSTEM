import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import {
  createColour, createSize, createUnitOfMeasure, createCostCategory,
  updateColour, updateSize, updateUnitOfMeasure, updateCostCategory,
  MasterDataError,
} from "./master-data";

/**
 * Fixing the small lists after they have been typed wrong.
 *
 * Adding was possible and changing was not, so a mistyped name was permanent —
 * the sort of gap nobody notices until the first week of real use. Nothing is
 * deleted, because a colour is referenced by the variants made in it; retiring
 * hides it from the pickers and leaves what has already been made alone.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let ownerId: string;
let entityId: string;
const tag = Math.random().toString(36).slice(2, 6).toUpperCase();

const ctx = () => ({ userId: ownerId, reason: null });

beforeAll(async () => {
  ownerId = (await db.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  entityId = (await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } })).id;
});

afterAll(async () => {
  // Take back exactly what was made, so the demo is as it was found.
  await db.colorCode.deleteMany({ where: { code: { startsWith: `Q${tag}` } } });
  await db.sizeCode.deleteMany({ where: { code: { startsWith: `Q${tag}` } } });
  await db.unitOfMeasure.deleteMany({ where: { code: { startsWith: `Q${tag}` } } });
  await db.costCategory.deleteMany({ where: { code: { startsWith: `Q${tag}` } } });
  await db.$disconnect();
});

describe("a colour typed wrong", () => {
  it("can be renamed without touching its code", async () => {
    const made = await createColour(
      { code: `Q${tag}C`, nameAr: "أزق", nameEn: "Bleu" },
      ctx(),
    );

    const fixed = await updateColour(
      { id: made.id, nameAr: "أزرق", nameEn: "Blue" },
      ctx(),
    );

    const row = await db.colorCode.findUniqueOrThrow({ where: { id: made.id } });
    expect(row.nameAr).toBe("أزرق");
    // The code is inside the SKU of every garment already made in it.
    expect(row.code).toBe(fixed.code);
    expect(row.code).toBe(`Q${tag}C`);
  });

  it("is retired rather than deleted", async () => {
    const made = await createColour({ code: `Q${tag}D`, nameAr: "لون", nameEn: "Colour" }, ctx());

    await updateColour({ id: made.id, isActive: false }, ctx());

    const row = await db.colorCode.findUniqueOrThrow({ where: { id: made.id } });
    expect(row.isActive).toBe(false);
    // Still there: the history refers to it.
    expect(row.id).toBe(made.id);
  });

  it("can be brought back", async () => {
    const made = await createColour({ code: `Q${tag}E`, nameAr: "لون", nameEn: "Colour" }, ctx());
    await updateColour({ id: made.id, isActive: false }, ctx());
    await updateColour({ id: made.id, isActive: true }, ctx());

    expect((await db.colorCode.findUniqueOrThrow({ where: { id: made.id } })).isActive).toBe(true);
  });

  it("refuses a swatch that is not a colour", async () => {
    const made = await createColour({ code: `Q${tag}F`, nameAr: "لون", nameEn: "Colour" }, ctx());
    await expect(updateColour({ id: made.id, hex: "blue" }, ctx())).rejects.toThrow(MasterDataError);
  });

  it("says how many garments were made in it", async () => {
    const made = await createColour({ code: `Q${tag}G`, nameAr: "لون", nameEn: "Colour" }, ctx());
    const result = await updateColour({ id: made.id, nameAr: "لون تاني" }, ctx());

    // Nothing has been made in a colour created a moment ago, and saying so is
    // what lets a screen warn before retiring one that has.
    expect(result.variants).toBe(0);
  });

  it("records both sides of the change", async () => {
    const made = await createColour({ code: `Q${tag}H`, nameAr: "قبل", nameEn: "Before" }, ctx());
    await updateColour({ id: made.id, nameEn: "After" }, ctx());

    const log = await db.auditLog.findFirst({
      where: { entityId: made.id, action: "COLOUR_UPDATED" },
      orderBy: { createdAt: "desc" },
    });

    expect((log?.before as { nameEn: string }).nameEn).toBe("Before");
    expect((log?.after as { nameEn: string }).nameEn).toBe("After");
  });
});

describe("a size", () => {
  it("can have its cloth factor corrected", async () => {
    const made = await createSize(
      { code: `Q${tag}S`, nameAr: "مقاس", nameEn: "Size", consumptionFactor: 1 },
      ctx(),
    );

    // An XL genuinely uses more cloth, and getting that wrong misprices every
    // garment cut to it.
    await updateSize({ id: made.id, consumptionFactor: 1.15 }, ctx());

    const row = await db.sizeCode.findUniqueOrThrow({ where: { id: made.id } });
    expect(Number(row.consumptionFactor)).toBeCloseTo(1.15, 6);
  });

  it("refuses a factor of zero", async () => {
    const made = await createSize(
      { code: `Q${tag}T`, nameAr: "مقاس", nameEn: "Size", consumptionFactor: 1 },
      ctx(),
    );
    await expect(updateSize({ id: made.id, consumptionFactor: 0 }, ctx())).rejects.toThrow();
  });

  it("is retired rather than deleted", async () => {
    const made = await createSize(
      { code: `Q${tag}U`, nameAr: "مقاس", nameEn: "Size", consumptionFactor: 1 },
      ctx(),
    );
    await updateSize({ id: made.id, isActive: false }, ctx());

    expect((await db.sizeCode.findUniqueOrThrow({ where: { id: made.id } })).isActive).toBe(false);
  });
});

describe("a unit", () => {
  it("can be renamed", async () => {
    const made = await createUnitOfMeasure(
      { code: `Q${tag}U1`, nameAr: "متر طولي", nameEn: "Linear metre", kind: "LENGTH" },
      ctx(),
    );

    await updateUnitOfMeasure({ id: made.id, nameAr: "متر" }, ctx());

    expect((await db.unitOfMeasure.findUniqueOrThrow({ where: { id: made.id } })).nameAr).toBe("متر");
  });

  it("refuses an empty name", async () => {
    const made = await createUnitOfMeasure(
      { code: `Q${tag}U2`, nameAr: "وحدة", nameEn: "Unit", kind: "PIECE" },
      ctx(),
    );
    await expect(updateUnitOfMeasure({ id: made.id, nameAr: "" }, ctx())).rejects.toThrow();
  });
});

describe("a cost heading", () => {
  it("can be renamed and retired", async () => {
    const made = await createCostCategory(
      { entityId, code: `Q${tag}CC`, nameAr: "بند", nameEn: "Heading", behaviour: "FIXED" },
      ctx(),
    );

    await updateCostCategory({ id: made.id, nameAr: "بند مصحح" }, ctx());
    await updateCostCategory({ id: made.id, isActive: false }, ctx());

    const row = await db.costCategory.findUniqueOrThrow({ where: { id: made.id } });
    expect(row.nameAr).toBe("بند مصحح");
    expect(row.isActive).toBe(false);
  });

  it("says when a change moved it in or out of the minute rate", async () => {
    const made = await createCostCategory(
      { entityId, code: `Q${tag}CD`, nameAr: "بند", nameEn: "Heading", behaviour: "FIXED" },
      ctx(),
    );

    const moved = await updateCostCategory({ id: made.id, includeInMinuteRate: true }, ctx());
    // This changes what every garment made afterwards is costed at, so the
    // screen has to be able to say so rather than letting it happen quietly.
    expect(moved.changedTheMinuteRate).toBe(true);

    const unchanged = await updateCostCategory({ id: made.id, nameAr: "اسم تاني" }, ctx());
    expect(unchanged.changedTheMinuteRate).toBe(false);
  });

  it("says how many expenses are filed under it", async () => {
    const made = await createCostCategory(
      { entityId, code: `Q${tag}CE`, nameAr: "بند", nameEn: "Heading", behaviour: "FIXED" },
      ctx(),
    );
    const result = await updateCostCategory({ id: made.id, nameAr: "تاني" }, ctx());
    expect(result.expenses).toBe(0);
  });
});
