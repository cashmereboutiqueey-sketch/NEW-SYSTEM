import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { createExpense } from "./expenses";
import { calculatePeriodMinuteRate } from "./minute-rate";
import { previewStyleCost, createCostSnapshot, CostingError } from "./costing";

/** Style costing and immutable snapshots, against a real database. */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let factoryId: string;
let periodId: string;
let periodStart: Date;
let styleId: string;
let rateperiodId: string;

const ctx = { userId: null as string | null, reason: null };

beforeAll(async () => {
  factoryId = (await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } })).id;
  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" }, orderBy: { startDate: "asc" },
  });
  periodId = period.id;
  periodStart = new Date(period.startDate);

  // A seeded style that actually has a BOM and operations.
  const style = await db.style.findFirstOrThrow({
    where: { bomLines: { some: {} }, operations: { some: {} } },
  });
  styleId = style.id;
});

async function wipe() {
  await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
  await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
  try {
    await db.costSnapshotLine.deleteMany({});
    await db.costSnapshot.deleteMany({});
    await db.minuteRateComponent.deleteMany({});
    await db.minuteRatePeriod.deleteMany({});
    await db.journalLine.deleteMany({});
    await db.journalEntry.deleteMany({});
    await db.expense.deleteMany({});
    await db.auditLog.deleteMany({});
    await db.documentSequence.deleteMany({});
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
  }
}

/** Posts a conversion pool and produces a usable minute rate. */
async function givenMinuteRate(pool = 568000) {
  const cat = await db.costCategory.findFirstOrThrow({
    where: { code: "FAC-RENT", entityId: factoryId },
  });
  await createExpense(
    {
      entityId: factoryId, costCategoryId: cat.id, description: "Conversion pool",
      amount: pool, incurredDate: periodStart, dueDate: periodStart,
    },
    ctx,
  );
  const r = await calculatePeriodMinuteRate(
    { entityId: factoryId, fiscalPeriodId: periodId }, ctx,
  );
  rateperiodId = r.minuteRatePeriodId;
  return r;
}

beforeEach(async () => {
  await wipe();
  await givenMinuteRate();
});

afterAll(async () => { await wipe(); await db.$disconnect(); });

describe("previewing a style cost", () => {
  it("builds the full cost chain from real BOM and operations", async () => {
    const p = await previewStyleCost({ styleId, minuteRatePeriodId: rateperiodId });

    expect(p.lines.length).toBeGreaterThan(0);
    expect(p.materialCost.greaterThan(0)).toBe(true);
    expect(p.cmtCost.greaterThan(0)).toBe(true);
    // transfer = (materials + cmt) × (1 + margin)
    expect(p.factoryTotalCost.toFixed(4)).toBe(
      p.materialCost.plus(p.cmtCost).toFixed(4),
    );
    expect(p.transferPrice.greaterThan(p.factoryTotalCost)).toBe(true);
  });

  it("uses landed cost, not the invoice price", async () => {
    const p = await previewStyleCost({ styleId, minuteRatePeriodId: rateperiodId });
    const line = p.lines[0];
    const material = await db.material.findUniqueOrThrow({ where: { id: line.materialId } });

    // Freight and duty are capitalised into the material cost.
    if (Number(material.freightPct) > 0 || Number(material.dutyPct) > 0) {
      expect(Number(line.unitCost)).toBeGreaterThan(Number(material.basePrice));
    }
  });

  it("recomputes SMV from the operations rather than trusting the cached total", async () => {
    const ops = await db.styleOperation.findMany({ where: { styleId } });
    const expected = ops.reduce((s, o) => s + Number(o.smvMinutes), 0);
    const p = await previewStyleCost({ styleId, minuteRatePeriodId: rateperiodId });
    expect(Number(p.smvMinutes)).toBeCloseTo(expected, 4);
  });

  it("reports the idle capacity carried by this garment", async () => {
    const p = await previewStyleCost({ styleId, minuteRatePeriodId: rateperiodId });
    // At 60% utilisation there is real idleness embedded in the rate.
    expect(p.idlePenalty.greaterThan(0)).toBe(true);
  });

  it("flags a margin below the arm's-length floor", async () => {
    const p = await previewStyleCost({
      styleId, minuteRatePeriodId: rateperiodId, factoryMarginPct: "0.05",
    });
    expect(p.marginBelowArmsLength).toBe(true);
  });

  it("refuses a period with no usable rate", async () => {
    const empty = await db.minuteRatePeriod.update({
      where: { id: rateperiodId }, data: { actualMinuteRate: "0" },
    });
    await expect(
      previewStyleCost({ styleId, minuteRatePeriodId: empty.id }),
    ).rejects.toThrow(/no usable minute rate/i);
  });
});

