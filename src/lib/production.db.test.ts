import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { createExpense } from "./expenses";
import { calculatePeriodMinuteRate } from "./minute-rate";
import { receiveMaterial } from "./inventory";
import {
  createProductionOrder,
  confirmProductionOrder,
  issueForOrder,
  completeProductionOrder,
  plannedMaterials,
  ProductionError,
} from "./production";
import { dec } from "./money";

/** The production order lifecycle, against a real database. */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let factoryId: string;
let periodId: string;
let day: Date;
let styleId: string;
let variantId: string;
let allVariantIds: string[];
let fabricId: string;
let locationId: string;
let rateperiodId: string;

const ctx = { userId: null as string | null, reason: null };

beforeAll(async () => {
  factoryId = (await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } })).id;
  locationId = (await db.location.findFirstOrThrow({ where: { code: "LOC-FAC" } })).id;

  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" }, orderBy: { startDate: "asc" },
  });
  periodId = period.id;
  day = new Date(period.startDate);

  // A style whose BOM actually contains fabric, so issuing is meaningful.
  const style = await db.style.findFirstOrThrow({
    where: {
      operations: { some: {} },
      bomLines: { some: { material: { type: "FABRIC" } } },
    },
    include: { bomLines: { include: { material: true } }, variants: true },
  });
  styleId = style.id;
  variantId = style.variants[0].id;
  allVariantIds = style.variants.map((v) => v.id);
  fabricId = style.bomLines.find((l) => l.material.type === "FABRIC")!.materialId;
});

