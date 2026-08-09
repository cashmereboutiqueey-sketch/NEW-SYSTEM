import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { receiveFinishedGoods } from "./inventory";
import { awaitingTransfer, recentTransfers, transferToBrand } from "./intercompany";
import { sellableStock } from "./pos";

/**
 * The handover screen.
 *
 * Garments made at the factory belong to the factory. Until they are invoiced
 * to the brand they cannot be sold, and a till showing an empty shelf is the
 * only symptom. These tests hold the queue honest: what is waiting, at what
 * price, and that transferring it actually puts it on the shelf.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const COST_PER_GARMENT = 602.8638;
const MATERIAL_PER_GARMENT = 544.06;
const TRANSFER_PRICE = 711.3792;
const MADE = 116;

let factoryId: string;
let brandId: string;
let styleId: string;
let variantId: string;
let otherVariantId: string;
let factoryLocationId: string;
let showroomId: string;
let minuteRatePeriodId: string;
let day: Date;

const ctx = { userId: null as string | null, reason: null };

beforeAll(async () => {
  factoryId = (await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } })).id;
  brandId = (await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } })).id;
  factoryLocationId = (await db.location.findFirstOrThrow({ where: { code: "LOC-FAC" } })).id;
  showroomId = (await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } })).id;

  const variants = await db.variant.findMany({ take: 2, orderBy: { sku: "asc" } });
  variantId = variants[0].id;
  otherVariantId = variants[1].id;
  styleId = variants[0].styleId;

  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" }, orderBy: { startDate: "asc" },
  });
  day = new Date(period.startDate);

  // A snapshot has to point at the rate it was costed from. The figures here
  // are not under test; only that the link exists.
  minuteRatePeriodId = (
    await db.minuteRatePeriod.upsert({
      where: { entityId_fiscalPeriodId: { entityId: factoryId, fiscalPeriodId: period.id } },
      update: {},
      create: {
        entityId: factoryId, fiscalPeriodId: period.id,
        operators: 40, workingDays: "26", hoursPerDay: "9",
        utilisationRate: "0.85", efficiencyRate: "0.75",
        totalConversionCost: "364000", netCostPool: "364000",
        grossAvailableMinutes: "561600", productiveMinutes: "358020",
        actualMinuteRate: "1.5078", fullCapacityMinuteRate: "0.6481",
        idlePenaltyPerMinute: "0.8597", idleMinutes: "203580",
      },
    })
  ).id;
});

async function wipe() {
  await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
  await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
  try {
    await db.inventoryMovement.deleteMany({});
    await db.inventoryLot.deleteMany({});
    await db.productionOrder.deleteMany({});
    await db.costSnapshotLine.deleteMany({});
    await db.costSnapshot.deleteMany({});
    await db.journalLine.deleteMany({});
    await db.journalEntry.deleteMany({});
    await db.auditLog.deleteMany({});
    await db.documentSequence.deleteMany({});
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
  }
}

beforeEach(wipe);
afterAll(async () => { await wipe(); await db.$disconnect(); });

/** A run of garments finished at the factory, costed the way production costs them. */
async function makeGarments(
  options: { variantId?: string; quantity?: number; transferPrice?: number; withSnapshot?: boolean } = {},
) {
  const quantity = options.quantity ?? MADE;

  let snapshotId: string | null = null;
  if (options.withSnapshot !== false) {
    const snapshot = await db.costSnapshot.create({
      data: {
        styleId, minuteRatePeriodId,
        minuteRate: "1.5078", fullCapacityRate: "1.2", smvMinutes: "39",
        wasteRate: "0.1", factoryMarginPct: "0.18",
        fabricCost: "540", trimCost: "4.06", materialCost: String(MATERIAL_PER_GARMENT),
        cmtCost: "58.8038", factoryTotalCost: String(COST_PER_GARMENT),
        transferPrice: String(options.transferPrice ?? TRANSFER_PRICE),
        idleCapacityPenalty: "12",
      },
    });
    snapshotId = snapshot.id;
  }

  const order = await db.productionOrder.create({
    data: {
      orderNumber: `PO-TEST-${Math.random().toString(36).slice(2, 10)}`,
      styleId, status: "COMPLETED", plannedQty: quantity, actualQty: quantity,
      orderDate: day, costSnapshotId: snapshotId,
    },
  });

  await receiveFinishedGoods(
    {
      variantId: options.variantId ?? variantId,
      locationId: factoryLocationId, entityId: factoryId,
      quantity: String(quantity),
      unitCost: String(COST_PER_GARMENT),
      materialUnitCost: String(MATERIAL_PER_GARMENT),
      receivedDate: day,
      productionOrderId: order.id,
    },
    ctx,
  );

  return { snapshotId };
}