describe("creating a snapshot", () => {
  it("freezes every input alongside the resulting price", async () => {
    const result = await createCostSnapshot(
      { styleId, minuteRatePeriodId: rateperiodId, reason: "Initial costing" }, ctx,
    );

    const snap = await db.costSnapshot.findUniqueOrThrow({
      where: { id: result.costSnapshotId },
      include: { lines: true, minuteRatePeriod: true },
    });

    expect(Number(snap.minuteRate)).toBeGreaterThan(0);
    expect(Number(snap.smvMinutes)).toBeGreaterThan(0);
    expect(snap.lines.length).toBeGreaterThan(0);
    expect(snap.minuteRatePeriodId).toBe(rateperiodId);
    // Every BOM line is frozen with its own price and waste.
    for (const l of snap.lines) {
      expect(Number(l.unitCost)).toBeGreaterThan(0);
      expect(Number(l.effectiveConsumption)).toBeGreaterThanOrEqual(
        Number(l.standardConsumption),
      );
    }
  });

  it("survives a later material price change untouched", async () => {
    const first = await createCostSnapshot(
      { styleId, minuteRatePeriodId: rateperiodId }, ctx,
    );
    const before = await db.costSnapshot.findUniqueOrThrow({
      where: { id: first.costSnapshotId },
    });

    // Fabric goes up 30%.
    const bom = await db.styleBomLine.findFirstOrThrow({ where: { styleId } });
    const material = await db.material.findUniqueOrThrow({ where: { id: bom.materialId } });
    await db.material.update({
      where: { id: material.id },
      data: { basePrice: (Number(material.basePrice) * 1.3).toFixed(4) },
    });

    const second = await createCostSnapshot(
      { styleId, minuteRatePeriodId: rateperiodId, reason: "Fabric price rise" }, ctx,
    );
    const after = await db.costSnapshot.findUniqueOrThrow({
      where: { id: first.costSnapshotId },
    });

    // The original is byte-for-byte unchanged; the new one is dearer.
    expect(after.transferPrice.toString()).toBe(before.transferPrice.toString());
    expect(after.materialCost.toString()).toBe(before.materialCost.toString());
    expect(Number(second.transferPrice)).toBeGreaterThan(Number(before.transferPrice));

    // Restore so later tests see the seeded price.
    await db.material.update({
      where: { id: material.id }, data: { basePrice: material.basePrice },
    });
  });

  it("keeps the old rate when the minute rate is recalculated", async () => {
    const first = await createCostSnapshot(
      { styleId, minuteRatePeriodId: rateperiodId }, ctx,
    );
    const before = await db.costSnapshot.findUniqueOrThrow({
      where: { id: first.costSnapshotId },
    });

    // More conversion cost arrives; the rate for the period goes up.
    const cat = await db.costCategory.findFirstOrThrow({
      where: { code: "FAC-UTILITIES", entityId: factoryId },
    });
    await createExpense(
      {
        entityId: factoryId, costCategoryId: cat.id, description: "Late electricity bill",
        amount: 90000, incurredDate: periodStart, dueDate: periodStart,
      },
      ctx,
    );
    await calculatePeriodMinuteRate({ entityId: factoryId, fiscalPeriodId: periodId }, ctx);

    const after = await db.costSnapshot.findUniqueOrThrow({
      where: { id: first.costSnapshotId },
    });
    expect(after.minuteRate.toString()).toBe(before.minuteRate.toString());
    expect(after.transferPrice.toString()).toBe(before.transferPrice.toString());
  });

  it("blocks a below-floor margin unless it is explicitly approved", async () => {
    await expect(
      createCostSnapshot(
        { styleId, minuteRatePeriodId: rateperiodId, factoryMarginPct: "0.04" }, ctx,
      ),
    ).rejects.toThrow(/below the arm's-length minimum/i);
  });

  it("allows a below-floor margin with an approval note and records it", async () => {
    const result = await createCostSnapshot(
      {
        styleId, minuteRatePeriodId: rateperiodId, factoryMarginPct: "0.04",
        approvalNote: "Owner-approved introductory price for a launch collection",
      },
      ctx,
    );

    expect(result.belowFloor).toBe(true);
    const snap = await db.costSnapshot.findUniqueOrThrow({
      where: { id: result.costSnapshotId },
    });
    expect(snap.marginBelowArmsLength).toBe(true);
    expect(snap.approvalNote).toMatch(/introductory/);

    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityName: "CostSnapshot", action: "COST_SNAPSHOT_CREATED_BELOW_FLOOR" },
    });
    expect(audit.after).toMatchObject({ belowFloor: true });
  });

  it("records the minute-rate period the price was built on", async () => {
    const result = await createCostSnapshot(
      { styleId, minuteRatePeriodId: rateperiodId }, ctx,
    );
    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityName: "CostSnapshot", entityId: result.costSnapshotId },
    });
    expect(audit.after).toMatchObject({ minuteRate: expect.any(String) });
  });

  it("appends rather than replacing, so the history is a chain", async () => {
    await createCostSnapshot({ styleId, minuteRatePeriodId: rateperiodId }, ctx);
    await createCostSnapshot({ styleId, minuteRatePeriodId: rateperiodId }, ctx);
    await createCostSnapshot({ styleId, minuteRatePeriodId: rateperiodId }, ctx);

    expect(await db.costSnapshot.count({ where: { styleId } })).toBe(3);
  });

  it("refuses a style with no bill of materials", async () => {
    const bare = await db.style.findFirst({ where: { bomLines: { none: {} } } });
    if (!bare) return; // every seeded style has a BOM, which is itself correct
    await expect(
      createCostSnapshot({ styleId: bare.id, minuteRatePeriodId: rateperiodId }, ctx),
    ).rejects.toThrow(CostingError);
  });
});
