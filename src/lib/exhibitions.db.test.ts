import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { receiveFinishedGoods } from "./inventory";
import { createSale } from "./sales";
import {
  openExhibition,
  sendToExhibition,
  exhibitionPosition,
  closeExhibition,
  sendableStock,
  exhibitionList,
  ExhibitionError,
} from "./exhibitions";
import { dec } from "./money";

/**
 * A bazaar is the easiest way in this business to lose stock without anybody
 * stealing anything, so these tests are built around one identity:
 *
 *     sent = sold + returned + missing
 *
 * Everything else here exists to stop that identity being broken quietly —
 * by sending untagged goods that cannot be counted back, by closing while a
 * till is still open, or by one person writing off a shortfall alone.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let brandId: string;
let showroomId: string;
let cairoId: string;
let variantId: string;
let otherVariantId: string;
let channelId: string;
let day: Date;
let counterUserId: string;
let approverUserId: string;

const ctx = { userId: null as string | null, reason: null };

beforeAll(async () => {
  brandId = (await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } })).id;
  showroomId = (await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } })).id;
  cairoId = (await db.location.findFirstOrThrow({ where: { code: "LOC-CAI" } })).id;
  channelId = (await db.salesChannel.findFirstOrThrow()).id;

  const variants = await db.variant.findMany({ take: 2, orderBy: { sku: "asc" } });
  variantId = variants[0].id;
  otherVariantId = variants[1].id;

  const users = await db.user.findMany({ take: 2, orderBy: { email: "asc" } });
  counterUserId = users[0].id;
  approverUserId = users[1].id;

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
    await db.garmentUnit.deleteMany({});
    await db.salesPayment.deleteMany({});
    await db.salesOrderLine.deleteMany({});
    await db.salesOrder.deleteMany({});
    await db.posSession.deleteMany({});
    await db.inventoryMovement.deleteMany({});
    await db.inventoryLot.deleteMany({});
    await db.journalLine.deleteMany({});
    await db.journalEntry.deleteMany({});
    await db.auditLog.deleteMany({});
    await db.documentSequence.deleteMany({});
    await db.location.deleteMany({ where: { kind: "EXHIBITION" } });
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

/**
 * Stock on the showroom shelf, tagged and sellable.
 *
 * The tagging is stamped separately because that is how it happens in life:
 * goods arrive, and the shop tags them before they reach the floor.
 */
async function givenStock(quantity: number, variant = variantId, unitCost = "500") {
  await receiveFinishedGoods(
    {
      variantId: variant,
      locationId: showroomId,
      entityId: brandId,
      quantity: String(quantity),
      unitCost,
      materialUnitCost: dec(unitCost).times("0.8").toString(),
      receivedDate: day,
    },
    ctx,
  );
  await db.inventoryLot.updateMany({
    where: { variantId: variant, locationId: showroomId, labelsPrintedAt: null },
    data: { labelsPrintedAt: day },
  });
}

async function givenBazaar(name = "بازار الساحل") {
  return openExhibition(
    {
      nameAr: name,
      nameEn: "North Coast Bazaar",
      city: "Sidi Abdel Rahman",
      opensAt: day,
      closesAt: new Date(day.getTime() + 3 * 86_400_000),
      parentLocationId: showroomId,
    },
    ctx,
  );
}

/** What the showroom holds right now. */
async function showroomQty(variant = variantId) {
  const agg = await db.inventoryLot.aggregate({
    where: { variantId: variant, locationId: showroomId, remainingQty: { gt: 0 } },
    _sum: { remainingQty: true },
  });
  return Number(agg._sum.remainingQty ?? 0);
}

async function ledgerBalances() {
  const rows = await db.journalLine.findMany({
    where: { journalEntry: { status: "POSTED" } },
    select: { debit: true, credit: true },
  });
  const debits = rows.reduce((s, r) => s.plus(dec(r.debit)), dec(0));
  const credits = rows.reduce((s, r) => s.plus(dec(r.credit)), dec(0));
  return debits.minus(credits).toNumber();
}

async function accountBalance(code: string) {
  const account = await db.account.findUniqueOrThrow({ where: { code } });
  const rows = await db.journalLine.findMany({
    where: { accountId: account.id, journalEntry: { status: "POSTED" } },
    select: { debit: true, credit: true },
  });
  return rows
    .reduce((s, r) => s.plus(dec(r.debit)).minus(dec(r.credit)), dec(0))
    .toNumber();
}

