import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { receiveFinishedGoods } from "./inventory";
import { transferToBrand } from "./intercompany";
import { collectionPerformance } from "./analytics";
import { createSale } from "./sales";
import { dec } from "./money";

/**
 * The same collection through each side's eyes.
 *
 * The Factory made the garment and invoiced it to the Brand at transfer price.
 * The Brand paid that price and sold it in the shop. Their revenues, costs and
 * margins are all different numbers, and reporting one set to both — which is
 * what the styles screen did — is how a collection ends up looking profitable
 * on a margin the Factory earned and the Brand paid for.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const FACTORY_COST = 600;
const TRANSFER_PRICE = 750; // the Factory earns 150 a piece
const RETAIL_PRICE = 1200; // the Brand earns 450 a piece
const MADE = 100;
const TRANSFERRED = 80; // twenty stay at the factory
const SOLD = 5;

let factoryId: string;
let brandId: string;
let collectionId: string;
let styleId: string;
let variantId: string;
let otherStyleId: string;
let otherVariantId: string;
let factoryLocationId: string;
let showroomId: string;
let channelId: string;
let minuteRatePeriodId: string;
let day: Date;

const ctx = { userId: null as string | null, reason: null };

beforeAll(async () => {
  factoryId = (await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } })).id;
  brandId = (await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } })).id;
  factoryLocationId = (await db.location.findFirstOrThrow({ where: { code: "LOC-FAC" } })).id;
  showroomId = (await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } })).id;
  channelId = (await db.salesChannel.findFirstOrThrow({ where: { kind: "RETAIL_STORE" } })).id;

  // Two styles in one collection, so "best" and "most produced" have something
  // to choose between.
  const variants = await db.variant.findMany({
    take: 2,
    orderBy: { sku: "asc" },
    include: { style: true },
  });
  variantId = variants[0].id;
  styleId = variants[0].styleId;
  collectionId = variants[0].style.collectionId;

  const other = variants.find((v) => v.styleId !== styleId);
  otherVariantId = other?.id ?? variants[1].id;
  otherStyleId = other?.styleId ?? variants[1].styleId;

  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" },
    orderBy: { startDate: "asc" },
  });
  day = new Date(period.startDate);

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
    await db.salesPayment.deleteMany({});
    await db.salesOrderLine.deleteMany({});
    await db.return.deleteMany({});
    await db.salesOrder.deleteMany({});
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
afterAll(async () => {
  await wipe();
  await db.$disconnect();
});

/** A finished run at the factory, costed the way production costs it. */
async function produce(
  options: {
    styleId?: string;
    variantId?: string;
    quantity?: number;
    unitCost?: number;
    transferPrice?: number;
  } = {},
) {
  const style = options.styleId ?? styleId;
  const quantity = options.quantity ?? MADE;
  const unitCost = options.unitCost ?? FACTORY_COST;

  const snapshot = await db.costSnapshot.create({
    data: {
      styleId: style, minuteRatePeriodId,
      minuteRate: "1.5078", fullCapacityRate: "1.2", smvMinutes: "39",
      wasteRate: "0.1", factoryMarginPct: "0.25",
      fabricCost: String(unitCost - 60), trimCost: "10",
      materialCost: String(unitCost - 50),
      cmtCost: "50", factoryTotalCost: String(unitCost),
      transferPrice: String(options.transferPrice ?? TRANSFER_PRICE),
      idleCapacityPenalty: "12",
    },
  });

  const order = await db.productionOrder.create({
    data: {
      orderNumber: `PO-COL-${Math.random().toString(36).slice(2, 10)}`,
      styleId: style, status: "COMPLETED",
      plannedQty: quantity, actualQty: quantity,
      orderDate: day, costSnapshotId: snapshot.id,
      actualTotalCost: String(unitCost * quantity),
    },
  });

  await receiveFinishedGoods(
    {
      variantId: options.variantId ?? variantId,
      locationId: factoryLocationId, entityId: factoryId,
      quantity: String(quantity),
      unitCost: String(unitCost),
      materialUnitCost: String(unitCost - 50),
      receivedDate: day,
      productionOrderId: order.id,
    },
    ctx,
  );

  // The transfer is priced from this, not from anything typed later.
  return snapshot.id;
}

