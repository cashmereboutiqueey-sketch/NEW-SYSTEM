import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import {
  createCostCategory,
  createColour,
  createSize,
  createUnitOfMeasure,
  MasterDataError,
} from "./master-data";
import { dec } from "./money";

/**
 * The small lists nobody could add to.
 *
 * Cost categories, colours, sizes and units were seeded once and had no way in
 * afterwards. Each of them blocks something real: no colour means no new
 * variant, and no cost category means an expense filed under roughly the right
 * heading — and "roughly" is how a cost pool stops meaning anything.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let factoryId: string;
const ctx = { userId: null as string | null, reason: null };

beforeAll(async () => {
  factoryId = (await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } })).id;
});

beforeEach(async () => {
  await db.costCategory.deleteMany({ where: { code: { startsWith: "TEST-" } } });
  await db.colorCode.deleteMany({ where: { code: { startsWith: "TST" } } });
  await db.sizeCode.deleteMany({ where: { code: { startsWith: "TST" } } });
  await db.unitOfMeasure.deleteMany({ where: { code: { startsWith: "tst" } } });
});

afterAll(async () => {
  await db.costCategory.deleteMany({ where: { code: { startsWith: "TEST-" } } });
  await db.colorCode.deleteMany({ where: { code: { startsWith: "TST" } } });
  await db.sizeCode.deleteMany({ where: { code: { startsWith: "TST" } } });
  await db.unitOfMeasure.deleteMany({ where: { code: { startsWith: "tst" } } });
  await db.$disconnect();
});

describe("cost categories", () => {
  it("can be added, which was not previously possible at all", async () => {
    const { id } = await createCostCategory(
      {
        entityId: factoryId,
        code: "TEST-SEC",
        nameEn: "Security",
        nameAr: "أمن وحراسة",
        behaviour: "FIXED",
        includeInMinuteRate: true,
      },
      ctx,
    );

    const row = await db.costCategory.findUniqueOrThrow({ where: { id } });
    expect(row.nameAr).toBe("أمن وحراسة");
    expect(row.includeInMinuteRate).toBe(true);
  });

  it("upper-cases the code, so the same heading cannot exist twice", async () => {
    await createCostCategory(
      { entityId: factoryId, code: "test-sec", nameEn: "Security", nameAr: "أمن" },
      ctx,
    );
    expect(
      await db.costCategory.findFirst({ where: { entityId: factoryId, code: "TEST-SEC" } }),
    ).toBeTruthy();
  });

  it("refuses a code the entity already uses", async () => {
    await createCostCategory(
      { entityId: factoryId, code: "TEST-SEC", nameEn: "Security", nameAr: "أمن" },
      ctx,
    );
    await expect(
      createCostCategory(
        { entityId: factoryId, code: "TEST-SEC", nameEn: "Other", nameAr: "تاني" },
        ctx,
      ),
    ).rejects.toThrow(/already/i);
  });

  it("records that it feeds the minute rate", async () => {
    const { id } = await createCostCategory(
      {
        entityId: factoryId, code: "TEST-RATE", nameEn: "Line power", nameAr: "كهرباء الخط",
        includeInMinuteRate: true,
      },
      ctx,
    );

    // A tick box on a form changes the rate every garment is costed at, which
    // is not obvious from the form. The audit entry says so.
    const entry = await db.auditLog.findFirstOrThrow({
      where: { entityId: id, action: "COST_CATEGORY_CREATED" },
    });
    expect(JSON.stringify(entry.after)).toContain("includeInMinuteRate");
  });

  it("insists on both languages", async () => {
    await expect(
      createCostCategory(
        { entityId: factoryId, code: "TEST-X", nameEn: "Only English", nameAr: "  " },
        ctx,
      ),
    ).rejects.toThrow();
  });
});

describe("colours", () => {
  it("can be added and shows a swatch", async () => {
    const { id } = await createColour(
      { code: "TSTNVY", nameEn: "Navy", nameAr: "كحلي", hex: "#1b2a4a" },
      ctx,
    );
    const row = await db.colorCode.findUniqueOrThrow({ where: { id } });
    expect(row.nameAr).toBe("كحلي");
    expect(row.hex).toBe("#1b2a4a");
  });

  it("works without a swatch", async () => {
    const { id } = await createColour(
      { code: "TSTNOH", nameEn: "Unnamed", nameAr: "بدون لون" },
      ctx,
    );
    expect((await db.colorCode.findUniqueOrThrow({ where: { id } })).hex).toBeNull();
  });

  it("refuses something that is not a colour value", async () => {
    await expect(
      createColour({ code: "TSTBAD", nameEn: "Bad", nameAr: "غلط", hex: "navy" }, ctx),
    ).rejects.toThrow(/hex/i);
  });

  it("refuses a duplicate code", async () => {
    await createColour({ code: "TSTNVY", nameEn: "Navy", nameAr: "كحلي" }, ctx);
    await expect(
      createColour({ code: "TSTNVY", nameEn: "Navy blue", nameAr: "أزرق" }, ctx),
    ).rejects.toThrow(MasterDataError);
  });

  it("goes to the end of the list rather than the middle", async () => {
    const before = await db.colorCode.findFirst({ orderBy: { sortOrder: "desc" } });
    const { id } = await createColour({ code: "TSTEND", nameEn: "Last", nameAr: "آخر" }, ctx);
    const row = await db.colorCode.findUniqueOrThrow({ where: { id } });
    expect(row.sortOrder).toBeGreaterThan(before?.sortOrder ?? 0);
  });
});

describe("sizes", () => {
  it("carries how much cloth it uses", async () => {
    const { id } = await createSize(
      { code: "TSTXXL", nameEn: "XXL", nameAr: "XXL", consumptionFactor: 1.18 },
      ctx,
    );

    // An XL genuinely uses more fabric. Costing every size as a medium
    // understates the large ones — which are the ones that sell last and at a
    // markdown.
    const row = await db.sizeCode.findUniqueOrThrow({ where: { id } });
    expect(dec(row.consumptionFactor).toNumber()).toBeCloseTo(1.18, 4);
  });

  it("defaults to the base size when nobody says otherwise", async () => {
    const { id } = await createSize({ code: "TSTM", nameEn: "M", nameAr: "M" }, ctx);
    expect(dec((await db.sizeCode.findUniqueOrThrow({ where: { id } })).consumptionFactor).toNumber())
      .toBe(1);
  });

  it("refuses a consumption factor of zero", async () => {
    await expect(
      createSize({ code: "TSTZ", nameEn: "Z", nameAr: "Z", consumptionFactor: 0 }, ctx),
    ).rejects.toThrow();
  });

  it("takes an explicit position, so a size run reads S M L not alphabetically", async () => {
    const { id } = await createSize(
      { code: "TSTS", nameEn: "S", nameAr: "S", sortOrder: 5 },
      ctx,
    );
    expect((await db.sizeCode.findUniqueOrThrow({ where: { id } })).sortOrder).toBe(5);
  });
});

describe("units of measure", () => {
  it("can be added", async () => {
    const { id } = await createUnitOfMeasure(
      { code: "tst-cone", nameEn: "Cone", nameAr: "مخروط", kind: "PIECE" },
      ctx,
    );
    const row = await db.unitOfMeasure.findUniqueOrThrow({ where: { id } });
    expect(row.nameAr).toBe("مخروط");
    expect(row.kind).toBe("PIECE");
  });

  it("keeps the code as typed, because a unit is written how it is written", async () => {
    // Unlike a category code, "kg" is not "KG" — it is how the unit is
    // printed on every document.
    const { id } = await createUnitOfMeasure(
      { code: "tst-kg", nameEn: "Kilogram", nameAr: "كيلو", kind: "MASS" },
      ctx,
    );
    expect((await db.unitOfMeasure.findUniqueOrThrow({ where: { id } })).code).toBe("tst-kg");
  });

  it("refuses a duplicate", async () => {
    await createUnitOfMeasure(
      { code: "tst-m", nameEn: "Metre", nameAr: "متر", kind: "LENGTH" },
      ctx,
    );
    await expect(
      createUnitOfMeasure(
        { code: "tst-m", nameEn: "Meter", nameAr: "متر", kind: "LENGTH" },
        ctx,
      ),
    ).rejects.toThrow(MasterDataError);
  });

  it("refuses a kind the system does not measure in", async () => {
    await expect(
      createUnitOfMeasure(
        { code: "tst-hr", nameEn: "Hour", nameAr: "ساعة", kind: "TIME" as never },
        ctx,
      ),
    ).rejects.toThrow();
  });
});
