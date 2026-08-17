import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { receiveFinishedGoods } from "./inventory";
import { createSale, openPosSession, closePosSession, SalesError } from "./sales";
import { dec } from "./money";

/** The unified Brand order engine, against a real database. */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let brandId: string;
let channelId: string;
let locationId: string;
let variantId: string;
let cashierId: string;
let customerId: string;
let day: Date;

const UNIT_COST = "422.6265";
const RETAIL = 880;

const ctx = { userId: null as string | null, reason: null };

beforeAll(async () => {
  brandId = (await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } })).id;
  channelId = (await db.salesChannel.findFirstOrThrow()).id;
  locationId = (await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } })).id;
  variantId = (await db.variant.findFirstOrThrow()).id;
  cashierId = (await db.user.findFirstOrThrow({ where: { email: "owner@cashmere.eg" } })).id;
  customerId = (await db.customer.findFirst())?.id ?? "";

  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" }, orderBy: { startDate: "asc" },
  });
  day = new Date(period.startDate);
});

async function wipe() {
  await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
  await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
  try {
    await db.settlementLine.deleteMany({});
    await db.settlement.deleteMany({});
    await db.salesPayment.deleteMany({});
    await db.salesOrderLine.deleteMany({});
    await db.salesOrder.deleteMany({});
    await db.posSession.deleteMany({});
    await db.inventoryMovement.deleteMany({});
    await db.inventoryLot.deleteMany({});
    await db.bankStatementLine.deleteMany({});
    await db.bankStatement.deleteMany({});
    await db.journalLine.deleteMany({});
    await db.journalEntry.deleteMany({});
    await db.auditLog.deleteMany({});
    await db.documentSequence.deleteMany({});
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
  }
}

/** Brand stock on the shelf at Alexandria, at transfer-price cost. */
async function givenStock(quantity = "50") {
  await receiveFinishedGoods(
    {
      variantId, locationId, entityId: brandId,
      quantity, unitCost: UNIT_COST, materialUnitCost: "344.40",
      receivedDate: day,
    },
    ctx,
  );
}

beforeEach(async () => {
  await wipe();
  await givenStock();
});

afterAll(async () => { await wipe(); await db.$disconnect(); });

async function accountBalance(code: string): Promise<number> {
  const [row] = await db.$queryRaw<{ balance: string }[]>`
    SELECT COALESCE(SUM(l."debit") - SUM(l."credit"), 0)::text AS balance
    FROM "journal_lines" l
    JOIN "journal_entries" e ON e."id" = l."journalEntryId"
    JOIN "accounts" a ON a."id" = l."accountId"
    WHERE a."code" = ${code} AND e."status" = 'POSTED'
  `;
  return Number(row.balance);
}

function saleInput(over: Partial<Parameters<typeof createSale>[0]> = {}) {
  return {
    source: "MODERATOR" as const,
    channelId, entityId: brandId, locationId,
    orderDate: day,
    lines: [{ variantId, quantity: 2, retailPrice: RETAIL, discountPct: 0 }],
    payments: [],
    ...over,
  };
}