/** Invoice part of the run across to the brand at the frozen transfer price. */
async function transfer(snapshotId: string, quantity = TRANSFERRED, variant = variantId) {
  await transferToBrand(
    {
      variantId: variant,
      fromLocationId: factoryLocationId,
      toLocationId: showroomId,
      quantity: String(quantity),
      transferDate: day,
      costSnapshotId: snapshotId,
    },
    ctx,
  );
}

/** Sell some of it in the shop. */
async function sell(quantity = SOLD, variant = variantId, price = RETAIL_PRICE) {
  await createSale(
    {
      source: "MANUAL",
      entityId: brandId,
      channelId,
      locationId: showroomId,
      orderDate: day,
      lines: [{ variantId: variant, quantity, retailPrice: price }],
      payments: [{ method: "CASH", amount: price * quantity }],
    },
    ctx,
  );
}

const forFactory = () => collectionPerformance(factoryId, "FACTORY");
const forBrand = () => collectionPerformance(brandId, "BRAND");
const ours = <T extends { id: string }>(rows: T[]) => rows.find((r) => r.id === collectionId)!;

describe("the two sides do not report the same collection", () => {
  it("gives the factory the transfer price as its revenue", async () => {
    const run = await produce();
    await transfer(run);

    const row = ours(await forFactory());

    // Eighty pieces invoiced at 750. The twenty still standing at the factory
    // have earned it nothing yet.
    expect(Number(row.revenue)).toBe(TRANSFERRED * TRANSFER_PRICE);
    expect(Number(row.cost)).toBe(TRANSFERRED * FACTORY_COST);
    expect(Number(row.grossMargin)).toBe(TRANSFERRED * (TRANSFER_PRICE - FACTORY_COST));
  });

  it("gives the brand the till as its revenue and the transfer price as its cost", async () => {
    const run = await produce();
    await transfer(run);
    await sell();

    const row = ours(await forBrand());

    expect(Number(row.revenue)).toBe(SOLD * RETAIL_PRICE);
    expect(Number(row.cost)).toBe(SOLD * TRANSFER_PRICE);
    expect(Number(row.grossMargin)).toBe(SOLD * (RETAIL_PRICE - TRANSFER_PRICE));
  });

  it("does not report one margin to both", async () => {
    const run = await produce();
    await transfer(run);
    await sell();

    const factory = ours(await forFactory());
    const brand = ours(await forBrand());

    // This is the whole complaint: the two screens were showing the same
    // figures, so the Brand was reading the Factory's manufacturing margin.
    expect(Number(factory.grossMargin)).not.toBe(Number(brand.grossMargin));
    expect(Number(factory.revenue)).not.toBe(Number(brand.revenue));
  });

  it("ties the two sides together: what the factory billed is what the brand holds plus what it sold", async () => {
    const run = await produce();
    await transfer(run);
    await sell();

    const factory = ours(await forFactory());
    const brand = ours(await forBrand());

    // Every garment the factory invoiced is either through the brand's till or
    // still on its shelf. If these drift apart, something crossed the house
    // without being paid for on one side.
    const accountedFor = brand.cost.plus(brand.onHandValue);
    expect(Number(accountedFor)).toBeCloseTo(Number(factory.revenue), 2);
  });
});

describe("sell-through means a different thing on each side", () => {
  it("measures the factory against what it made", async () => {
    const run = await produce(); // 100
    await transfer(run); // 80 leave

    const row = ours(await forFactory());

    expect(row.produced).toBe(MADE);
    expect(Number(row.sellThrough)).toBeCloseTo(TRANSFERRED / MADE, 4); // 0.8
  });

  it("measures the brand against what actually reached it", async () => {
    const run = await produce(); // 100 made
    await transfer(run); // only 80 arrived
    await sell(); // 5 sold

    const row = ours(await forBrand());

    // 5 of 80, not 5 of 100. Judging the shop on garments that never arrived
    // reports a sell-through failure against whoever kept them.
    expect(Number(row.sellThrough)).toBeCloseTo(SOLD / TRANSFERRED, 4);
    expect(Number(row.sellThrough)).not.toBeCloseTo(SOLD / MADE, 4);
  });
});