async function sellAtBazaar(locationId: string, quantity: number, price = 1200) {
  return createSale(
    {
      source: "EXHIBITION",
      channelId,
      entityId: brandId,
      locationId,
      orderDate: day,
      lines: [{ variantId, quantity, retailPrice: price, discountPct: 0 }],
      payments: [{ method: "CASH", amount: price * quantity, fee: 0, collected: true }],
    },
    ctx,
  );
}

// ---------------------------------------------------------------- opening

describe("opening a bazaar", () => {
  it("creates a temporary location tied to where its stock comes from", async () => {
    const { id, code } = await givenBazaar();

    const location = await db.location.findUniqueOrThrow({ where: { id } });
    expect(location.kind).toBe("EXHIBITION");
    expect(location.isActive).toBe(true);
    expect(location.parentLocationId).toBe(showroomId);
    expect(location.entityId).toBe(brandId);
    expect(code).toMatch(/^EXH-/);
  });

  it("refuses to close before it opens", async () => {
    await expect(
      openExhibition(
        {
          nameAr: "بازار",
          nameEn: "Bazaar",
          opensAt: new Date(day.getTime() + 3 * 86_400_000),
          closesAt: day,
          parentLocationId: showroomId,
        },
        ctx,
      ),
    ).rejects.toThrow(ExhibitionError);
  });

  it("refuses to be stocked from another bazaar", async () => {
    const first = await givenBazaar();
    await expect(
      openExhibition(
        {
          nameAr: "بازار تاني",
          nameEn: "Second",
          opensAt: day,
          closesAt: day,
          parentLocationId: first.id,
        },
        ctx,
      ),
    ).rejects.toThrow(/cannot be stocked from another bazaar/i);
  });

  it("refuses a bazaar with no name", async () => {
    await expect(
      openExhibition(
        { nameAr: "  ", nameEn: "", opensAt: day, closesAt: day, parentLocationId: showroomId },
        ctx,
      ),
    ).rejects.toThrow(ExhibitionError);
  });
});

// ---------------------------------------------------------------- sending

describe("sending stock", () => {
  it("moves it out of the showroom and onto the stand", async () => {
    await givenStock(20);
    const bazaar = await givenBazaar();

    await sendToExhibition(
      { exhibitionId: bazaar.id, lines: [{ variantId, quantity: "8" }], sendDate: day },
      ctx,
    );

    expect(await showroomQty()).toBe(12);

    const position = await exhibitionPosition(bazaar.id);
    expect(Number(position.totals.sent)).toBe(8);
    expect(Number(position.totals.expected)).toBe(8);
    expect(Number(position.totals.sold)).toBe(0);
  });

  it("posts no journal, because nothing changed hands", async () => {
    await givenStock(20);
    const bazaar = await givenBazaar();
    const before = await db.journalEntry.count();

    await sendToExhibition(
      { exhibitionId: bazaar.id, lines: [{ variantId, quantity: "8" }], sendDate: day },
      ctx,
    );

    // Same company, same stock account, same value. Only the shelf changed.
    expect(await db.journalEntry.count()).toBe(before);
    expect(await accountBalance("1340")).toBeCloseTo(20 * 500, 2);
  });

  it("carries the cost across, so the stand is not valued at guesswork", async () => {
    await givenStock(10, variantId, "500");
    const bazaar = await givenBazaar();

    await sendToExhibition(
      { exhibitionId: bazaar.id, lines: [{ variantId, quantity: "4" }], sendDate: day },
      ctx,
    );

    const lots = await db.inventoryLot.findMany({ where: { locationId: bazaar.id } });
    expect(lots).toHaveLength(1);
    expect(Number(lots[0].unitCost)).toBe(500);
    expect(lots[0].labelsPrintedAt).not.toBeNull();
  });

  it("refuses to send untagged stock", async () => {
    // A garment with no barcode cannot be rung up at the stand and cannot be
    // counted back in, so sending one guarantees the close will not balance.
    await receiveFinishedGoods(
      {
        variantId, locationId: showroomId, entityId: brandId,
        quantity: "10", unitCost: "500", materialUnitCost: "400", receivedDate: day,
      },
      ctx,
    );
    const bazaar = await givenBazaar();

    await expect(
      sendToExhibition(
        { exhibitionId: bazaar.id, lines: [{ variantId, quantity: "1" }], sendDate: day },
        ctx,
      ),
    ).rejects.toThrow(/does not hold enough tagged/i);
  });

  it("refuses to send more than the showroom holds", async () => {
    await givenStock(5);
    const bazaar = await givenBazaar();

    await expect(
      sendToExhibition(
        { exhibitionId: bazaar.id, lines: [{ variantId, quantity: "9" }], sendDate: day },
        ctx,
      ),
    ).rejects.toThrow(/does not hold enough/i);

    // And nothing moved on the way to failing.
    expect(await showroomQty()).toBe(5);
    expect(await db.inventoryLot.count({ where: { locationId: bazaar.id } })).toBe(0);
  });

  it("refuses to send to a bazaar that has been closed", async () => {
    await givenStock(10);
    const bazaar = await givenBazaar();
    await closeExhibition(
      { exhibitionId: bazaar.id, closeDate: day, counts: [] },
      { userId: counterUserId, reason: null },
    );

    await expect(
      sendToExhibition(
        { exhibitionId: bazaar.id, lines: [{ variantId, quantity: "1" }], sendDate: day },
        ctx,
      ),
    ).rejects.toThrow(/closed and reconciled/i);
  });

  it("sends several styles in one trip", async () => {
    await givenStock(10, variantId);
    await givenStock(6, otherVariantId, "400");
    const bazaar = await givenBazaar();

    await sendToExhibition(
      {
        exhibitionId: bazaar.id,
        lines: [
          { variantId, quantity: "4" },
          { variantId: otherVariantId, quantity: "3" },
        ],
        sendDate: day,
      },
      ctx,
    );

    const position = await exhibitionPosition(bazaar.id);
    expect(Number(position.totals.sent)).toBe(7);
    expect(position.lines).toHaveLength(2);
  });

  it("offers only what can actually go", async () => {
    await givenStock(10, variantId);
    const rows = await sendableStock(showroomId);
    const row = rows.find((r) => r.variantId === variantId)!;
    expect(Number(row.available)).toBe(10);
    expect(Number(row.untagged)).toBe(0);
  });
});