async function wipe() {
  await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
  await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
  try {
    await db.materialIssue.deleteMany({});
    await db.capacityBooking.deleteMany({});
    await db.productionOrderLine.deleteMany({});
    await db.productionOrder.deleteMany({});
    await db.inventoryMovement.deleteMany({});
    await db.inventoryLot.deleteMany({});
    await db.costSnapshotLine.deleteMany({});
    await db.costSnapshot.deleteMany({});
    await db.minuteRateComponent.deleteMany({});
    await db.minuteRatePeriod.deleteMany({});
    await db.bankStatementLine.deleteMany({});
    await db.bankStatement.deleteMany({});
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

/** Conversion costs posted and a minute rate calculated. */
async function givenMinuteRate() {
  const cat = await db.costCategory.findFirstOrThrow({
    where: { code: "FAC-RENT", entityId: factoryId },
  });
  await createExpense(
    {
      entityId: factoryId, costCategoryId: cat.id, description: "Conversion pool",
      amount: 568000, incurredDate: day, dueDate: day,
    },
    ctx,
  );
  const r = await calculatePeriodMinuteRate(
    { entityId: factoryId, fiscalPeriodId: periodId }, ctx,
  );
  rateperiodId = r.minuteRatePeriodId;
}

/** Plenty of fabric in stock so issuing never hits a shortfall. */
async function givenFabric(quantity = "5000") {
  await receiveMaterial(
    {
      materialId: fabricId, locationId, entityId: factoryId,
      quantity, unitCost: "172.20", receivedDate: day,
    },
    ctx,
  );
}

beforeEach(async () => {
  await wipe();
  await givenMinuteRate();
  await givenFabric();
});

afterAll(async () => { await wipe(); await db.$disconnect(); });

async function draftOrder(plannedQty = 100) {
  return createProductionOrder({ styleId, plannedQty, orderDate: day }, ctx);
}

describe("creating an order", () => {
  it("starts as a draft with a readable number", async () => {
    const { productionOrderId, orderNumber } = await draftOrder();
    expect(orderNumber).toMatch(/^PO-\d{4}-\d{2}-\d{4}$/);

    const order = await db.productionOrder.findUniqueOrThrow({
      where: { id: productionOrderId },
    });
    expect(order.status).toBe("DRAFT");
    expect(order.costSnapshotId).toBeNull();
  });

  it("rejects a size breakdown that disagrees with the order quantity", async () => {
    const variants = await db.variant.findMany({ where: { styleId }, take: 2 });
    await expect(
      createProductionOrder(
        {
          styleId, plannedQty: 100, orderDate: day,
          lines: variants.map((v) => ({ variantId: v.id, plannedQty: 30 })),
        },
        ctx,
      ),
    ).rejects.toThrow(/totals 60 but the order is for 100/i);
  });

  it("rejects a zero quantity", async () => {
    await expect(
      createProductionOrder({ styleId, plannedQty: 0, orderDate: day }, ctx),
    ).rejects.toThrow(ProductionError);
  });

  it("explodes the BOM across the run including waste", async () => {
    const { productionOrderId } = await draftOrder(200);
    const required = await plannedMaterials(productionOrderId);

    expect(required.length).toBeGreaterThan(0);
    for (const r of required) {
      // Required must exceed the waste-free quantity for the run.
      expect(
        r.requiredQty.greaterThan(r.standardConsumption.times(200)) ||
          r.wasteRate.isZero(),
      ).toBe(true);
    }
  });
});

describe("confirming an order", () => {
  it("freezes a cost snapshot and computes the planned figures", async () => {
    const { productionOrderId } = await draftOrder(100);
    const result = await confirmProductionOrder(
      { productionOrderId, minuteRatePeriodId: rateperiodId }, ctx,
    );

    const order = await db.productionOrder.findUniqueOrThrow({
      where: { id: productionOrderId },
      include: { costSnapshot: true },
    });

    expect(order.status).toBe("CONFIRMED");
    expect(order.costSnapshotId).toBe(result.costSnapshotId);
    expect(Number(order.plannedTotalCost)).toBeCloseTo(
      Number(order.costSnapshot!.factoryTotalCost) * 100, 2,
    );
    expect(Number(order.plannedTotalMinutes)).toBeCloseTo(
      Number(order.costSnapshot!.smvMinutes) * 100, 4,
    );
    expect(Number(order.plannedFabricQty)).toBeGreaterThan(0);
  });

  it("books the capacity so idle minutes are visible in advance", async () => {
    const { productionOrderId } = await draftOrder(100);
    await confirmProductionOrder({ productionOrderId, minuteRatePeriodId: rateperiodId }, ctx);

    const booking = await db.capacityBooking.findFirstOrThrow({
      where: { productionOrderId },
    });
    const order = await db.productionOrder.findUniqueOrThrow({
      where: { id: productionOrderId },
    });
    expect(booking.minutes.toString()).toBe(order.plannedTotalMinutes!.toString());
    expect(booking.source).toBe("PRODUCTION_ORDER");
  });

  it("keeps its own cost even after the style is recosted", async () => {
    const { productionOrderId } = await draftOrder(100);
    await confirmProductionOrder({ productionOrderId, minuteRatePeriodId: rateperiodId }, ctx);

    const before = await db.productionOrder.findUniqueOrThrow({
      where: { id: productionOrderId }, include: { costSnapshot: true },
    });

    // Fabric jumps 40% and the style is recosted.
    const material = await db.material.findUniqueOrThrow({ where: { id: fabricId } });
    await db.material.update({
      where: { id: fabricId },
      data: { basePrice: (Number(material.basePrice) * 1.4).toFixed(4) },
    });
    const { createCostSnapshot } = await import("./costing");
    await createCostSnapshot({ styleId, minuteRatePeriodId: rateperiodId }, ctx);

    const after = await db.productionOrder.findUniqueOrThrow({
      where: { id: productionOrderId }, include: { costSnapshot: true },
    });
    expect(after.costSnapshot!.materialCost.toString()).toBe(
      before.costSnapshot!.materialCost.toString(),
    );
    expect(after.plannedTotalCost!.toString()).toBe(before.plannedTotalCost!.toString());

    await db.material.update({ where: { id: fabricId }, data: { basePrice: material.basePrice } });
  });

  it("refuses to confirm twice", async () => {
    const { productionOrderId } = await draftOrder();
    await confirmProductionOrder({ productionOrderId, minuteRatePeriodId: rateperiodId }, ctx);
    await expect(
      confirmProductionOrder({ productionOrderId, minuteRatePeriodId: rateperiodId }, ctx),
    ).rejects.toThrow(/cannot be confirmed again/i);
  });
});

describe("issuing material", () => {
  it("refuses before the order is confirmed", async () => {
    // Issuing first would consume stock against a cost basis that is not yet
    // frozen, so the run could never be measured against anything.
    const { productionOrderId } = await draftOrder();
    await expect(
      issueForOrder(
        {
          productionOrderId, materialId: fabricId, locationId, entityId: factoryId,
          quantity: "100", issueDate: day,
        },
        ctx,
      ),
    ).rejects.toThrow(/must be confirmed before material is issued/i);
  });

  it("records the waste that actually happened", async () => {
    const { productionOrderId } = await draftOrder(100);
    await confirmProductionOrder({ productionOrderId, minuteRatePeriodId: rateperiodId }, ctx);

    const bom = await db.styleBomLine.findFirstOrThrow({
      where: { styleId, materialId: fabricId },
    });
    const standard = dec(bom.standardConsumption).times(100);
    // Issue 12% more than standard against a planned rate that is lower.
    const issued = standard.times("1.12");

    const result = await issueForOrder(
      {
        productionOrderId, materialId: fabricId, locationId, entityId: factoryId,
        quantity: issued.toString(), issueDate: day, piecesCut: 100,
      },
      ctx,
    );

    expect(Number(result.actualWasteRate)).toBeCloseTo(0.12, 6);

    const record = await db.materialIssue.findFirstOrThrow({ where: { productionOrderId } });
    expect(record.standardQty.toString()).toBe(standard.toString());
    expect(Number(record.varianceQty)).toBeCloseTo(Number(issued.minus(standard)), 4);
  });

  it("moves the order into production and accumulates fabric consumed", async () => {
    const { productionOrderId } = await draftOrder(100);
    await confirmProductionOrder({ productionOrderId, minuteRatePeriodId: rateperiodId }, ctx);

    await issueForOrder(
      {
        productionOrderId, materialId: fabricId, locationId, entityId: factoryId,
        quantity: "100", issueDate: day,
      },
      ctx,
    );
    await issueForOrder(
      {
        productionOrderId, materialId: fabricId, locationId, entityId: factoryId,
        quantity: "50", issueDate: day,
      },
      ctx,
    );

    const order = await db.productionOrder.findUniqueOrThrow({ where: { id: productionOrderId } });
    expect(order.status).toBe("IN_PRODUCTION");
    expect(order.actualFabricQty!.toString()).toBe("150");
  });

  it("refuses a material that is not in the style's BOM", async () => {
    const { productionOrderId } = await draftOrder();
    await confirmProductionOrder({ productionOrderId, minuteRatePeriodId: rateperiodId }, ctx);

    const inBom = await db.styleBomLine.findMany({
      where: { styleId }, select: { materialId: true },
    });
    const stranger = await db.material.findFirstOrThrow({
      where: { id: { notIn: inBom.map((l) => l.materialId) } },
    });
    await expect(
      issueForOrder(
        {
          productionOrderId, materialId: stranger.id, locationId, entityId: factoryId,
          quantity: "10", issueDate: day,
        },
        ctx,
      ),
    ).rejects.toThrow(/not in this style's bill of materials/i);
  });
});

/** Confirms an order and issues fabric against it, ready to be closed. */
async function runOrder(plannedQty: number, fabricIssued: string) {
  const { productionOrderId } = await draftOrder(plannedQty);
  await confirmProductionOrder({ productionOrderId, minuteRatePeriodId: rateperiodId }, ctx);
  await issueForOrder(
    {
      productionOrderId, materialId: fabricId, locationId, entityId: factoryId,
      quantity: fabricIssued, issueDate: day, piecesCut: plannedQty,
    },
    ctx,
  );
  return productionOrderId;
}

describe("completing an order", () => {

  it("receives garments at the frozen snapshot cost", async () => {
    const productionOrderId = await runOrder(100, "200");
    const result = await completeProductionOrder(
      {
        productionOrderId, outputs: [{ variantId, goodQty: 96 }], rejectedQty: 4,
        locationId, entityId: factoryId, completedDate: day,
      },
      ctx,
    );

    const order = await db.productionOrder.findUniqueOrThrow({
      where: { id: productionOrderId }, include: { costSnapshot: true },
    });
    const lot = await db.inventoryLot.findFirstOrThrow({
      where: { lotNumber: result.finishedLotNumbers[0] },
    });

    expect(order.status).toBe("COMPLETED");
    expect(order.actualQty).toBe(96);
    expect(order.rejectedQty).toBe(4);
    // Stock carries exactly what the costing promised.
    expect(lot.unitCost.toString()).toBe(order.costSnapshot!.factoryTotalCost.toString());
    expect(lot.remainingQty.toString()).toBe("96");
  });

  it("reports a favourable cost variance when fewer garments are made", async () => {
    const productionOrderId = await runOrder(100, "200");
    const result = await completeProductionOrder(
      {
        productionOrderId, outputs: [{ variantId, goodQty: 90 }],
        locationId, entityId: factoryId, completedDate: day,
      },
      ctx,
    );

    // Planned 100 garments' worth of cost, made 90 — cost is lower, but that
    // is a shortfall in output, not a saving. The variance shows the number;
    // reading it is the owner's job.
    expect(Number(result.costVariance)).toBeLessThan(0);
  });

  it("reports the fabric variance against plan", async () => {
    const productionOrderId = await runOrder(100, "500");
    const result = await completeProductionOrder(
      {
        productionOrderId, outputs: [{ variantId, goodQty: 100 }],
        locationId, entityId: factoryId, completedDate: day,
      },
      ctx,
    );

    const order = await db.productionOrder.findUniqueOrThrow({ where: { id: productionOrderId } });
    // 500 metres issued against whatever the BOM planned.
    expect(Number(result.fabricVariance)).toBeCloseTo(
      500 - Number(order.plannedFabricQty), 4,
    );
  });

  it("keeps the ledger balanced through the whole lifecycle", async () => {
    const productionOrderId = await runOrder(100, "200");
    await completeProductionOrder(
      {
        productionOrderId, outputs: [{ variantId, goodQty: 100 }],
        locationId, entityId: factoryId, completedDate: day,
      },
      ctx,
    );

    const [row] = await db.$queryRaw<{ debit: string; credit: string }[]>`
      SELECT COALESCE(SUM(l."debit"), 0)::text AS debit,
             COALESCE(SUM(l."credit"), 0)::text AS credit
      FROM "journal_lines" l
      JOIN "journal_entries" e ON e."id" = l."journalEntryId"
      WHERE e."status" = 'POSTED'
    `;
    expect(row.debit).toBe(row.credit);
  });

  it("refuses to complete twice", async () => {
    const productionOrderId = await runOrder(100, "200");
    await completeProductionOrder(
      { productionOrderId, outputs: [{ variantId, goodQty: 100 }], locationId, entityId: factoryId, completedDate: day },
      ctx,
    );
    await expect(
      completeProductionOrder(
        { productionOrderId, outputs: [{ variantId, goodQty: 5 }], locationId, entityId: factoryId, completedDate: day },
        ctx,
      ),
    ).rejects.toThrow(/already complete/i);
  });

  it("refuses to complete an order that was never confirmed", async () => {
    const { productionOrderId } = await draftOrder();
    await expect(
      completeProductionOrder(
        { productionOrderId, outputs: [{ variantId, goodQty: 10 }], locationId, entityId: factoryId, completedDate: day },
        ctx,
      ),
    ).rejects.toThrow(/no frozen cost snapshot/i);
  });
});

/**
 * A run of a dress is cut in a curve: so many mediums, so many larges. What
 * comes off the line has to be booked that way, because that is how it will be
 * counted, transferred and sold.
 */
describe("output as a size curve", () => {
  it("books a lot per SKU and totals them as the order's output", async () => {
    const productionOrderId = await runOrder(100, "300");
    const curve = [40, 30, 20].slice(0, allVariantIds.length);
    const outputs = curve.map((goodQty, i) => ({ variantId: allVariantIds[i], goodQty }));
    const expected = outputs.reduce((s, o) => s + o.goodQty, 0);

    const result = await completeProductionOrder(
      { productionOrderId, outputs, locationId, entityId: factoryId, completedDate: day },
      ctx,
    );

    expect(result.goodQty).toBe(expected);
    expect(result.finishedLotNumbers).toHaveLength(outputs.length);

    const lots = await db.inventoryLot.findMany({
      where: { lotNumber: { in: result.finishedLotNumbers } },
    });
    expect(lots.map((l) => Number(l.remainingQty)).sort((a, b) => b - a)).toEqual(
      curve.slice().sort((a, b) => b - a),
    );

    const order = await db.productionOrder.findUniqueOrThrow({ where: { id: productionOrderId } });
    expect(order.actualQty).toBe(expected);
  });

  it("costs every size the same, because the snapshot costs the style", async () => {
    const productionOrderId = await runOrder(100, "300");
    const outputs = allVariantIds.slice(0, 2).map((variantId, i) => ({
      variantId, goodQty: i === 0 ? 60 : 30,
    }));

    const result = await completeProductionOrder(
      { productionOrderId, outputs, locationId, entityId: factoryId, completedDate: day },
      ctx,
    );

    const order = await db.productionOrder.findUniqueOrThrow({
      where: { id: productionOrderId }, include: { costSnapshot: true },
    });
    const lots = await db.inventoryLot.findMany({
      where: { lotNumber: { in: result.finishedLotNumbers } },
    });

    const frozen = order.costSnapshot!.factoryTotalCost.toString();
    for (const lot of lots) expect(lot.unitCost.toString()).toBe(frozen);

    // Splitting the run across sizes must not change what the run cost.
    const booked = lots.reduce((s, l) => s + Number(l.remainingQty) * Number(l.unitCost), 0);
    expect(booked).toBeCloseTo(90 * Number(frozen), 2);
  });

  it("keeps the ledger balanced when output is split", async () => {
    const productionOrderId = await runOrder(100, "300");
    await completeProductionOrder(
      {
        productionOrderId,
        outputs: allVariantIds.slice(0, 3).map((variantId, i) => ({
          variantId, goodQty: [50, 30, 15][i],
        })),
        locationId, entityId: factoryId, completedDate: day,
      },
      ctx,
    );

    const [row] = await db.$queryRaw<{ debit: string; credit: string }[]>`
      SELECT COALESCE(SUM(l."debit"), 0)::text AS debit,
             COALESCE(SUM(l."credit"), 0)::text AS credit
      FROM "journal_lines" l
      JOIN "journal_entries" e ON e."id" = l."journalEntryId"
      WHERE e."status" = 'POSTED'
    `;
    expect(row.debit).toBe(row.credit);
  });

  it("refuses the same SKU listed twice", async () => {
    const productionOrderId = await runOrder(100, "300");
    await expect(
      completeProductionOrder(
        {
          productionOrderId,
          outputs: [
            { variantId, goodQty: 10 },
            { variantId, goodQty: 5 },
          ],
          locationId, entityId: factoryId, completedDate: day,
        },
        ctx,
      ),
    ).rejects.toThrow(/twice/i);
  });

  it("refuses a SKU belonging to another style", async () => {
    const productionOrderId = await runOrder(100, "300");
    const stranger = await db.variant.findFirstOrThrow({
      where: { styleId: { not: styleId } },
    });

    await expect(
      completeProductionOrder(
        {
          productionOrderId,
          outputs: [{ variantId: stranger.id, goodQty: 10 }],
          locationId, entityId: factoryId, completedDate: day,
        },
        ctx,
      ),
    ).rejects.toThrow(/not a SKU of the style/i);
  });

  it("refuses fractions of a garment", async () => {
    const productionOrderId = await runOrder(100, "300");
    await expect(
      completeProductionOrder(
        {
          productionOrderId,
          outputs: [{ variantId, goodQty: 10.5 }],
          locationId, entityId: factoryId, completedDate: day,
        },
        ctx,
      ),
    ).rejects.toThrow(/whole/i);
  });

  it("refuses an empty curve", async () => {
    const productionOrderId = await runOrder(100, "300");
    await expect(
      completeProductionOrder(
        {
          productionOrderId,
          outputs: [{ variantId, goodQty: 0 }],
          locationId, entityId: factoryId, completedDate: day,
        },
        ctx,
      ),
    ).rejects.toThrow(/greater than zero/i);
  });
});
