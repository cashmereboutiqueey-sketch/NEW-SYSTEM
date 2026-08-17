import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { journalEntries, reverseJournalEntry, auditTrail, auditSummary } from "./journal";
import { recordScrap } from "./scrap";
import { receiveMaterial } from "./inventory";
import { dec } from "./money";

/**
 * The ledger, and the only honest way to correct it.
 *
 * Every posting is immutable — the database refuses to edit a posted line from
 * application code and from raw SQL alike. That is the right rule, and it left
 * a hole: nothing could put a mistake right. A reversal is not a deletion; the
 * original stays exactly as posted and the mirror is posted beside it, so the
 * books show both the mistake and the correction.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

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

/** A real posting, made the way the application makes them. */
async function aPosting(quantity = 100, unitCost = 200) {
  await receiveMaterial(
    {
      materialId, locationId: storeId, entityId: factoryId,
      quantity: String(quantity), unitCost: String(unitCost), receivedDate: day,
    },
    { userId: ownerId, reason: null },
  );
  const entries = await journalEntries({ limit: 1 });
  return entries[0];
}

const reverse = (entryId: string, reason = "الكمية اتسجلت غلط، الفاتورة كانت ٨٠ متر") =>
  reverseJournalEntry(
    { entryId, postingDate: day, reason },
    { userId: ownerId, reason: null },
  );

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

describe("reading the ledger", () => {
  it("lists an entry with its own totals", async () => {
    const entry = await aPosting(100, 200);

    expect(entry.entryNumber).toMatch(/^JE-/);
    expect(Number(entry.debit)).toBe(20_000);
    expect(Number(entry.credit)).toBe(20_000);
    // A posted entry that does not balance is impossible; the trigger forbids
    // it. A total that looks wrong means the filter is wrong.
    expect(entry.balanced).toBe(true);
  });

  it("carries the lines with the accounts named", async () => {
    const entry = await aPosting();

    expect(entry.lines.length).toBeGreaterThanOrEqual(2);
    expect(entry.lines.every((l) => l.accountCode)).toBe(true);
    expect(entry.lines.some((l) => l.accountCode === "1310")).toBe(true);
  });

  it("filters by the account somebody is looking at", async () => {
    await aPosting();

    expect(await journalEntries({ accountCode: "1310" })).toHaveLength(1);
    // An account this posting never touched.
    expect(await journalEntries({ accountCode: "5500" })).toHaveLength(0);
  });

  it("filters by entity and by source", async () => {
    await aPosting();

    expect((await journalEntries({ entityId: factoryId })).length).toBeGreaterThan(0);
    expect(await journalEntries({ entityId: "nope" })).toHaveLength(0);
  });

  it("finds an entry by its number", async () => {
    const entry = await aPosting();
    const found = await journalEntries({ search: entry.entryNumber });
    expect(found).toHaveLength(1);
  });
});