describe("one engine, many sources", () => {
  it("records a moderator order and names the moderator", async () => {
    const result = await createSale(saleInput(), { userId: cashierId });

    const order = await db.salesOrder.findUniqueOrThrow({
      where: { id: result.salesOrderId },
      include: { lines: true },
    });
    expect(order.source).toBe("MODERATOR");
    expect(order.createdByUserId).toBe(cashierId);
    expect(order.lines).toHaveLength(1);
    expect(Number(order.netAmount)).toBe(RETAIL * 2);
  });

  it("refuses a moderator order with no moderator attached", async () => {
    await expect(createSale(saleInput(), { userId: null })).rejects.toThrow(
      /must record which moderator/i,
    );
  });

  it("routes revenue to a different account per source", async () => {
    await createSale(saleInput({ source: "MODERATOR" }), { userId: cashierId });
    await createSale(
      saleInput({ source: "SHOPIFY", externalId: "shopify-1001" }),
      { userId: null },
    );

    // 4120 social, 4110 website — channel P&L needs no guesswork later.
    expect(await accountBalance("4120")).toBe(-(RETAIL * 2));
    expect(await accountBalance("4110")).toBe(-(RETAIL * 2));
  });

  it("relieves stock and books cost of goods at FIFO cost", async () => {
    const result = await createSale(saleInput(), { userId: cashierId });

    expect(Number(result.cogs)).toBeCloseTo(Number(UNIT_COST) * 2, 4);
    expect(await accountBalance("5300")).toBeCloseTo(Number(UNIT_COST) * 2, 2);

    const lot = await db.inventoryLot.findFirstOrThrow({ where: { variantId } });
    expect(lot.remainingQty.toString()).toBe("48");
  });

  it("reports gross margin as revenue less the cost actually relieved", async () => {
    const result = await createSale(saleInput(), { userId: cashierId });
    expect(Number(result.grossMargin)).toBeCloseTo(
      RETAIL * 2 - Number(UNIT_COST) * 2, 4,
    );
  });

  it("refuses to sell stock that is not there", async () => {
    // Revenue must never be recognised for an order that cannot be fulfilled.
    await expect(
      createSale(
        saleInput({ lines: [{ variantId, quantity: 999, retailPrice: RETAIL, discountPct: 0 }] }),
        { userId: cashierId },
      ),
    ).rejects.toThrow(/Not enough finished goods/i);

    expect(await db.salesOrder.count()).toBe(0);
    expect(await accountBalance("4120")).toBe(0);
  });
});

describe("discounts", () => {
  it("shows the discount as contra-revenue rather than netting it away", async () => {
    await createSale(
      saleInput({ lines: [{ variantId, quantity: 2, retailPrice: RETAIL, discountPct: 0.25 }] }),
      { userId: cashierId },
    );

    // Gross revenue stays visible so markdown analysis has something to read.
    expect(await accountBalance("4120")).toBe(-(RETAIL * 2));
    expect(await accountBalance("4200")).toBe(RETAIL * 2 * 0.25);

    const order = await db.salesOrder.findFirstOrThrow();
    expect(Number(order.discountAmount)).toBe(RETAIL * 2 * 0.25);
    expect(Number(order.netAmount)).toBe(RETAIL * 2 * 0.75);
  });
});