describe("what is waiting to be transferred", () => {
  it("lists garments finished at the factory", async () => {
    await makeGarments();

    const queue = await awaitingTransfer();

    expect(queue).toHaveLength(1);
    expect(queue[0].quantity).toBe("116");
    expect(queue[0].locationId).toBe(factoryLocationId);
    expect(queue[0].blockedReason).toBeNull();
  });

  it("prices from the snapshot frozen before the run, not from anything typed", async () => {
    await makeGarments();

    const [row] = await awaitingTransfer();

    expect(row.transferPrice).toBe("711.3792");
    // 711.3792 − 602.8638
    expect(Number(row.marginPerUnit)).toBeCloseTo(108.5154, 4);
    expect(Number(row.factoryCost)).toBeCloseTo(COST_PER_GARMENT * MADE, 2);
  });

  it("blocks a run that was made without a frozen cost", async () => {
    await makeGarments({ withSnapshot: false });

    const [row] = await awaitingTransfer();

    // There is no defensible internal price, so the screen refuses rather than
    // inventing one after the fact.
    expect(row.blockedReason).toBe("NO_SNAPSHOT");
    expect(row.costSnapshotId).toBeNull();
    expect(row.transferPrice).toBeNull();
  });

  it("keeps runs costed differently apart instead of averaging them", async () => {
    await makeGarments({ quantity: 10, transferPrice: 700 });
    await makeGarments({ quantity: 10, transferPrice: 900 });

    const queue = await awaitingTransfer();

    expect(queue).toHaveLength(2);
    expect(queue.map((r) => r.transferPrice).sort()).toEqual(["700", "900"]);
  });

  it("merges lots of the same SKU that share a price into one movement", async () => {
    const { snapshotId } = await makeGarments({ quantity: 10 });
    const order = await db.productionOrder.create({
      data: {
        orderNumber: "PO-TEST-SECOND", styleId, status: "COMPLETED",
        plannedQty: 5, actualQty: 5, orderDate: day, costSnapshotId: snapshotId,
      },
    });
    await receiveFinishedGoods(
      {
        variantId, locationId: factoryLocationId, entityId: factoryId,
        quantity: "5", unitCost: String(COST_PER_GARMENT),
        materialUnitCost: String(MATERIAL_PER_GARMENT),
        receivedDate: day, productionOrderId: order.id,
      },
      ctx,
    );

    const queue = await awaitingTransfer();

    expect(queue).toHaveLength(1);
    expect(queue[0].quantity).toBe("15");
  });

  it("ignores stock the brand already holds", async () => {
    await makeGarments();
    const [row] = await awaitingTransfer();

    await transferToBrand(
      {
        variantId, quantity: row.quantity,
        fromLocationId: factoryLocationId, toLocationId: showroomId,
        transferDate: day, costSnapshotId: row.costSnapshotId!,
      },
      ctx,
    );

    expect(await awaitingTransfer()).toHaveLength(0);
  });
});

describe("transferring puts stock where it can be sold", () => {
  it("moves garments from the factory queue onto the shop floor", async () => {
    await makeGarments();

    expect(await sellableStock(showroomId, brandId)).toHaveLength(0);

    const [row] = await awaitingTransfer();
    await transferToBrand(
      {
        variantId, quantity: row.quantity,
        fromLocationId: factoryLocationId, toLocationId: showroomId,
        transferDate: day, costSnapshotId: row.costSnapshotId!,
      },
      ctx,
    );

    const shelf = await sellableStock(showroomId, brandId);
    expect(shelf).toHaveLength(1);
    expect(shelf[0].available).toBe("116");
  });

  it("leaves the rest behind on a partial transfer", async () => {
    await makeGarments();
    const [row] = await awaitingTransfer();

    await transferToBrand(
      {
        variantId, quantity: "40",
        fromLocationId: factoryLocationId, toLocationId: showroomId,
        transferDate: day, costSnapshotId: row.costSnapshotId!,
      },
      ctx,
    );

    const still = await awaitingTransfer();
    expect(still).toHaveLength(1);
    expect(still[0].quantity).toBe("76");

    const shelf = await sellableStock(showroomId, brandId);
    expect(shelf[0].available).toBe("40");
  });

  it("refuses to transfer more than the factory holds", async () => {
    await makeGarments({ quantity: 10 });
    const [row] = await awaitingTransfer();

    await expect(
      transferToBrand(
        {
          variantId, quantity: "11",
          fromLocationId: factoryLocationId, toLocationId: showroomId,
          transferDate: day, costSnapshotId: row.costSnapshotId!,
        },
        ctx,
      ),
    ).rejects.toThrow(/does not hold enough/i);

    // Nothing partial was left behind by the failure.
    expect(await sellableStock(showroomId, brandId)).toHaveLength(0);
    expect((await awaitingTransfer())[0].quantity).toBe("10");
  });
});

describe("the history the screen shows", () => {
  it("reports each invoice with the margin still sitting in unsold stock", async () => {
    await makeGarments({ quantity: 10 });
    const [row] = await awaitingTransfer();

    const result = await transferToBrand(
      {
        variantId, quantity: "10",
        fromLocationId: factoryLocationId, toLocationId: showroomId,
        transferDate: day, costSnapshotId: row.costSnapshotId!,
      },
      ctx,
    );

    const [entry] = await recentTransfers();

    expect(entry.transferNumber).toBe(result.transferNumber);
    expect(entry.quantity).toBe("10");
    expect(Number(entry.total)).toBeCloseTo(TRANSFER_PRICE * 10, 2);
    // None sold yet, so the whole internal margin is unearned by the group.
    expect(entry.unsoldQty).toBe("10");
    expect(Number(entry.marginPerUnit)).toBeCloseTo(108.5154, 4);
  });

  it("is empty before anything moves", async () => {
    await makeGarments({ variantId: otherVariantId, quantity: 5 });

    expect(await recentTransfers()).toEqual([]);
  });
});
