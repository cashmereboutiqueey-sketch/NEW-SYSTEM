import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { receiveMaterial } from "./inventory";
import { recordScrap, ScrapError, scrappableMaterials } from "./scrap";
import { scrapReport } from "./factory-floor";
import { dec } from "./money";

/**
 * Cloth that came off the cutting table.
 *
 * Scrap is not free: the fabric was bought, landed and paid for, and when it
 * leaves as offcuts it has to leave inventory at what it actually cost. The
 * chart of accounts carried 5400 from the first migration and nothing ever
 * posted to it, so the scrap screen could only say "no scrap has been
 * recorded" — which is not the same claim as "no scrap happened".
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const UNIT_COST = 200;
const RECEIVED = 100;

let factoryId: string;
let storeId: string;
let materialId: string;
let ownerId: string;
let day: Date;

const ctx = { userId: null as string | null, reason: null };

beforeAll(async () => {
  factoryId = (await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } })).id;
  storeId = (await db.location.findFirstOrThrow({ where: { code: "LOC-FAC" } })).id;
  materialId = (await db.material.findFirstOrThrow({ where: { type: "FABRIC" } })).id;
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

/** Cloth on the shelf at a known cost. */
async function stock(quantity = RECEIVED, unitCost = UNIT_COST) {
  await receiveMaterial(
    {
      materialId,
      locationId: storeId,
      entityId: factoryId,
      quantity: String(quantity),
      unitCost: String(unitCost),
      receivedDate: day,
    },
    ctx,
  );
}

const scrap = (
  quantity: number,
  disposition: "DISCARDED" | "SOLD" | "USED_FOR_SAMPLING" | "RETURNED_TO_STOCK" = "DISCARDED",
  salvageValue = 0,
) =>
  recordScrap(
    {
      materialId, locationId: storeId, entityId: factoryId,
      disposition, quantity, salvageValue, scrapDate: day,
    },
    { userId: ownerId, reason: null },
  );

const onHand = async () =>
  (await db.inventoryLot.aggregate({
    where: { materialId, locationId: storeId },
    _sum: { remainingQty: true },
  }))._sum.remainingQty;

const balanceOf = async (code: string) => {
  const rows = await db.$queryRaw<{ total: string }[]>`
    SELECT COALESCE(SUM(l."debit") - SUM(l."credit"), 0)::text AS total
    FROM "journal_lines" l
    JOIN "journal_entries" e ON e."id" = l."journalEntryId"
    JOIN "accounts" a ON a."id" = l."accountId"
    WHERE a."code" = ${code} AND e."status" = 'POSTED'
  `;
  return dec(rows[0]?.total ?? 0);
};

describe("cloth off the table leaves stock at what it cost", () => {
  it("takes the metres out of inventory", async () => {
    await stock();
    await scrap(10);

    expect(Number(await onHand())).toBe(RECEIVED - 10);
  });

  it("values it at FIFO rather than at anything typed in", async () => {
    // Two deliveries at different prices. Ten metres of scrap comes off the
    // older, cheaper roll, not off an average.
    await stock(6, 100);
    await stock(50, 300);

    const result = await scrap(10);

    // 6 × 100 + 4 × 300 = 1,800
    expect(Number(result.bookValue)).toBe(1800);
  });

  it("charges the loss to 5400 and credits the fabric out of 1310", async () => {
    await stock();
    await scrap(10); // 10 × 200 = 2,000

    expect(Number(await balanceOf("5400"))).toBe(2000);
    // Received 100 × 200, scrapped 2,000 of it.
    expect(Number(await balanceOf("1310"))).toBe(RECEIVED * UNIT_COST - 2000);
  });

  it("writes a movement against every lot it drew from", async () => {
    await stock(6, 100);
    await stock(50, 300);
    await scrap(10);

    const movements = await db.inventoryMovement.findMany({ where: { type: "SCRAP" } });
    expect(movements).toHaveLength(2);
    expect(movements.every((m) => m.referenceType === "SCRAP")).toBe(true);
    // Every movement names the journal it posted, so stock and the ledger stay
    // tied to each other.
    expect(movements.every((m) => m.journalEntryId)).toBe(true);
  });
});