describe("payments", () => {
  it("treats cash on delivery as courier clearing, not cash", async () => {
    // The courier holds it until they remit; calling it cash overstates the
    // position by whatever is still in transit.
    await createSale(
      saleInput({
        payments: [{ method: "COD", amount: RETAIL * 2, fee: 30, collected: false }],
      }),
      { userId: cashierId },
    );

    expect(await accountBalance("1135")).toBeCloseTo(RETAIL * 2 - 30, 2);
    expect(await accountBalance("1110")).toBe(0);

    const payment = await db.salesPayment.findFirstOrThrow();
    expect(payment.status).toBe("PENDING");
  });

  it("books a receivable when nothing has been paid", async () => {
    await createSale(saleInput({ payments: [] }), { userId: cashierId });
    expect(await accountBalance("1210")).toBe(RETAIL * 2);
  });

  it("expenses the processor fee rather than hiding it in revenue", async () => {
    await createSale(
      saleInput({
        payments: [{ method: "CARD", amount: RETAIL * 2, fee: 45, collected: true }],
      }),
      { userId: cashierId },
    );
    expect(await accountBalance("6230")).toBeCloseTo(45, 2);
  });

  it("refuses to take more than the order comes to", async () => {
    // Overpaying is not credit — it is a mistake or a refund waiting to
    // happen, and either way createSale is the wrong place to resolve it.
    await expect(
      createSale(
        saleInput({
          payments: [{ method: "CASH", amount: RETAIL * 5, fee: 0, collected: true }],
        }),
        { userId: cashierId },
      ),
    ).rejects.toThrow(/only comes to/i);
  });

  it("refuses to leave part of the price on a nameless tab", async () => {
    // Underpaying is allowed now — it is how somebody pays 1,000 of 1,500 —
    // but only in a named customer's account, because a debt with nobody's
    // name on it cannot be chased.
    await expect(
      createSale(
        saleInput({ payments: [{ method: "CASH", amount: 100, fee: 0, collected: true }] }),
        { userId: cashierId },
      ),
    ).rejects.toThrow(/customer's name/i);
  });

  it("invoices at a unit price the customer can verify", async () => {
    // The unit price is rounded to the piastre first, then multiplied — that
    // is what an invoice line is, and it means 554.38 × 3 reads as 1,663.14
    // rather than a total nobody can reproduce from the printed price.
    const result = await createSale(
      saleInput({
        lines: [{ variantId, quantity: 3, retailPrice: 554.3768333, discountPct: 0 }],
        payments: [{ method: "CASH", amount: 1663.14, fee: 0, collected: true }],
      }),
      { userId: cashierId },
    );

    expect(result.netAmount).toBe("1663.14");
  });

  it("keeps a discounted line payable to the piastre", async () => {
    // 15% off 99.99 is 84.9915 — an amount no customer can hand over. The
    // invoice must round it, or revenue is recognised at a figure that can
    // never be collected and the journal is short by fractions forever.
    const result = await createSale(
      saleInput({
        lines: [{ variantId, quantity: 1, retailPrice: 99.99, discountPct: 0.15 }],
        payments: [{ method: "CASH", amount: 84.99, fee: 0, collected: true }],
      }),
      { userId: cashierId },
    );

    expect(result.netAmount).toBe("84.99");
  });

  it("charges shipping as revenue on top of the goods", async () => {
    await createSale(
      saleInput({
        shippingAmount: 60,
        payments: [{ method: "COD", amount: RETAIL * 2 + 60, fee: 0, collected: false }],
      }),
      { userId: cashierId },
    );
    expect(await accountBalance("4120")).toBe(-(RETAIL * 2 + 60));
  });
});

describe("Shopify import idempotency", () => {
  it("does not duplicate an order that arrives twice", async () => {
    const first = await createSale(
      saleInput({ source: "SHOPIFY", externalId: "shopify-2002" }), { userId: null },
    );
    const second = await createSale(
      saleInput({ source: "SHOPIFY", externalId: "shopify-2002" }), { userId: null },
    );

    expect(second.salesOrderId).toBe(first.salesOrderId);
    expect(await db.salesOrder.count()).toBe(1);
    // Crucially, stock was relieved once, not twice.
    const lot = await db.inventoryLot.findFirstOrThrow({ where: { variantId } });
    expect(lot.remainingQty.toString()).toBe("48");
  });

  it("keeps the same external id distinct across different sources", async () => {
    await createSale(saleInput({ source: "SHOPIFY", externalId: "1001" }), { userId: null });

    // The POS half is paid for, because a counter sale that takes no money and
    // names nobody is refused: the garment would leave with no record of who
    // has it. The Shopify half stays unpaid, which is what a courier order is.
    await createSale(
      saleInput({
        source: "POS",
        externalId: "1001",
        payments: [{ method: "CASH", amount: RETAIL * 2, fee: 0, collected: true }],
        posSessionId: (
          await openPosSession({ locationId, cashierUserId: cashierId, openingFloat: "0" }, ctx)
        ).posSessionId,
      }),
      { userId: cashierId },
    );

    expect(await db.salesOrder.count()).toBe(2);
  });
});

describe("POS till sessions", () => {
  it("refuses a POS sale with no open till", async () => {
    await expect(
      createSale(saleInput({ source: "POS" }), { userId: cashierId }),
    ).rejects.toThrow(/must belong to an open till session/i);
  });

  it("refuses to open a second till at the same location", async () => {
    await openPosSession({ locationId, cashierUserId: cashierId, openingFloat: "500" }, ctx);
    await expect(
      openPosSession({ locationId, cashierUserId: cashierId, openingFloat: "500" }, ctx),
    ).rejects.toThrow(/still open at this location/i);
  });

  it("reconciles the drawer against cash actually taken", async () => {
    const session = await openPosSession(
      { locationId, cashierUserId: cashierId, openingFloat: "500" }, ctx,
    );
    await createSale(
      saleInput({
        source: "POS",
        posSessionId: session.posSessionId,
        payments: [{ method: "CASH", amount: RETAIL * 2, fee: 0, collected: true }],
      }),
      { userId: cashierId },
    );

    const close = await closePosSession(
      { posSessionId: session.posSessionId, countedCash: String(500 + RETAIL * 2) }, ctx,
    );

    expect(Number(close.expectedCash)).toBe(500 + RETAIL * 2);
    expect(Number(close.variance)).toBe(0);
  });

  it("records a shortfall rather than forcing the drawer to match", async () => {
    // Forcing the count to agree with the system is how a till stops being
    // evidence of anything.
    const session = await openPosSession(
      { locationId, cashierUserId: cashierId, openingFloat: "500" }, ctx,
    );
    await createSale(
      saleInput({
        source: "POS",
        posSessionId: session.posSessionId,
        payments: [{ method: "CASH", amount: RETAIL * 2, fee: 0, collected: true }],
      }),
      { userId: cashierId },
    );

    const close = await closePosSession(
      {
        posSessionId: session.posSessionId,
        countedCash: String(500 + RETAIL * 2 - 50),
        note: "Fifty pounds short, cashier notified",
      },
      ctx,
    );

    expect(Number(close.variance)).toBe(-50);

    const audit = await db.auditLog.findFirstOrThrow({
      where: { action: "POS_SESSION_CLOSED_WITH_VARIANCE" },
    });
    expect(audit.reason).toMatch(/short/i);
  });

  it("refuses to sell against a closed till", async () => {
    const session = await openPosSession(
      { locationId, cashierUserId: cashierId, openingFloat: "0" }, ctx,
    );
    await closePosSession({ posSessionId: session.posSessionId, countedCash: "0" }, ctx);

    await expect(
      createSale(
        saleInput({ source: "POS", posSessionId: session.posSessionId }),
        { userId: cashierId },
      ),
    ).rejects.toThrow(/already closed/i);
  });
});

describe("ledger integrity", () => {
  it("balances after every kind of sale", async () => {
    const session = await openPosSession(
      { locationId, cashierUserId: cashierId, openingFloat: "300" }, ctx,
    );
    await createSale(saleInput({ source: "MODERATOR" }), { userId: cashierId });
    await createSale(
      saleInput({
        source: "SHOPIFY", externalId: "s-1",
        payments: [{ method: "COD", amount: RETAIL * 2, fee: 25, collected: false }],
      }),
      { userId: null },
    );
    await createSale(
      saleInput({
        source: "POS", posSessionId: session.posSessionId,
        lines: [{ variantId, quantity: 1, retailPrice: RETAIL, discountPct: 0.1 }],
        payments: [{ method: "CASH", amount: RETAIL * 0.9, fee: 0, collected: true }],
      }),
      { userId: cashierId },
    );

    const [row] = await db.$queryRaw<{ debit: string; credit: string }[]>`
      SELECT COALESCE(SUM(l."debit"), 0)::text AS debit,
             COALESCE(SUM(l."credit"), 0)::text AS credit
      FROM "journal_lines" l
      JOIN "journal_entries" e ON e."id" = l."journalEntryId"
      WHERE e."status" = 'POSTED'
    `;
    expect(row.debit).toBe(row.credit);
  });

  it("leaves finished goods equal to what is still on the shelf", async () => {
    await createSale(saleInput(), { userId: cashierId });

    const lots = await db.inventoryLot.findMany({ where: { variantId } });
    const shelfValue = lots.reduce(
      (s, l) => s.plus(dec(l.remainingQty).times(dec(l.unitCost))), dec(0),
    );
    expect(await accountBalance("1340")).toBeCloseTo(Number(shelfValue), 2);
  });
});