// ---------------------------------------------------------------- selling

describe("selling at the bazaar", () => {
  it("takes the garment off the stand, not out of the showroom", async () => {
    await givenStock(20);
    const bazaar = await givenBazaar();
    await sendToExhibition(
      { exhibitionId: bazaar.id, lines: [{ variantId, quantity: "8" }], sendDate: day },
      ctx,
    );

    await sellAtBazaar(bazaar.id, 3);

    const position = await exhibitionPosition(bazaar.id);
    expect(Number(position.totals.sold)).toBe(3);
    expect(Number(position.totals.expected)).toBe(5);
    // The showroom is untouched by what the bazaar sells.
    expect(await showroomQty()).toBe(12);
  });

  it("books the revenue to the bazaar's own account", async () => {
    await givenStock(20);
    const bazaar = await givenBazaar();
    await sendToExhibition(
      { exhibitionId: bazaar.id, lines: [{ variantId, quantity: "8" }], sendDate: day },
      ctx,
    );

    await sellAtBazaar(bazaar.id, 2, 1000);

    // 4140 is exhibition revenue. Without it a bazaar's takings would be
    // indistinguishable from the showroom's in every channel report.
    expect(await accountBalance("4140")).toBeCloseTo(-2000, 2);
  });
});

// ---------------------------------------------------------------- closing

