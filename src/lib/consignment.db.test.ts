import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import {
  createConsignor,
  receiveConsignment,
  sellConsignedItem,
  returnToConsignor,
  settleConsignor,
  owedTo,
  consignedStock,
  consignorPositions,
  recentConsignmentSales,
  totalOwedToConsignors,
  ConsignmentError,
} from "./consignment";
import { dec } from "./money";

/**
 * Selling somebody else's goods for a share of the price.
 *
 * Everything here defends one distinction. The garments are not the shop's
 * stock, and the money is not the shop's takings. Get that wrong and the
 * business reports assets it does not own and turnover it never earned —
 * and both errors flatter it, which is why nobody notices.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let locationId: string;
let brandId: string;
let consignorId: string;
let day: Date;

const ctx = { userId: null as string | null, reason: null };

beforeAll(async () => {
  brandId = (await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } })).id;
  locationId = (await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } })).id;

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
    // The ledger is cleared here, so the subledgers it summarises have to go
    // with it. Leaving lots and orders behind would exit with an inconsistent
    // database, and the next reconciliation would report a difference this
    // file caused.
    await db.garmentUnit.deleteMany({});
    await db.salesPayment.deleteMany({});
    await db.salesOrderLine.deleteMany({});
    await db.salesOrder.deleteMany({});
    await db.inventoryMovement.deleteMany({});
    await db.inventoryLot.deleteMany({});
    await db.expensePayment.deleteMany({});
    await db.expense.deleteMany({});
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
      { code: "MAISON", name: "ميزون نور", commissionRate: "0.25", settlementDays: 14 },
      ctx,
    )
  ).id;
});

afterAll(async () => {
  await wipe();
  await db.$disconnect();
});

async function accountBalance(code: string) {
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

function goods(quantity = 3, price = "2000", rate?: string) {
  return receiveConsignment(
    {
      consignorId,
      description: "فستان سواريه",
      size: "M",
      colour: "أحمر",
      quantity,
      retailPrice: price,
      commissionRate: rate ?? null,
      locationId,
      receivedDate: day,
    },
    ctx,
  );
}

describe("goods that are not the shop's", () => {
  it("never become inventory", async () => {
    const lotsBefore = await db.inventoryLot.count();
    await goods(3);

    // The single most important assertion in this file. Stock valuation,
    // GMROI and dead-stock all read inventory_lots without asking whose
    // goods they are.
    expect(await db.inventoryLot.count()).toBe(lotsBefore);
  });

  it("posts nothing when they arrive", async () => {
    const before = await db.journalEntry.count();
    await goods(3);

    // Nothing was bought and nothing became an asset: three dresses on a rail
    // that belong to somebody else are not a transaction.
    expect(await db.journalEntry.count()).toBe(before);
  });

  it("shows on the rail with whose they are and what the shop takes", async () => {
    await goods(3);
    const rail = await consignedStock();

    expect(rail).toHaveLength(1);
    expect(rail[0].consignorName).toBe("ميزون نور");
    expect(rail[0].left).toBe(3);
    expect(rail[0].commissionPct).toBe("25.0");
  });
});

describe("when one sells", () => {
  it("books the commission as revenue and the rest as a debt", async () => {
    const item = await goods(3, "2000");
    const sale = await sellConsignedItem(
      { itemId: item.id, quantity: 1, paymentMethod: "CASH", saleDate: day },
      ctx,
    );

    expect(Number(sale.total)).toBe(2000);
    expect(Number(sale.commission)).toBe(500);
    expect(Number(sale.owedToOwner)).toBe(1500);

    // The whole 2,000 came in the door.
    expect(await accountBalance("1115")).toBeCloseTo(2000, 2);
    // Only 500 of it is income. Booking 2,000 would inflate turnover with
    // money that was never the shop's.
    expect(await accountBalance("4160")).toBeCloseTo(-500, 2);
    // The other 1,500 is owed from the moment the dress left.
    expect(await accountBalance("2500")).toBeCloseTo(-1500, 2);
    expect(await ledgerGap()).toBeCloseTo(0, 6);
  });

  it("adds nothing to the shop's own sales revenue", async () => {
    const item = await goods(3, "2000");
    await sellConsignedItem(
      { itemId: item.id, quantity: 1, paymentMethod: "CASH", saleDate: day },
      ctx,
    );

    // 4130 is the shop's own showroom sales. A consignment sale must not
    // appear there, or channel reporting counts other people's turnover.
    expect(await accountBalance("4130")).toBeCloseTo(0, 2);
  });

  it("takes no cost of sales, because nothing of the shop's left", async () => {
    const item = await goods(3, "2000");
    await sellConsignedItem(
      { itemId: item.id, quantity: 1, paymentMethod: "CASH", saleDate: day },
      ctx,
    );
    expect(await accountBalance("5300")).toBeCloseTo(0, 2);
  });

  it("splits to the piastre, with the owner taking the remainder", async () => {
    // 333.33 at 25% is 83.3325 — the rounding has to land somewhere.
    const item = await goods(1, "333.33");
    const sale = await sellConsignedItem(
      { itemId: item.id, quantity: 1, paymentMethod: "CASH", saleDate: day },
      ctx,
    );

    expect(Number(sale.commission) + Number(sale.owedToOwner)).toBeCloseTo(333.33, 2);
    expect(await ledgerGap()).toBeCloseTo(0, 6);
  });

  it("honours a rate agreed for one piece", async () => {
    const item = await goods(1, "2000", "0.4");
    const sale = await sellConsignedItem(
      { itemId: item.id, quantity: 1, paymentMethod: "CASH", saleDate: day },
      ctx,
    );
    expect(Number(sale.commission)).toBe(800);
  });

  it("takes a discount off the owner and the shop together", async () => {
    const item = await goods(1, "2000");
    const sale = await sellConsignedItem(
      { itemId: item.id, quantity: 1, soldPrice: "1600", paymentMethod: "CASH", saleDate: day },
      ctx,
    );

    // Sold for less than the ticket: 25% of 1,600, not of 2,000.
    expect(Number(sale.commission)).toBe(400);
    expect(Number(sale.owedToOwner)).toBe(1200);
  });

  it("freezes the rate onto the sale", async () => {
    const item = await goods(1, "2000");
    await sellConsignedItem(
      { itemId: item.id, quantity: 1, paymentMethod: "CASH", saleDate: day },
      ctx,
    );

    await db.consignor.update({
      where: { id: consignorId },
      data: { commissionRate: "0.5" },
    });

    // Changing the rate later must not rewrite what was owed on a sale that
    // already happened.
    const sale = await db.consignmentSale.findFirstOrThrow({});
    expect(Number(sale.commissionRate)).toBe(0.25);
    expect(Number(sale.commissionAmount)).toBe(500);
  });

  it("counts down what is left on the rail", async () => {
    const item = await goods(3);
    await sellConsignedItem(
      { itemId: item.id, quantity: 2, paymentMethod: "CARD", saleDate: day },
      ctx,
    );

    expect((await consignedStock())[0].left).toBe(1);
  });

  it("refuses to sell more than is there", async () => {
    const item = await goods(2);
    await expect(
      sellConsignedItem(
        { itemId: item.id, quantity: 3, paymentMethod: "CASH", saleDate: day },
        ctx,
      ),
    ).rejects.toThrow(/only 2/i);
  });

  it("refuses once they have all gone", async () => {
    const item = await goods(1);
    await sellConsignedItem(
      { itemId: item.id, quantity: 1, paymentMethod: "CASH", saleDate: day },
      ctx,
    );
    await expect(
      sellConsignedItem(
        { itemId: item.id, quantity: 1, paymentMethod: "CASH", saleDate: day },
        ctx,
      ),
    ).rejects.toThrow(/none left/i);
  });

  it("leaves nothing behind when it refuses", async () => {
    const item = await goods(1);
    const journals = await db.journalEntry.count();

    await expect(
      sellConsignedItem(
        { itemId: item.id, quantity: 9, paymentMethod: "CASH", saleDate: day },
        ctx,
      ),
    ).rejects.toThrow(ConsignmentError);

    expect(await db.journalEntry.count()).toBe(journals);
    expect(await db.consignmentSale.count()).toBe(0);
  });
});

describe("a commission that is not a fraction", () => {
  it("refuses 25 where 0.25 was meant", async () => {
    // Percentages are fractions everywhere in this system. Twenty-five here
    // would pay the shop twenty-five times the sale price.
    await expect(
      createConsignor({ code: "BAD", name: "غلط", commissionRate: "25" }, ctx),
    ).rejects.toThrow(/not a fraction/i);
  });

  it("refuses it on a single item too", async () => {
    await expect(goods(1, "2000", "40")).rejects.toThrow(/fraction/i);
  });

  it("refuses a duplicate code", async () => {
    await expect(
      createConsignor({ code: "MAISON", name: "حد تاني", commissionRate: "0.2" }, ctx),
    ).rejects.toThrow(/already/i);
  });
});

describe("giving back what did not sell", () => {
  it("takes them off the rail without touching the books", async () => {
    const item = await goods(3);
    const journals = await db.journalEntry.count();

    const result = await returnToConsignor({ itemId: item.id, quantity: 2 }, ctx);

    expect(result.left).toBe(1);
    // They were never the shop's, so handing them back changes nothing about
    // what it owns or owes.
    expect(await db.journalEntry.count()).toBe(journals);
  });

  it("refuses to give back what was already sold", async () => {
    const item = await goods(2);
    await sellConsignedItem(
      { itemId: item.id, quantity: 1, paymentMethod: "CASH", saleDate: day },
      ctx,
    );

    await expect(
      returnToConsignor({ itemId: item.id, quantity: 2 }, ctx),
    ).rejects.toThrow(/only 1/i);
  });

  it("marks goods held past the date the owner wanted them back", async () => {
    await receiveConsignment(
      {
        consignorId, description: "جاكيت", quantity: 2, retailPrice: "1500",
        locationId, receivedDate: new Date(day.getTime() - 60 * 86_400_000),
        expiresAt: new Date(day.getTime() - 30 * 86_400_000),
      },
      ctx,
    );

    expect((await consignedStock()).find((i) => i.description === "جاكيت")!.overdue).toBe(true);
  });

  it("refuses a return-by date before the goods arrived", async () => {
    await expect(
      receiveConsignment(
        {
          consignorId, description: "بلوزة", quantity: 1, retailPrice: "800",
          locationId, receivedDate: day,
          expiresAt: new Date(day.getTime() - 86_400_000),
        },
        ctx,
      ),
    ).rejects.toThrow(/before the goods arrived/i);
  });
});

describe("paying the owner", () => {
  it("clears the debt and the money leaves", async () => {
    const item = await goods(3, "2000");
    await sellConsignedItem(
      { itemId: item.id, quantity: 2, paymentMethod: "CASH", saleDate: day },
      ctx,
    );

    expect((await owedTo(consignorId)).toNumber()).toBe(3000);
    expect(await accountBalance("2500")).toBeCloseTo(-3000, 2);

    const settlement = await settleConsignor(
      { consignorId, method: "BANK_TRANSFER", paidOn: day },
      ctx,
    );

    expect(Number(settlement.amount)).toBe(3000);
    expect((await owedTo(consignorId)).toNumber()).toBe(0);
    expect(await accountBalance("2500")).toBeCloseTo(0, 2);
    expect(await accountBalance("1120")).toBeCloseTo(-3000, 2);
    expect(await ledgerGap()).toBeCloseTo(0, 6);
  });

  it("keeps the shop's commission out of what is paid over", async () => {
    const item = await goods(1, "2000");
    await sellConsignedItem(
      { itemId: item.id, quantity: 1, paymentMethod: "CASH", saleDate: day },
      ctx,
    );
    const settlement = await settleConsignor({ consignorId, method: "CASH", paidOn: day }, ctx);

    // 2,000 came in, 1,500 goes out, 500 stays as earnings.
    expect(Number(settlement.amount)).toBe(1500);
    expect(await accountBalance("4160")).toBeCloseTo(-500, 2);
  });

  it("settles whole sales, oldest first", async () => {
    const item = await goods(3, "1000");
    await sellConsignedItem(
      { itemId: item.id, quantity: 1, paymentMethod: "CASH", saleDate: day },
      ctx,
    );
    await sellConsignedItem(
      { itemId: item.id, quantity: 1, paymentMethod: "CASH", saleDate: day },
      ctx,
    );

    // Each sale owes 750. Paying 800 covers one, not one and a bit: a
    // half-settled sale could not say which half.
    const settlement = await settleConsignor(
      { consignorId, method: "CASH", paidOn: day, amount: "800" },
      ctx,
    );
    expect(Number(settlement.amount)).toBe(750);
    expect(settlement.salesCovered).toBe(1);
    expect((await owedTo(consignorId)).toNumber()).toBe(750);
  });

  it("refuses to pay more than is owed", async () => {
    const item = await goods(1, "1000");
    await sellConsignedItem(
      { itemId: item.id, quantity: 1, paymentMethod: "CASH", saleDate: day },
      ctx,
    );

    await expect(
      settleConsignor({ consignorId, method: "CASH", paidOn: day, amount: "5000" }, ctx),
    ).rejects.toThrow(/is more than that/i);
  });

  it("refuses when nothing is owed", async () => {
    await goods(2);
    await expect(
      settleConsignor({ consignorId, method: "CASH", paidOn: day }, ctx),
    ).rejects.toThrow(/nothing is owed/i);
  });

  it("does not pay the same sale twice", async () => {
    const item = await goods(1, "1000");
    await sellConsignedItem(
      { itemId: item.id, quantity: 1, paymentMethod: "CASH", saleDate: day },
      ctx,
    );
    await settleConsignor({ consignorId, method: "CASH", paidOn: day }, ctx);

    await expect(
      settleConsignor({ consignorId, method: "CASH", paidOn: day }, ctx),
    ).rejects.toThrow(/nothing is owed/i);
  });
});

describe("what the shop can see", () => {
  it("shows each owner's position", async () => {
    const item = await goods(4, "2000");
    await sellConsignedItem(
      { itemId: item.id, quantity: 2, paymentMethod: "CASH", saleDate: day },
      ctx,
    );

    const position = (await consignorPositions()).find((c) => c.id === consignorId)!;
    expect(position.itemsOnRail).toBe(2);
    expect(Number(position.takings)).toBe(4000);
    expect(Number(position.commissionEarned)).toBe(1000);
    expect(Number(position.owed)).toBe(3000);
  });

  it("totals what is being held for other people", async () => {
    const item = await goods(2, "1000");
    await sellConsignedItem(
      { itemId: item.id, quantity: 2, paymentMethod: "CASH", saleDate: day },
      ctx,
    );

    const held = await totalOwedToConsignors();
    expect(held.toNumber()).toBe(1500);
    // Which is exactly what the liability account says.
    expect(await accountBalance("2500")).toBeCloseTo(-held.toNumber(), 2);
  });

  it("lists sales with both shares and whether the owner has been paid", async () => {
    const item = await goods(1, "2000");
    await sellConsignedItem(
      { itemId: item.id, quantity: 1, paymentMethod: "CARD", saleDate: day },
      ctx,
    );

    let rows = await recentConsignmentSales();
    expect(rows[0].settled).toBe(false);
    expect(Number(rows[0].commission)).toBe(500);
    expect(Number(rows[0].owedToOwner)).toBe(1500);

    await settleConsignor({ consignorId, method: "CASH", paidOn: day }, ctx);
    rows = await recentConsignmentSales();
    expect(rows[0].settled).toBe(true);
    expect(rows[0].settlementNumber).toMatch(/^CST-/);
  });
});