describe("what came back for it", () => {
  it("banks the cash and books only the shortfall as a loss", async () => {
    await stock();
    const result = await scrap(10, "SOLD", 700); // book 2,000, sold for 700

    expect(Number(result.bookValue)).toBe(2000);
    expect(Number(result.netLoss)).toBe(1300);

    expect(Number(await balanceOf("1110"))).toBe(700);
    expect(Number(await balanceOf("5400"))).toBe(1300);
  });

  it("refuses salvage on scrap that was not sold", async () => {
    await stock();
    // Nothing came back for cloth that was thrown away.
    await expect(scrap(10, "DISCARDED", 500)).rejects.toThrow(ScrapError);
  });

  it("refuses salvage above the book value", async () => {
    await stock();
    // Selling offcuts for more than the cloth cost is a sale, not a recovery,
    // and booking it here would credit a COGS account with a hidden profit.
    await expect(scrap(10, "SOLD", 5000)).rejects.toThrow(/that is a sale/i);
  });

  it("books nothing at all when the offcut goes back on the shelf", async () => {
    await stock();
    const result = await scrap(10, "RETURNED_TO_STOCK");

    expect(result.journalEntryNumber).toBeNull();
    expect(Number(result.netLoss)).toBe(0);
    // The cloth never left, so the stock is untouched.
    expect(Number(await onHand())).toBe(RECEIVED);
    expect(Number(await balanceOf("5400"))).toBe(0);
  });

  it("still records the recovery, so the cutting room gets the credit", async () => {
    await stock();
    await scrap(10, "RETURNED_TO_STOCK");

    const records = await db.scrapRecord.findMany();
    expect(records).toHaveLength(1);
    expect(records[0].disposition).toBe("RETURNED_TO_STOCK");
  });
});

describe("what it refuses", () => {
  it("will not scrap cloth that is not there", async () => {
    await stock(5);
    // A partial write-off would drive the inventory account negative and hide
    // whichever earlier issue was really wrong.
    await expect(scrap(40)).rejects.toThrow(/short by/i);
  });

  it("leaves the stock alone when it refuses", async () => {
    await stock(5);
    await expect(scrap(40)).rejects.toThrow();

    expect(Number(await onHand())).toBe(5);
    expect(await db.scrapRecord.count()).toBe(0);
  });

  it("refuses a quantity of zero", async () => {
    await stock();
    await expect(
      recordScrap(
        {
          materialId, locationId: storeId, entityId: factoryId,
          disposition: "DISCARDED", quantity: 0, scrapDate: day,
        },
        { userId: ownerId, reason: null },
      ),
    ).rejects.toThrow();
  });
});

describe("the report the screen was always ready to show", () => {
  it("fills in once anything is recorded", async () => {
    await stock();
    await scrap(10, "DISCARDED");
    await scrap(4, "SOLD", 300);
    await scrap(2, "USED_FOR_SAMPLING");

    const report = await scrapReport();

    // 10 × 200 + 4 × 200 + 2 × 200
    expect(Number(report.bookValue)).toBe(3200);
    expect(Number(report.salvage)).toBe(300);
    expect(report.byDisposition).toHaveLength(3);
  });

  it("separates what was sold from what was thrown away", async () => {
    await stock();
    await scrap(10, "DISCARDED");
    await scrap(5, "SOLD", 400);

    const report = await scrapReport();
    const sold = report.byDisposition.find((d) => d.disposition === "SOLD")!;
    const binned = report.byDisposition.find((d) => d.disposition === "DISCARDED")!;

    expect(Number(sold.netLoss)).toBe(600); // 1,000 book less 400 back
    expect(Number(binned.netLoss)).toBe(2000); // nothing came back
  });
});

describe("the form has something to offer", () => {
  it("lists the cloth actually on the shelf, with what is left of it", async () => {
    await stock();

    const options = await scrappableMaterials(factoryId);
    const ours = options.find((o) => o.materialId === materialId)!;

    expect(Number(ours.onHand)).toBe(RECEIVED);
    expect(Number(ours.value)).toBe(RECEIVED * UNIT_COST);
    expect(ours.locationId).toBe(storeId);
  });

  it("drops a material once none of it is left", async () => {
    await stock(10);
    await scrap(10);

    const options = await scrappableMaterials(factoryId);
    expect(options.find((o) => o.materialId === materialId)).toBeUndefined();
  });
});
