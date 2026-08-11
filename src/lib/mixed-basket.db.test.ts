import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { receiveFinishedGoods } from "./inventory";
import { createSale, openPosSession } from "./sales";
import {
  createConsignor,
  receiveConsignment,
  sellConsignedItem,
  sellableConsignedStock,
  totalOwedToConsignors,
} from "./consignment";
import { dec } from "./money";

/**
 * One customer, one payment, two kinds of garment.
 *
 * Somebody buys a dress the shop made and a dress it is holding for another
 * label. They pay once and walk out with two. Underneath it has to be two
 * documents, because almost nothing about the halves is the same: one
 * relieves stock and earns the whole price, the other relieves nothing and
 * earns a commission.
 *
 * The thing these tests protect is that the money divides correctly and each
 * document claims only its own share. Get that wrong and the drawer is right
 * while the books are not, which is the hardest kind of error to find.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let brandId: string;
let locationId: string;
let channelId: string;
let variantId: string;
let cashierId: string;
let consignorId: string;
let day: Date;

const ctx = { userId: null as string | null, reason: null };

beforeAll(async () => {
  brandId = (await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } })).id;
  locationId = (await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } })).id;
  channelId = (await db.salesChannel.findFirstOrThrow()).id;
  variantId = (await db.variant.findFirstOrThrow()).id;
  cashierId = (await db.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;

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
    await db.consignmentSale.deleteMany({});
    await db.consignorSettlement.deleteMany({});
    await db.consignmentItem.deleteMany({});
    await db.consignor.deleteMany({});
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
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
  }
}

beforeEach(async () => {
  await wipe();
  consignorId = (
    await createConsignor(
      { code: "MAISON", name: "ميزون نور", commissionRate: "0.25" },
      ctx,
    )
  ).id;
});

afterAll(async () => {
  await wipe();
  await db.$disconnect();
});

async function balance(code: string) {
  const account = await db.account.findUniqueOrThrow({ where: { code } });
  const rows = await db.journalLine.findMany({
    where: { accountId: account.id, journalEntry: { status: "POSTED" } },
    select: { debit: true, credit: true },
  });
  return rows.reduce((s, r) => s.plus(dec(r.debit)).minus(dec(r.credit)), dec(0)).toNumber();
}

async function ledgerGap() {
  const rows = await db.journalLine.findMany({
    where: { journalEntry: { status: "POSTED" } },
    select: { debit: true, credit: true },
  });
  return rows.reduce((s, r) => s.plus(dec(r.debit)).minus(dec(r.credit)), dec(0)).toNumber();
}

/** The shop's own stock, on the shelf and costed. */
async function ownStock(quantity = 5, unitCost = "600") {
  await receiveFinishedGoods(
    {
      variantId, locationId, entityId: brandId,
      quantity: String(quantity), unitCost,
      materialUnitCost: dec(unitCost).times("0.8").toString(),
      receivedDate: day,
    },
    ctx,
  );
}

/** Somebody else's dresses, on the same rail. */
function consignedGoods(quantity = 3, price = "2000") {
  return receiveConsignment(
    {
      consignorId, description: "فستان ميزون", quantity,
      retailPrice: price, locationId, receivedDate: day,
    },
    ctx,
  );
}

/**
 * What the till does: the shop's own goods as one order, each consigned
 * garment as its own sale, and the payment divided by ownership.
 */
async function mixedBasket(input: {
  ownQuantity: number;
  ownPrice: number;
  consignedItemId: string;
  consignedQuantity: number;
  consignedPrice: number;
  posSessionId?: string;
}) {
  const ownTotal = input.ownQuantity * input.ownPrice;

  const order =
    input.ownQuantity > 0
      ? await createSale(
          {
            source: input.posSessionId ? "POS" : "MANUAL",
            channelId, entityId: brandId, locationId,
            posSessionId: input.posSessionId ?? null,
            orderDate: day,
            lines: [
              {
                variantId,
                quantity: input.ownQuantity,
                retailPrice: input.ownPrice,
                discountPct: 0,
              },
            ],
            payments: [{ method: "CASH", amount: ownTotal, fee: 0, collected: true }],
          },
          { userId: cashierId, reason: null },
        )
      : null;

  const consigned = await sellConsignedItem(
    {
      itemId: input.consignedItemId,
      quantity: input.consignedQuantity,
      soldPrice: String(input.consignedPrice),
      paymentMethod: "CASH",
      posSessionId: input.posSessionId ?? null,
      saleDate: day,
    },
    { userId: cashierId, reason: null },
  );

  return { order, consigned, ownTotal };
}