describe("closing the bazaar", () => {
  it("sends everything home when the count agrees", async () => {
    await givenStock(20);
    const bazaar = await givenBazaar();
    await sendToExhibition(
      { exhibitionId: bazaar.id, lines: [{ variantId, quantity: "8" }], sendDate: day },
      ctx,
    );
    await sellAtBazaar(bazaar.id, 3);

    const result = await closeExhibition(
      {
        exhibitionId: bazaar.id,
        closeDate: day,
        counts: [{ variantId, countedQty: "5" }],
      },
      { userId: counterUserId, reason: null },
    );

    expect(Number(result.returned)).toBe(5);
    expect(Number(result.missing)).toBe(0);
    expect(result.journalEntryId).toBeNull();

    // 20 − 8 sent + 5 back = 17, and 3 of the original 20 were sold.
    expect(await showroomQty()).toBe(17);

    const location = await db.location.findUniqueOrThrow({ where: { id: bazaar.id } });
    expect(location.isActive).toBe(false);
  });

  it("holds the identity: sent = sold + returned + missing", async () => {
    await givenStock(30);
    const bazaar = await givenBazaar();
    await sendToExhibition(
      { exhibitionId: bazaar.id, lines: [{ variantId, quantity: "12" }], sendDate: day },
      ctx,
    );
    await sellAtBazaar(bazaar.id, 4);

    // Two never came back.
    const result = await closeExhibition(
      {
        exhibitionId: bazaar.id,
        closeDate: day,
        counts: [{ variantId, countedQty: "6" }],
      },
      { userId: counterUserId, reason: null },
    );

    const sold = 4;
    const returned = Number(result.returned);
    const missing = Number(result.missing);

    expect(returned).toBe(6);
    expect(missing).toBe(2);
    expect(sold + returned + missing).toBe(12);
  });

  it("writes the shortfall off as a real loss", async () => {
    await givenStock(30);
    const bazaar = await givenBazaar();
    await sendToExhibition(
      { exhibitionId: bazaar.id, lines: [{ variantId, quantity: "12" }], sendDate: day },
      ctx,
    );

    const lossBefore = await accountBalance("5450");
    const stockBefore = await accountBalance("1340");

    const result = await closeExhibition(
      {
        exhibitionId: bazaar.id,
        closeDate: day,
        counts: [{ variantId, countedQty: "10" }],
      },
      { userId: counterUserId, reason: null },
    );

    expect(Number(result.missing)).toBe(2);
    expect(Number(result.shortfallValue)).toBeCloseTo(1000, 2); // 2 × 500
    expect(result.journalEntryId).not.toBeNull();

    // DR stock loss, CR stock. The garments are gone and the books say so.
    expect(await accountBalance("5450")).toBeCloseTo(lossBefore + 1000, 2);
    expect(await accountBalance("1340")).toBeCloseTo(stockBefore - 1000, 2);
    expect(await ledgerBalances()).toBeCloseTo(0, 6);
  });

  it("treats stock nobody counted as missing rather than skipping it", async () => {
    await givenStock(20);
    const bazaar = await givenBazaar();
    await sendToExhibition(
      { exhibitionId: bazaar.id, lines: [{ variantId, quantity: "6" }], sendDate: day },
      ctx,
    );

    // An empty count sheet is a statement that nothing is there.
    const result = await closeExhibition(
      { exhibitionId: bazaar.id, closeDate: day, counts: [] },
      { userId: counterUserId, reason: null },
    );

    expect(Number(result.missing)).toBe(6);
    expect(Number(result.returned)).toBe(0);
    expect(await ledgerBalances()).toBeCloseTo(0, 6);
  });

  it("refuses to close while a till is still open", async () => {
    await givenStock(20);
    const bazaar = await givenBazaar();
    await sendToExhibition(
      { exhibitionId: bazaar.id, lines: [{ variantId, quantity: "6" }], sendDate: day },
      ctx,
    );

    await db.posSession.create({
      data: {
        sessionNumber: "TILL-EXH-1",
        locationId: bazaar.id,
        cashierUserId: counterUserId,
        openingFloat: "0",
      },
    });

    await expect(
      closeExhibition(
        { exhibitionId: bazaar.id, closeDate: day, counts: [{ variantId, countedQty: "6" }] },
        { userId: counterUserId, reason: null },
      ),
    ).rejects.toThrow(/till session open/i);
  });

  it("cannot be closed twice", async () => {
    await givenStock(10);
    const bazaar = await givenBazaar();
    await closeExhibition(
      { exhibitionId: bazaar.id, closeDate: day, counts: [] },
      { userId: counterUserId, reason: null },
    );

    await expect(
      closeExhibition(
        { exhibitionId: bazaar.id, closeDate: day, counts: [] },
        { userId: counterUserId, reason: null },
      ),
    ).rejects.toThrow(/already been closed/i);
  });

  it("refuses a negative count", async () => {
    await givenStock(10);
    const bazaar = await givenBazaar();
    await sendToExhibition(
      { exhibitionId: bazaar.id, lines: [{ variantId, quantity: "4" }], sendDate: day },
      ctx,
    );

    await expect(
      closeExhibition(
        { exhibitionId: bazaar.id, closeDate: day, counts: [{ variantId, countedQty: "-1" }] },
        { userId: counterUserId, reason: null },
      ),
    ).rejects.toThrow(/cannot be negative/i);
  });

  it("returns the garments to the shelf they came from, still tagged", async () => {
    await givenStock(10);
    const bazaar = await givenBazaar();
    await sendToExhibition(
      { exhibitionId: bazaar.id, lines: [{ variantId, quantity: "4" }], sendDate: day },
      ctx,
    );
    await closeExhibition(
      { exhibitionId: bazaar.id, closeDate: day, counts: [{ variantId, countedQty: "4" }] },
      { userId: counterUserId, reason: null },
    );

    const returned = await db.inventoryLot.findMany({
      where: { locationId: showroomId, remainingQty: { gt: 0 } },
    });
    expect(returned.every((l) => l.labelsPrintedAt !== null)).toBe(true);
    expect(await showroomQty()).toBe(10);
    // Nothing is left behind at a closed bazaar.
    const left = await db.inventoryLot.aggregate({
      where: { locationId: bazaar.id, remainingQty: { gt: 0 } },
      _sum: { remainingQty: true },
    });
    expect(Number(left._sum.remainingQty ?? 0)).toBe(0);
  });
});

