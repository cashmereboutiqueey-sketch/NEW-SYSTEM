import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { receiveFinishedGoods } from "./inventory";
import { createSale, openPosSession, closePosSession, SalesError } from "./sales";
import { createUser } from "./users";
import { can } from "@/core/permissions";

/**
 * One person sells, another counts.
 *
 * A cashier who counts their own drawer is the only witness to a shortfall
 * they caused, and the variance figure — the single number that says whether
 * the day's cash is right — stops meaning anything. So the person who took
 * the money cannot be the person who declares it correct.
 *
 * The owner is the exception, because somebody has to be able to close a till
 * when there is nobody else on the floor at ten at night. Their name goes on
 * the row, which is what makes the exception safe rather than a hole.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let locationId: string;
let brandId: string;
let channelId: string;
let variantId: string;
let ownerId: string;
let cashierId: string;
let accountantId: string;
let day: Date;

const system = { userId: null as string | null, reason: null };

beforeAll(async () => {
  brandId = (await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } })).id;
  locationId = (await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } })).id;
  channelId = (await db.salesChannel.findFirstOrThrow()).id;
  variantId = (await db.variant.findFirstOrThrow()).id;
  ownerId = (await db.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;

  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" },
    orderBy: { startDate: "asc" },
  });
  day = new Date(period.startDate);
});

beforeEach(async () => {
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
    await db.documentSequence.deleteMany({});
    await db.user.deleteMany({ where: { email: { endsWith: "@tilltest.eg" } } });
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
  }

  cashierId = (
    await createUser(
      {
        name: "هبة", email: "cashier@tilltest.eg",
        role: "POS_CASHIER", password: "till-test-pass-1",
      },
      { userId: ownerId, reason: null },
    )
  ).id;

  accountantId = (
    await createUser(
      {
        name: "أحمد", email: "accountant@tilltest.eg",
        role: "ACCOUNTANT", password: "till-test-pass-2",
      },
      { userId: ownerId, reason: null },
    )
  ).id;
});

afterAll(async () => {
  await db.user.deleteMany({ where: { email: { endsWith: "@tilltest.eg" } } });
  await db.$disconnect();
});

/** A shift with one sale on it, opened by the cashier. */
async function shiftWithASale(cashier = cashierId) {
  await receiveFinishedGoods(
    {
      variantId, locationId, entityId: brandId,
      quantity: "5", unitCost: "500", materialUnitCost: "400", receivedDate: day,
    },
    system,
  );

  const session = await openPosSession(
    { locationId, cashierUserId: cashier, openingFloat: "500" },
    { userId: cashier, reason: null },
  );

  await createSale(
    {
      source: "POS", channelId, entityId: brandId, locationId,
      posSessionId: session.posSessionId, orderDate: day,
      lines: [{ variantId, quantity: 1, retailPrice: 1200, discountPct: 0 }],
      payments: [{ method: "CASH", amount: 1200, fee: 0, collected: true }],
    },
    { userId: cashier, reason: null },
  );

  return session.posSessionId;
}

describe("whoever took the money does not count it", () => {
  it("refuses the cashier who worked the shift", async () => {
    const posSessionId = await shiftWithASale();

    await expect(
      closePosSession(
        { posSessionId, countedCash: "1700" },
        { userId: cashierId, reason: null },
      ),
    ).rejects.toThrow(/somebody else has to count it/i);
  });

  it("leaves the till open when it refuses", async () => {
    const posSessionId = await shiftWithASale();

    await expect(
      closePosSession({ posSessionId, countedCash: "1700" }, { userId: cashierId, reason: null }),
    ).rejects.toThrow(SalesError);

    // A half-closed till would be worse than an open one: the shop would
    // think the day was counted.
    const session = await db.posSession.findUniqueOrThrow({ where: { id: posSessionId } });
    expect(session.closedAt).toBeNull();
    expect(session.countedCash).toBeNull();
  });

  it("lets the accountant close it", async () => {
    const posSessionId = await shiftWithASale();

    const result = await closePosSession(
      { posSessionId, countedCash: "1700" },
      { userId: accountantId, reason: null },
    );

    expect(Number(result.expectedCash)).toBe(1700);
    expect(Number(result.variance)).toBe(0);
  });

  it("lets the owner close a till they worked themselves", async () => {
    // Somebody has to be able to close up when nobody else is there.
    const posSessionId = await shiftWithASale(ownerId);

    const result = await closePosSession(
      { posSessionId, countedCash: "1700" },
      { userId: ownerId, reason: null },
    );
    expect(Number(result.variance)).toBe(0);
  });
});

describe("both names are on the shift", () => {
  it("records who sold and who counted", async () => {
    const posSessionId = await shiftWithASale();
    await closePosSession(
      { posSessionId, countedCash: "1650" },
      { userId: accountantId, reason: null },
    );

    const session = await db.posSession.findUniqueOrThrow({
      where: { id: posSessionId },
      include: { cashier: true, closedBy: true },
    });

    expect(session.cashier.name).toBe("هبة");
    expect(session.closedBy?.name).toBe("أحمد");
    // Fifty short, against the person who took the money, counted by somebody
    // who did not.
    expect(Number(session.cashVariance)).toBe(-50);
  });

  it("names the counter even when the drawer balances", async () => {
    const posSessionId = await shiftWithASale();
    await closePosSession(
      { posSessionId, countedCash: "1700" },
      { userId: accountantId, reason: null },
    );

    const session = await db.posSession.findUniqueOrThrow({ where: { id: posSessionId } });
    expect(session.closedByUserId).toBe(accountantId);
  });
});

describe("the two rights are held by different people", () => {
  it("gives the cashier selling but not counting", () => {
    expect(can("POS_CASHIER", "pos:operate")).toBe(true);
    expect(can("POS_CASHIER", "pos:close_shift")).toBe(false);
  });

  it("gives the accountant counting but not selling", () => {
    // Without `pos:operate` the accountant can never be the cashier on a
    // shift, so the rule above can never be reached by the same person.
    expect(can("ACCOUNTANT", "pos:close_shift")).toBe(true);
    expect(can("ACCOUNTANT", "pos:operate")).toBe(false);
  });

  it("gives the owner both, as the way out of a dead end", () => {
    expect(can("OWNER", "pos:operate")).toBe(true);
    expect(can("OWNER", "pos:close_shift")).toBe(true);
  });
});