describe("one basket, two owners", () => {
  it("puts the whole payment in the drawer and splits it correctly", async () => {
    await ownStock(5, "600");
    const item = await consignedGoods(3, "2000");

    // Two of the shop's at 1,500 and one consigned at 2,000: the customer
    // hands over 5,000.
    const { order, consigned } = await mixedBasket({
      ownQuantity: 2, ownPrice: 1500,
      consignedItemId: item.id, consignedQuantity: 1, consignedPrice: 2000,
    });

    expect(order).not.toBeNull();
    expect(Number(consigned.total)).toBe(2000);

    // Everything the customer paid is in the drawer, across two journals.
    expect(await balance("1115")).toBeCloseTo(5000, 2);

    // The shop's own sale earned 3,000 of revenue.
    expect(await balance("4130")).toBeCloseTo(-3000, 2);
    // The consigned dress earned 500, not 2,000.
    expect(await balance("4160")).toBeCloseTo(-500, 2);
    // And 1,500 of what is in the drawer is not the shop's.
    expect(await balance("2500")).toBeCloseTo(-1500, 2);

    expect(await ledgerGap()).toBeCloseTo(0, 6);
  });

  it("counts only its own goods as turnover", async () => {
    await ownStock(5, "600");
    const item = await consignedGoods(3, "2000");

    await mixedBasket({
      ownQuantity: 2, ownPrice: 1500,
      consignedItemId: item.id, consignedQuantity: 1, consignedPrice: 2000,
    });

    // A 5,000 basket, of which the shop earned 3,500: 3,000 of sales and 500
    // of commission. Reporting 5,000 would flatter every ratio in the system.
    const revenue = -(await balance("4130")) + -(await balance("4160"));
    expect(revenue).toBeCloseTo(3500, 2);
  });

  it("relieves stock for its own goods and none for the rest", async () => {
    await ownStock(5, "600");
    const item = await consignedGoods(3, "2000");

    await mixedBasket({
      ownQuantity: 2, ownPrice: 1500,
      consignedItemId: item.id, consignedQuantity: 1, consignedPrice: 2000,
    });

    const onShelf = await db.inventoryLot.aggregate({
      where: { variantId, locationId, remainingQty: { gt: 0 } },
      _sum: { remainingQty: true },
    });
    expect(Number(onShelf._sum.remainingQty ?? 0)).toBe(3);

    // Cost of sales covers the two the shop owned, and nothing else.
    expect(await balance("5300")).toBeCloseTo(1200, 2);

    // The consigned one came off its own counter.
    const rail = await sellableConsignedStock(locationId);
    expect(rail.find((r) => r.itemId === item.id)!.available).toBe(2);
  });

  it("keeps the two documents separate and findable", async () => {
    await ownStock(5, "600");
    const item = await consignedGoods(3, "2000");

    const { order, consigned } = await mixedBasket({
      ownQuantity: 1, ownPrice: 1500,
      consignedItemId: item.id, consignedQuantity: 1, consignedPrice: 2000,
    });

    expect(order!.orderNumber).toMatch(/^SO-/);
    expect(consigned.saleNumber).toMatch(/^CSL-/);

    // The sales order carries only what the shop sold.
    const stored = await db.salesOrder.findUniqueOrThrow({
      where: { id: order!.salesOrderId },
      include: { lines: true },
    });
    expect(stored.lines).toHaveLength(1);
    expect(Number(stored.netAmount)).toBe(1500);
  });

  it("ties both halves to the same till session", async () => {
    await ownStock(5, "600");
    const item = await consignedGoods(3, "2000");

    const session = await openPosSession(
      { locationId, cashierUserId: cashierId, openingFloat: "500" },
      { userId: cashierId, reason: null },
    );

    const { order, consigned } = await mixedBasket({
      ownQuantity: 1, ownPrice: 1500,
      consignedItemId: item.id, consignedQuantity: 1, consignedPrice: 2000,
      posSessionId: session.posSessionId,
    });

    const storedOrder = await db.salesOrder.findUniqueOrThrow({
      where: { id: order!.salesOrderId },
    });
    const storedConsigned = await db.consignmentSale.findFirstOrThrow({
      where: { saleNumber: consigned.saleNumber },
    });

    // Otherwise the drawer count at close would miss half the basket.
    expect(storedOrder.posSessionId).toBe(session.posSessionId);
    expect(storedConsigned.posSessionId).toBe(session.posSessionId);
  });

  it("works when the whole basket belongs to somebody else", async () => {
    const item = await consignedGoods(3, "2000");

    const { order, consigned } = await mixedBasket({
      ownQuantity: 0, ownPrice: 0,
      consignedItemId: item.id, consignedQuantity: 2, consignedPrice: 2000,
    });

    // No sales order at all: the shop sold nothing of its own.
    expect(order).toBeNull();
    expect(await db.salesOrder.count()).toBe(0);

    expect(Number(consigned.total)).toBe(4000);
    expect(await balance("1115")).toBeCloseTo(4000, 2);
    expect(await balance("4160")).toBeCloseTo(-1000, 2);
    expect(await balance("2500")).toBeCloseTo(-3000, 2);
    expect(await ledgerGap()).toBeCloseTo(0, 6);
  });

  it("leaves the shop holding exactly what it owes", async () => {
    await ownStock(5, "600");
    const item = await consignedGoods(3, "2000");

    await mixedBasket({
      ownQuantity: 2, ownPrice: 1500,
      consignedItemId: item.id, consignedQuantity: 1, consignedPrice: 2000,
    });

    const held = await totalOwedToConsignors();
    expect(held.toNumber()).toBe(1500);
    // The drawer holds 5,000, of which 1,500 is not the shop's to spend.
    expect(await balance("2500")).toBeCloseTo(-held.toNumber(), 2);
  });
});