describe("which product to repeat", () => {
  it("names the best by what it earned, not by how many moved", async () => {
    if (otherStyleId === styleId) return;

    const run = await produce({ quantity: 20 });
    await transfer(run, 20);
    const otherRun = await produce({
      styleId: otherStyleId, variantId: otherVariantId, quantity: 20,
    });
    await transfer(otherRun, 20, otherVariantId);

    // Twelve cheap pieces against three expensive ones. Ranking on units would
    // pick the wrong one and the collection gets repeated on it.
    await sell(12, variantId, 800); // 12 × (800 − 750) = 600
    await sell(3, otherVariantId, 2000); // 3 × (2000 − 750) = 3750

    const row = ours(await forBrand());

    expect(row.best?.id).toBe(otherStyleId);
    expect(Number(row.best?.grossMargin)).toBe(3750);
  });

  it("names the most produced separately from the best", async () => {
    if (otherStyleId === styleId) return;

    const run = await produce({ quantity: 200 }); // a lot of it made
    await transfer(run, 10);
    const otherRun = await produce({
      styleId: otherStyleId, variantId: otherVariantId, quantity: 20,
    });
    await transfer(otherRun, 20, otherVariantId);

    await sell(1, variantId, 800);
    await sell(10, otherVariantId, 2000);

    const row = ours(await forBrand());

    expect(row.mostProduced?.id).toBe(styleId);
    expect(row.mostProduced?.produced).toBe(200);
    // The one made most is not the one earning most, which is the point of
    // showing both.
    expect(row.best?.id).toBe(otherStyleId);
  });

  it("names the slowest mover, because that is where the cash is stuck", async () => {
    if (otherStyleId === styleId) return;

    const run = await produce({ quantity: 50 });
    await transfer(run, 50);
    const otherRun = await produce({
      styleId: otherStyleId, variantId: otherVariantId, quantity: 50,
    });
    await transfer(otherRun, 50, otherVariantId);

    await sell(40, variantId); // 80% away
    await sell(2, otherVariantId); // 4% away

    const row = ours(await forBrand());

    expect(row.worst?.id).toBe(otherStyleId);
  });

  it("costs a production run per piece", async () => {
    await produce({ quantity: 40, unitCost: 500 });

    const row = ours(await forFactory());

    expect(Number(row.mostProduced?.costPerPiece)).toBe(500);
  });
});

describe("what the report leaves out", () => {
  it("drops a collection nobody has made or sold anything from", async () => {
    // Nothing produced at all.
    const rows = await forFactory();
    expect(rows.find((r) => r.id === collectionId)).toBeUndefined();
  });

  it("keeps a collection that is made but unsold, because that is the problem", async () => {
    const run = await produce();
    await transfer(run);

    const row = ours(await forBrand());

    // Eighty pieces sitting in the shop having earned nothing. A report that
    // hid this would hide the reason the money is gone.
    expect(Number(row.revenue)).toBe(0);
    expect(Number(row.onHand)).toBe(TRANSFERRED);
    expect(Number(row.onHandValue)).toBe(TRANSFERRED * TRANSFER_PRICE);
    expect(row.marginPct).toBeNull();
  });

  it("counts nothing for the brand until the goods have crossed", async () => {
    await produce(); // made, but never transferred

    const brand = ours(await forBrand());
    const factory = ours(await forFactory());

    expect(Number(brand.onHandValue)).toBe(0);
    expect(Number(brand.revenue)).toBe(0);
    // The factory is holding all hundred of them at its own cost.
    expect(Number(factory.onHandValue)).toBe(MADE * FACTORY_COST);
    expect(Number(factory.revenue)).toBe(0);
  });
});
