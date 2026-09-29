import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { startCustomOrderRun, takeOrderToMake } from "./made-to-order";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});
const ctx = { userId: null as string | null, reason: null };

let brandId: string;
let factoryId: string;
let showroomId: string;
let factoryLocationId: string;
let variantId: string;
let styleId: string;
let materialIds: string[];
let customerId: string;
let day: Date;

beforeAll(async () => {
  brandId = (await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } })).id;
  factoryId = (await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } })).id;
  showroomId = (await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } })).id;
  factoryLocationId = (await db.location.findFirstOrThrow({ where: { code: "LOC-FAC" } })).id;
  const style = await db.style.findFirstOrThrow({
    where: { bomLines: { some: {} }, operations: { some: {} } },
    include: { bomLines: true, variants: true },
    orderBy: { code: "asc" },
  });
  styleId = style.id;
  variantId = style.variants[0].id;
  materialIds = style.bomLines.map((line) => line.materialId);
  day = new Date((await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" }, orderBy: { startDate: "asc" },
  })).startDate);
});

async function wipe() {
  await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
  await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
  try {
    await db.customOrder.deleteMany({});
    await db.productionOrderLine.deleteMany({});
    await db.productionOrder.deleteMany({});
    await db.inventoryLot.deleteMany({});
    await db.journalLine.deleteMany({});
    await db.journalEntry.deleteMany({});
    await db.auditLog.deleteMany({});
    await db.documentSequence.deleteMany({});
    await db.customer.deleteMany({ where: { code: "MTO-UAT" } });
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
  }
}

beforeEach(async () => {
  await wipe();
  customerId = (await db.customer.create({
    data: { code: "MTO-UAT", name: "Made to order test customer" },
  })).id;
});
afterAll(async () => { await wipe(); await db.$disconnect(); });

async function stockAllMaterials() {
  for (const [index, materialId] of materialIds.entries()) {
    await db.inventoryLot.create({
      data: {
        lotNumber: `MTO-UAT-${index}`,
        state: "RAW_MATERIAL",
        materialId,
        locationId: factoryLocationId,
        entityId: factoryId,
        originalQty: "1000",
        remainingQty: "1000",
        unitCost: "10",
        receivedDate: day,
      },
    });
  }
}

function order(raiseRun: boolean) {
  return takeOrderToMake({
    customerId, variantId, quantity: 1,
    agreedUnitPrice: "2500",
    deposit: { amount: "500", method: "CASH" },
    entityId: brandId, locationId: showroomId,
    orderDate: day,
    promisedDate: new Date(day.getTime() + 14 * 86_400_000),
    raiseRun,
  }, ctx);
}

describe("made to order production handoff", () => {
  it("creates a linked draft run alongside a new customer promise and deposit", async () => {
    await stockAllMaterials();
    const taken = await order(true);
    const promise = await db.customOrder.findUniqueOrThrow({
      where: { id: taken.customOrderId }, include: { productionOrder: true },
    });
    expect(Number(taken.deposit)).toBe(500);
    expect(taken.runNumber).toBe(promise.productionOrder?.orderNumber);
    expect(promise.status).toBe("IN_PRODUCTION");
    expect(promise.productionOrder?.status).toBe("DRAFT");
    expect(promise.productionOrder?.styleId).toBe(styleId);
  });

  it("starts one run for an existing pending promise", async () => {
    await stockAllMaterials();
    const taken = await order(false);
    expect(taken.runNumber).toBeNull();

    const started = await startCustomOrderRun({ customOrderId: taken.customOrderId }, ctx);
    expect(started.runNumber).toMatch(/^PO-/);
    expect((await db.customOrder.findUniqueOrThrow({
      where: { id: taken.customOrderId },
    })).status).toBe("IN_PRODUCTION");
    await expect(startCustomOrderRun({ customOrderId: taken.customOrderId }, ctx))
      .rejects.toThrow(/no longer waiting/);
    expect(await db.productionOrder.count()).toBe(1);
  });

  it("keeps the promise pending when material is unavailable", async () => {
    const taken = await order(true);
    expect(taken.runNumber).toBeNull();
    expect(taken.runSkippedBecause).toMatch(/cloth on hand/);
    expect((await db.customOrder.findUniqueOrThrow({ where: { id: taken.customOrderId } })).status)
      .toBe("PENDING");
  });
});