describe("a discounted consigned garment", () => {
  it("takes the discount off both shares", async () => {
    await ownStock(5, "600");
    const item = await consignedGoods(3, "2000");

    const { consigned } = await mixedBasket({
      ownQuantity: 1, ownPrice: 1500,
      consignedItemId: item.id, consignedQuantity: 1, consignedPrice: 1600,
    });

    // Sold for 1,600 rather than the 2,000 ticket: the shop takes 25% of what
    // was actually paid, and the owner bears the rest of the reduction.
    expect(Number(consigned.commission)).toBe(400);
    expect(Number(consigned.owedToOwner)).toBe(1200);
    expect(await balance("1115")).toBeCloseTo(1500 + 1600, 2);
  });
});

describe("what the till is given to sell", () => {
  it("offers only consigned goods at this location with some left", async () => {
    const here = await consignedGoods(2, "2000");
    const other = await db.location.findFirstOrThrow({ where: { code: "LOC-CAI" } });

    await receiveConsignment(
      {
        consignorId, description: "فستان القاهرة", quantity: 2,
        retailPrice: "1800", locationId: other.id, receivedDate: day,
      },
      ctx,
    );

    const rail = await sellableConsignedStock(locationId);
    expect(rail.map((r) => r.itemId)).toEqual([here.id]);
  });

  it("drops an item once it has all gone", async () => {
    const item = await consignedGoods(1, "2000");
    await sellConsignedItem(
      { itemId: item.id, quantity: 1, paymentMethod: "CASH", saleDate: day },
      ctx,
    );

    // A cashier must not be offered something that is no longer on the rail.
    expect(await sellableConsignedStock(locationId)).toHaveLength(0);
  });

  it("carries the rate so the till can show the split before selling", async () => {
    await consignedGoods(2, "2000");
    const rail = await sellableConsignedStock(locationId);
    expect(Number(rail[0].commissionRate)).toBe(0.25);
    expect(rail[0].consignorName).toBe("ميزون نور");
  });
});
