import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { receiveFinishedGoods } from "./inventory";
import { createSale, SalesError } from "./sales";
import {
  collectPayment,
  customerBalances,
  customerStatement,
  outstandingForCustomer,
  openOrdersForCustomer,
  setCreditTerms,
  ReceivableError,
} from "./receivables";
import { dec } from "./money";

/**
 * Paying part now and the rest later.
 *
 * The dangerous thing about credit is not bad debt — it is a receivables
 * account that stops matching what the orders say people owe. So every test
 * here ends up asking the same question two ways: what does the customer's
 * account say, and what does account 1210 say. They have to agree.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let brandId: string;
let showroomId: string;
let variantId: string;
let channelId: string;
let customerId: string;
let strangerId: string;
let day: Date;

const ctx = { userId: null as string | null, reason: null };

beforeAll(async () => {
  brandId = (await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } })).id;
  showroomId = (await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } })).id;
  variantId = (await db.variant.findFirstOrThrow()).id;
  channelId = (await db.salesChannel.findFirstOrThrow()).id;

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
    await db.inventoryMovement.deleteMany({});
    await db.inventoryLot.deleteMany({});
    await db.journalLine.deleteMany({});
    await db.journalEntry.deleteMany({});
    await db.auditLog.deleteMany({});
    await db.documentSequence.deleteMany({});
    await db.customer.deleteMany({ where: { code: { startsWith: "AR-" } } });
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
  }

  // A customer the shop knows, and one it does not.
  const known = await db.customer.create({
    data: {
      code: "AR-KNOWN", name: "سلمى منصور", phone: "01000000001",
      creditLimit: "5000", creditDays: 30,
    },
  });
  customerId = known.id;

  const stranger = await db.customer.create({
    data: { code: "AR-STRANGER", name: "زبون جديد", phone: "01000000002" },
  });
  strangerId = stranger.id;
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await db.$disconnect();
});

async function givenStock(quantity = 50) {
  await receiveFinishedGoods(
    {
      variantId, locationId: showroomId, entityId: brandId,
      quantity: String(quantity), unitCost: "500", materialUnitCost: "400",
      receivedDate: day,
    },
    ctx,
  );
}

/** A sale of one piece at `price`, with `paid` handed over at the till. */
async function partPaidSale(price: number, paid: number, customer = customerId) {
  return createSale(
    {
      source: "MANUAL", channelId, entityId: brandId, locationId: showroomId,
      customerId: customer,
      orderDate: day,
      lines: [{ variantId, quantity: 1, retailPrice: price, discountPct: 0 }],
      payments:
        paid > 0
          ? [{ method: "CASH", amount: paid, fee: 0, collected: true }]
          : [],
    },
    ctx,
  );
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

async function ledgerGap() {
  const rows = await db.journalLine.findMany({
    where: { journalEntry: { status: "POSTED" } },
    select: { debit: true, credit: true },
  });
  return rows
    .reduce((s, r) => s.plus(dec(r.debit)).minus(dec(r.credit)), dec(0))
    .toNumber();
}

describe("paying part of the price", () => {
  it("takes 1000 against 1500 and books the rest as owed", async () => {
    await givenStock();
    await partPaidSale(1500, 1000);

    expect((await outstandingForCustomer(customerId)).toNumber()).toBe(500);
    // The drawer got exactly what was handed over, and the customer's tab
    // carries the difference.
    expect(await accountBalance("1115")).toBeCloseTo(1000, 2);
    expect(await accountBalance("1210")).toBeCloseTo(500, 2);
    expect(await ledgerGap()).toBeCloseTo(0, 6);
  });

  it("still takes the money in full when they pay it all", async () => {
    await givenStock();
    await partPaidSale(1500, 1500);

    expect((await outstandingForCustomer(customerId)).toNumber()).toBe(0);
    expect(await accountBalance("1210")).toBeCloseTo(0, 2);
  });

  it("treats paying nothing as owing everything", async () => {
    await givenStock();
    await partPaidSale(1500, 0);

    expect((await outstandingForCustomer(customerId)).toNumber()).toBe(1500);
    expect(await accountBalance("1210")).toBeCloseTo(1500, 2);
  });

  it("refuses to take more than the order comes to", async () => {
    await givenStock();
    await expect(partPaidSale(1500, 1800)).rejects.toThrow(/only comes to/i);
  });

  it("refuses credit to nobody in particular", async () => {
    await givenStock();
    // A debt with no name on it cannot be chased.
    await expect(
      createSale(
        {
          source: "MANUAL", channelId, entityId: brandId, locationId: showroomId,
          customerId: null, orderDate: day,
          lines: [{ variantId, quantity: 1, retailPrice: 1500, discountPct: 0 }],
          payments: [{ method: "CASH", amount: 1000, fee: 0, collected: true }],
        },
        ctx,
      ),
    ).rejects.toThrow(/customer's name/i);
  });

  it("sets the due date from the customer's own terms", async () => {
    await givenStock();
    const sale = await partPaidSale(1500, 1000);

    const order = await db.salesOrder.findUniqueOrThrow({
      where: { id: sale.salesOrderId },
    });
    const expected = new Date(day);
    expected.setDate(expected.getDate() + 30);
    expect(order.dueDate?.toISOString().slice(0, 10)).toBe(
      expected.toISOString().slice(0, 10),
    );
  });

  it("leaves no due date on a sale that was paid for", async () => {
    await givenStock();
    const sale = await partPaidSale(1500, 1500);
    const order = await db.salesOrder.findUniqueOrThrow({
      where: { id: sale.salesOrderId },
    });
    expect(order.dueDate).toBeNull();
  });
});

describe("the credit limit", () => {
  it("stops a stranger walking out owing money", async () => {
    await givenStock();
    // A new customer's limit is zero, which is the right default for somebody
    // who walked in off the street.
    await expect(partPaidSale(1500, 1000, strangerId)).rejects.toThrow(/over their/i);
  });

  it("counts what they already owe, not just this sale", async () => {
    await givenStock();
    await partPaidSale(4000, 1000); // owes 3,000 of a 5,000 limit

    // Another 2,500 owing would put them at 5,500.
    await expect(partPaidSale(3000, 500)).rejects.toThrow(/of it from before/i);
  });

  it("lets them right up to the limit", async () => {
    await givenStock();
    await partPaidSale(3500, 500); // owes 3,000
    await partPaidSale(2500, 500); // owes 2,000 — exactly 5,000 together

    expect((await outstandingForCustomer(customerId)).toNumber()).toBe(5000);
    expect(await accountBalance("1210")).toBeCloseTo(5000, 2);
  });

  it("frees the headroom up again once they pay", async () => {
    await givenStock();
    const first = await partPaidSale(6000, 1000); // owes 5,000: at the limit
    await expect(partPaidSale(1000, 100)).rejects.toThrow(/over their/i);

    await collectPayment(
      { salesOrderId: first.salesOrderId, method: "CASH", amount: "5000", collectedOn: day },
      ctx,
    );

    // Now there is room again.
    const second = await partPaidSale(1000, 100);
    expect(second.salesOrderId).toBeTruthy();
  });

  it("does not apply to an order with no payment recorded at all", async () => {
    await givenStock();
    // Deliberate, and worth stating plainly: a Shopify order the courier has
    // not remitted, or a wholesale order awaiting its invoice, is unsettled
    // rather than lent. Those predate credit, need no named customer, and are
    // not the decision the limit governs. The debt still shows on the aging.
    const sale = await createSale(
      {
        source: "SHOPIFY", channelId, entityId: brandId, locationId: showroomId,
        customerId: strangerId, externalId: "no-payment-1", orderDate: day,
        lines: [{ variantId, quantity: 1, retailPrice: 9000, discountPct: 0 }],
        payments: [],
      },
      ctx,
    );

    expect(sale.salesOrderId).toBeTruthy();
    // The stranger's limit is zero, and yet the debt is visible and chaseable.
    expect((await outstandingForCustomer(strangerId)).toNumber()).toBe(9000);
    const balances = await customerBalances(day);
    expect(Number(balances.find((b) => b.customerId === strangerId)!.outstanding)).toBe(9000);
  });

  it("cannot be set below what is already owed", async () => {
    await givenStock();
    await partPaidSale(3000, 0);

    await expect(
      setCreditTerms({ customerId, creditLimit: "1000", creditDays: 30 }, ctx),
    ).rejects.toThrow(/already owes/i);
  });

  it("refuses a negative limit", async () => {
    await expect(
      setCreditTerms({ customerId, creditLimit: "-1", creditDays: 30 }, ctx),
    ).rejects.toThrow(ReceivableError);
  });
});

describe("collecting later", () => {
  it("moves the money off the tab and into the drawer", async () => {
    await givenStock();
    const sale = await partPaidSale(1500, 1000);

    const result = await collectPayment(
      { salesOrderId: sale.salesOrderId, method: "CASH", amount: "500", collectedOn: day },
      ctx,
    );

    expect(Number(result.stillOwed)).toBe(0);
    expect((await outstandingForCustomer(customerId)).toNumber()).toBe(0);
    expect(await accountBalance("1210")).toBeCloseTo(0, 2);
    expect(await accountBalance("1115")).toBeCloseTo(1500, 2);
    expect(await ledgerGap()).toBeCloseTo(0, 6);
  });

  it("takes it in pieces", async () => {
    await givenStock();
    const sale = await partPaidSale(1500, 0);

    await collectPayment(
      { salesOrderId: sale.salesOrderId, method: "CASH", amount: "600", collectedOn: day },
      ctx,
    );
    const second = await collectPayment(
      { salesOrderId: sale.salesOrderId, method: "BANK_TRANSFER", amount: "400", collectedOn: day },
      ctx,
    );

    expect(Number(second.stillOwed)).toBe(500);
    expect(await accountBalance("1210")).toBeCloseTo(500, 2);
    // Cash went to the drawer, the transfer to the bank.
    expect(await accountBalance("1115")).toBeCloseTo(600, 2);
    expect(await accountBalance("1120")).toBeCloseTo(400, 2);
  });

  it("refuses to take more than is owed", async () => {
    await givenStock();
    const sale = await partPaidSale(1500, 1000);

    // Otherwise the receivables account goes negative and the books start
    // claiming the shop owes the customer.
    await expect(
      collectPayment(
        { salesOrderId: sale.salesOrderId, method: "CASH", amount: "900", collectedOn: day },
        ctx,
      ),
    ).rejects.toThrow(/is too much/i);
  });

  it("refuses to collect against a settled order", async () => {
    await givenStock();
    const sale = await partPaidSale(1500, 1500);

    await expect(
      collectPayment(
        { salesOrderId: sale.salesOrderId, method: "CASH", amount: "1", collectedOn: day },
        ctx,
      ),
    ).rejects.toThrow(/already paid in full/i);
  });

  it("refuses zero", async () => {
    await givenStock();
    const sale = await partPaidSale(1500, 1000);
    await expect(
      collectPayment(
        { salesOrderId: sale.salesOrderId, method: "CASH", amount: "0", collectedOn: day },
        ctx,
      ),
    ).rejects.toThrow(ReceivableError);
  });

  it("records when the money actually landed, once it all has", async () => {
    await givenStock();
    const sale = await partPaidSale(1500, 500);

    const later = new Date(day.getTime() + 10 * 86_400_000);
    await collectPayment(
      { salesOrderId: sale.salesOrderId, method: "CASH", amount: "1000", collectedOn: later },
      ctx,
    );

    const order = await db.salesOrder.findUniqueOrThrow({ where: { id: sale.salesOrderId } });
    expect(order.collectedDate?.toISOString().slice(0, 10)).toBe(
      later.toISOString().slice(0, 10),
    );
    // Nothing is due any more, so it should stop appearing on the aging.
    expect(order.dueDate).toBeNull();
  });

  it("leaves nothing behind when it fails", async () => {
    await givenStock();
    const sale = await partPaidSale(1500, 1000);

    const payments = await db.salesPayment.count();
    const journals = await db.journalEntry.count();

    await expect(
      collectPayment(
        { salesOrderId: sale.salesOrderId, method: "CASH", amount: "5000", collectedOn: day },
        ctx,
      ),
    ).rejects.toThrow();

    expect(await db.salesPayment.count()).toBe(payments);
    expect(await db.journalEntry.count()).toBe(journals);
  });
});

describe("what the shop can see", () => {
  it("lists who owes what, and how much room is left", async () => {
    await givenStock();
    await partPaidSale(1500, 1000);

    const balances = await customerBalances(day);
    const row = balances.find((b) => b.customerId === customerId)!;

    expect(Number(row.outstanding)).toBe(500);
    expect(Number(row.headroom)).toBe(4500);
    expect(row.orders).toBe(1);
  });

  it("separates what is late from what is merely unpaid", async () => {
    await givenStock();
    await partPaidSale(1500, 1000);

    // On the day of the sale, nothing on thirty-day terms is late.
    const today = await customerBalances(day);
    expect(Number(today.find((b) => b.customerId === customerId)!.overdue)).toBe(0);
    expect(Number(today.find((b) => b.customerId === customerId)!.notYetDue)).toBe(500);

    // Forty days on, it is.
    const later = new Date(day.getTime() + 40 * 86_400_000);
    const then = await customerBalances(later);
    expect(Number(then.find((b) => b.customerId === customerId)!.overdue)).toBe(500);
  });

  it("leaves settled customers off the list entirely", async () => {
    await givenStock();
    await partPaidSale(1500, 1500);

    const balances = await customerBalances(day);
    expect(balances.find((b) => b.customerId === customerId)).toBeUndefined();
  });

  it("shows one customer's account order by order", async () => {
    await givenStock();
    await partPaidSale(1500, 1000);
    await partPaidSale(2000, 0);

    const statement = await customerStatement(customerId);
    expect(statement.lines).toHaveLength(2);
    expect(Number(statement.totals.outstanding)).toBe(2500);
    expect(Number(statement.totals.headroom)).toBe(2500);
  });

  it("offers only the orders with money still on them", async () => {
    await givenStock();
    await partPaidSale(1500, 1500); // settled
    await partPaidSale(2000, 500);  // 1,500 left

    const open = await openOrdersForCustomer(customerId);
    expect(open).toHaveLength(1);
    expect(Number(open[0].outstanding)).toBe(1500);
  });
});

describe("the books agree with the tab", () => {
  it("keeps receivables equal to what customers owe, through everything", async () => {
    await givenStock();
    const a = await partPaidSale(1500, 1000);
    await partPaidSale(2000, 0);
    await collectPayment(
      { salesOrderId: a.salesOrderId, method: "CARD", amount: "200", collectedOn: day },
      ctx,
    );

    const owed = (await outstandingForCustomer(customerId)).toNumber();
    // 500 − 200 + 2000
    expect(owed).toBe(2300);
    expect(await accountBalance("1210")).toBeCloseTo(owed, 2);
    expect(await ledgerGap()).toBeCloseTo(0, 6);
  });
});