describe("putting a mistake right", () => {
  it("posts the mirror image instead of editing the original", async () => {
    const entry = await aPosting(100, 200);
    await reverse(entry.id);

    // 20,000 in and 20,000 back out.
    expect(Number(await balanceOf("1310"))).toBe(0);
  });

  it("leaves the original exactly as it was posted", async () => {
    const entry = await aPosting(100, 200);
    await reverse(entry.id);

    const original = await db.journalEntry.findUniqueOrThrow({
      where: { id: entry.id },
      include: { lines: true },
    });

    // The audit trail depends on it staying put, and the database forbids
    // touching it in any case.
    expect(original.status).toBe("POSTED");
    expect(Number(original.lines.reduce((t, l) => t + Number(l.debit), 0))).toBe(20_000);
  });

  it("links the two so the books show both the mistake and the correction", async () => {
    const entry = await aPosting();
    const reversal = await reverse(entry.id);

    // Searching the original's number finds both, because the correction's
    // memo names what it corrects — which is the point of the memo. Pick the
    // one actually being asserted about rather than whichever sorts first.
    const found = await journalEntries({ search: entry.entryNumber });
    const original = found.find((e) => e.entryNumber === entry.entryNumber)!;
    const correction = found.find((e) => e.entryNumber === reversal.entryNumber)!;

    expect(found).toHaveLength(2);
    expect(original.reversedByNumber).toBe(reversal.entryNumber);
    expect(correction.reversesNumber).toBe(entry.entryNumber);
  });

  it("keeps the reason on the record", async () => {
    const entry = await aPosting();
    const reversal = await reverse(entry.id, "الفاتورة كانت مكررة والمورد أكد كده");

    const [correction] = await journalEntries({ search: reversal.entryNumber });
    expect(correction.reversalReason).toContain("مكررة");
  });

  it("refuses a reversal with no real reason", async () => {
    const entry = await aPosting();
    // "Correction" tells whoever reads the books in a year exactly nothing.
    await expect(reverse(entry.id, "غلط")).rejects.toThrow();
  });

  it("refuses to reverse the same entry twice", async () => {
    const entry = await aPosting();
    await reverse(entry.id);

    await expect(reverse(entry.id)).rejects.toThrow(/already reversed/i);
  });

  it("stops offering a reversal once one has been made", async () => {
    const entry = await aPosting();
    expect(entry.reversible).toBe(true);

    await reverse(entry.id);
    const after = (await journalEntries({ search: entry.entryNumber })).find(
      (e) => e.entryNumber === entry.entryNumber,
    )!;
    expect(after.reversible).toBe(false);
  });

  it("changes nothing when it refuses", async () => {
    const entry = await aPosting(100, 200);
    await expect(reverse(entry.id, "x")).rejects.toThrow();

    // The refusal must not have half-posted a correction.
    expect(Number(await balanceOf("1310"))).toBe(20_000);
    expect(await db.journalEntry.count()).toBe(1);
  });
});

describe("the audit trail", () => {
  it("shows what somebody did", async () => {
    await receiveMaterial(
      {
        materialId, locationId: storeId, entityId: factoryId,
        quantity: "50", unitCost: "100", receivedDate: day,
      },
      { userId: ownerId, reason: "توريد أول الشهر" },
    );

    const trail = await auditTrail();
    expect(trail.length).toBeGreaterThan(0);
    expect(trail[0].userName).toBeTruthy();
    expect(trail[0].reason).toBe("توريد أول الشهر");
  });

  it("says nobody rather than attributing a system action to a person", async () => {
    await receiveMaterial(
      {
        materialId, locationId: storeId, entityId: factoryId,
        quantity: "50", unitCost: "100", receivedDate: day,
      },
      ctx, // no user: a seed, a job, a migration
    );

    const trail = await auditTrail();
    expect(trail[0].userName).toBeNull();
  });

  it("filters to one action", async () => {
    await aPosting();
    await recordScrap(
      {
        materialId, locationId: storeId, entityId: factoryId,
        disposition: "DISCARDED", quantity: 5, scrapDate: day,
      },
      { userId: ownerId, reason: null },
    );

    const scrapOnly = await auditTrail({ action: "SCRAP_RECORDED" });
    expect(scrapOnly).toHaveLength(1);
    expect(scrapOnly[0].entityName).toBe("ScrapRecord");
  });

  it("keeps what the record looked like afterwards", async () => {
    await aPosting(); // cloth on the shelf to scrap from
    await recordScrap(
      {
        materialId, locationId: storeId, entityId: factoryId,
        disposition: "DISCARDED", quantity: 5, scrapDate: day,
      },
      { userId: ownerId, reason: null },
    );

    const [entry] = await auditTrail({ action: "SCRAP_RECORDED" });
    expect(entry.after).toBeTruthy();
  });

  it("counts what has been recorded, so an empty screen can say why", async () => {
    await aPosting();

    const summary = await auditSummary();
    expect(summary.total).toBeGreaterThan(0);
    expect(summary.topActions.length).toBeGreaterThan(0);
  });

  it("does not fall over on an empty trail", async () => {
    const summary = await auditSummary();
    expect(summary.total).toBe(0);
    expect(summary.topActions).toHaveLength(0);
    expect(await auditTrail()).toHaveLength(0);
  });
});
