import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { receiveMaterial, issueMaterialToProduction } from "./inventory";
import { recordScrap } from "./scrap";
import { fabricLedger, fabricTotals } from "./fabric-ledger";

/**
 * Bought, drawn, left — for each material in the factory store.
 *
 * All three are already recorded: a lot keeps the quantity it arrived with
 * beside the quantity left, and every movement says where the cloth went.
 * Nothing here is estimated.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let factoryId: string;
let storeId: string;
let fabricId: string;
let ownerId: string;
let day: Date;

const ctx = { userId: null as string | null, reason: null };

beforeAll(async () => {
  factoryId = (await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } })).id;
  storeId = (await db.location.findFirstOrThrow({ where: { code: "LOC-FAC" } })).id;
  fabricId = (await db.material.findFirstOrThrow({ where: { type: "FABRIC" } })).id;
  ownerId = (await db.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;

  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" },
    orderBy: { startDate: "asc" },
  });
  day = new Date(period.startDate);
});

async function wipe() {
  await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
  await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
  try {
    await db.scrapRecord.deleteMany({});
    await db.materialIssue.deleteMany({});
    await db.inventoryMovement.deleteMany({});
    await db.inventoryLot.deleteMany({});
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

const receive = (quantity: number, unitCost: number, when = day) =>
  receiveMaterial(
    {
      materialId: fabricId, locationId: storeId, entityId: factoryId,
      quantity: String(quantity), unitCost: String(unitCost), receivedDate: when,
    },
    ctx,
  );

const issue = (quantity: number) =>
  issueMaterialToProduction(
    {
      materialId: fabricId, locationId: storeId, entityId: factoryId,
      quantity: String(quantity), issueDate: day,
    },
    ctx,
  );

const scrap = (quantity: number) =>
  recordScrap(
    {
      materialId: fabricId, locationId: storeId, entityId: factoryId,
      disposition: "DISCARDED", quantity, scrapDate: day,
    },
    { userId: ownerId, reason: null },
  );

/**
 * A delivery that arrived months ago.
 *
 * Received normally and then back-dated on the lot, because receiving posts a
 * journal and a journal cannot be posted into a closed period — the system
 * refuses that, rightly. Ageing reads the lot's received date, so moving that
 * is what this is actually testing.
 */
async function ageTheFirstLot(days: number) {
  await receive(50, 100);
  const lot = await db.inventoryLot.findFirstOrThrow({
    where: { materialId: fabricId, locationId: storeId },
    orderBy: { sequence: "asc" },
  });
  await db.inventoryLot.update({
    where: { id: lot.id },
    data: { receivedDate: new Date(day.getTime() - days * 86_400_000) },
  });
}

const ledger = () => fabricLedger(factoryId, { materialType: "ALL", includeFinished: true });
const ours = async () => (await ledger()).find((r) => r.materialId === fabricId)!;

describe("bought, drawn, left", () => {
  it("reports what arrived", async () => {
    await receive(100, 200);

    const row = await ours();
    expect(Number(row.purchased)).toBe(100);
    expect(Number(row.remaining)).toBe(100);
    expect(Number(row.drawn)).toBe(0);
  });

  it("adds up separate deliveries of the same cloth", async () => {
    await receive(100, 200);
    await receive(60, 250);

    const row = await ours();
    expect(Number(row.purchased)).toBe(160);
    expect(row.deliveries).toBe(2);
  });

  it("takes the drawdown off the shelf, not off what was bought", async () => {
    await receive(100, 200);
    await issue(30);

    const row = await ours();
    // What was bought does not change because some of it was used.
    expect(Number(row.purchased)).toBe(100);
    expect(Number(row.remaining)).toBe(70);
    expect(Number(row.drawn)).toBe(30);
  });

  it("values what is left at what it actually cost", async () => {
    await receive(100, 200);
    await issue(30);

    const row = await ours();
    expect(Number(row.value)).toBe(70 * 200);
    expect(Number(row.averageCost)).toBe(200);
  });

  it("prices the remainder off the newer roll once the older one is gone", async () => {
    await receive(40, 100);
    await receive(60, 300);
    await issue(40); // consumes the cheap roll entirely

    const row = await ours();
    expect(Number(row.remaining)).toBe(60);
    // Sixty metres of the dear cloth, not an average of the two.
    expect(Number(row.averageCost)).toBe(300);
    expect(Number(row.value)).toBe(60 * 300);
  });
});

describe("where the cloth went", () => {
  it("separates what went into production from what was thrown away", async () => {
    await receive(100, 200);
    await issue(30);
    await scrap(5);

    const row = await ours();
    expect(Number(row.movements.toProduction)).toBe(30);
    expect(Number(row.movements.scrapped)).toBe(5);
    expect(Number(row.drawn)).toBe(35);
  });

  it("explains the whole drawdown, with nothing unaccounted for", async () => {
    await receive(100, 200);
    await issue(30);
    await scrap(5);

    const row = await ours();
    const explained = row.movements.toProduction
      .plus(row.movements.scrapped)
      .plus(row.movements.transferredOut);

    // If these ever part company, the ledger is telling a story the lots do
    // not support.
    expect(Number(explained)).toBe(Number(row.drawn));
  });

  it("works out how much of what was bought has been used", async () => {
    await receive(100, 200);
    await issue(25);

    expect(Number((await ours()).usedPct)).toBeCloseTo(0.25, 6);
  });
});

describe("the shelf", () => {
  it("hides a material that has run out", async () => {
    await receive(100, 200);
    await issue(100);

    const shelf = await fabricLedger(factoryId, { materialType: "ALL" });
    expect(shelf.find((r) => r.materialId === fabricId)).toBeUndefined();
  });

  it("keeps it when the history is asked for", async () => {
    await receive(100, 200);
    await issue(100);

    const row = await ours();
    expect(Number(row.remaining)).toBe(0);
    expect(Number(row.purchased)).toBe(100);
    // No cloth left, so no average cost to report — zero would claim it is
    // free.
    expect(row.averageCost).toBeNull();
  });

  it("ages the oldest lot that still has cloth in it", async () => {
    await ageTheFirstLot(120);
    await receive(50, 100);

    const row = await ours();
    expect(row.oldestAgeDays).toBeGreaterThanOrEqual(120);
  });

  it("stops counting an old lot once it is empty", async () => {
    await ageTheFirstLot(120);
    await receive(50, 100);
    await issue(50); // FIFO empties the old one

    const row = await ours();
    // The cash is no longer stuck in it, so it should not be reported as
    // standing.
    expect(row.oldestAgeDays).toBeLessThan(120);
  });
});

describe("the totals", () => {
  it("adds the materials up", async () => {
    await receive(100, 200);
    await issue(30);

    const totals = fabricTotals(await ledger());
    expect(Number(totals.purchased)).toBeGreaterThanOrEqual(100);
    expect(Number(totals.drawn)).toBeGreaterThanOrEqual(30);
    expect(Number(totals.remaining)).toBeGreaterThanOrEqual(70);
  });

  it("says what share of everything bought is still standing", async () => {
    await receive(100, 200);
    await issue(40);

    const totals = fabricTotals(await ledger());
    expect(Number(totals.stillOnShelf)).toBeCloseTo(0.6, 6);
  });

  it("does not fall over on an empty store", async () => {
    const totals = fabricTotals(await ledger());
    expect(totals.materials).toBe(0);
    expect(totals.stillOnShelf).toBeNull();
  });
});