describe("a large shortfall", () => {
  it("cannot be written off by one person alone", async () => {
    // 30 garments at 500 is 15,000 — well past the 5,000 approval limit.
    await givenStock(40);
    const bazaar = await givenBazaar();
    await sendToExhibition(
      { exhibitionId: bazaar.id, lines: [{ variantId, quantity: "30" }], sendDate: day },
      ctx,
    );

    await expect(
      closeExhibition(
        { exhibitionId: bazaar.id, closeDate: day, counts: [{ variantId, countedQty: "0" }] },
        { userId: counterUserId, reason: null },
      ),
    ).rejects.toThrow(/needs an approver/i);
  });

  it("cannot be approved by the person who ran the bazaar", async () => {
    await givenStock(40);
    const bazaar = await givenBazaar();
    await sendToExhibition(
      { exhibitionId: bazaar.id, lines: [{ variantId, quantity: "30" }], sendDate: day },
      ctx,
    );

    await expect(
      closeExhibition(
        {
          exhibitionId: bazaar.id,
          closeDate: day,
          counts: [{ variantId, countedQty: "0" }],
          approvedByUserId: counterUserId,
        },
        { userId: counterUserId, reason: null },
      ),
    ).rejects.toThrow(/cannot approve their own/i);
  });

  it("goes through with a second person behind it", async () => {
    await givenStock(40);
    const bazaar = await givenBazaar();
    await sendToExhibition(
      { exhibitionId: bazaar.id, lines: [{ variantId, quantity: "30" }], sendDate: day },
      ctx,
    );

    const result = await closeExhibition(
      {
        exhibitionId: bazaar.id,
        closeDate: day,
        counts: [{ variantId, countedQty: "0" }],
        approvedByUserId: approverUserId,
      },
      { userId: counterUserId, reason: null },
    );

    expect(Number(result.missing)).toBe(30);
    expect(Number(result.shortfallValue)).toBeCloseTo(15_000, 2);
    expect(await ledgerBalances()).toBeCloseTo(0, 6);
  });
});

describe("nothing is left half-done", () => {
  it("leaves the books balanced through a whole bazaar", async () => {
    await givenStock(50);
    const bazaar = await givenBazaar();
    await sendToExhibition(
      { exhibitionId: bazaar.id, lines: [{ variantId, quantity: "20" }], sendDate: day },
      ctx,
    );
    await sellAtBazaar(bazaar.id, 5, 1500);
    await sellAtBazaar(bazaar.id, 3, 1500);

    await closeExhibition(
      { exhibitionId: bazaar.id, closeDate: day, counts: [{ variantId, countedQty: "11" }] },
      { userId: counterUserId, reason: null },
    );

    expect(await ledgerBalances()).toBeCloseTo(0, 6);

    // 50 − 20 out + 11 back = 41 on the shelf; 8 sold, 1 lost.
    expect(await showroomQty()).toBe(41);
  });

  it("shows a closed bazaar in the list with what it took", async () => {
    await givenStock(20);
    const bazaar = await givenBazaar("بازار الجونة");
    await sendToExhibition(
      { exhibitionId: bazaar.id, lines: [{ variantId, quantity: "10" }], sendDate: day },
      ctx,
    );
    await sellAtBazaar(bazaar.id, 2, 1500);

    const list = await exhibitionList();
    const row = list.find((r) => r.id === bazaar.id)!;
    expect(row.nameAr).toBe("بازار الجونة");
    expect(row.orderCount).toBe(1);
    expect(Number(row.revenue)).toBeCloseTo(3000, 2);
    expect(Number(row.onStand)).toBe(8);
  });
});
