import "dotenv/config";
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { receiveFinishedGoods } from "./inventory";
import {
  importOrders,
  receiveWebhook,
  retryFailedWebhooks,
  failedWebhookEvents,
  verifyWebhookSignature,
  type ShopifyOrder,
} from "./shopify";

/** The Shopify connector against a real database. */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let connectionId: string;
let brandId: string;
let locationId: string;
let variantId: string;
let sku: string;
let day: Date;
let userId: string;

let orderSeq = 5000;

beforeAll(async () => {
  brandId = (await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } })).id;
  locationId = (await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } })).id;
  userId = (await db.user.findFirstOrThrow({ where: { email: "owner@cashmere.eg" } })).id;

  const variant = await db.variant.findFirstOrThrow();
  variantId = variant.id;
  sku = variant.sku;

  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" }, orderBy: { startDate: "asc" },
  });
  day = new Date(period.startDate);
});

async function wipe() {
  await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
  await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
  try {
    await db.shopifyWebhookEvent.deleteMany({});
    await db.commandReceipt.deleteMany({});
    await db.return.deleteMany({});
    await db.integrationException.deleteMany({});
    await db.externalMapping.deleteMany({});
    await db.syncLog.deleteMany({});
    await db.integrationConnection.deleteMany({});
    await db.settlementLine.deleteMany({});
    await db.settlement.deleteMany({});
    await db.salesPayment.deleteMany({});
    await db.salesOrderLine.deleteMany({});
    await db.salesOrder.deleteMany({});
    await db.customer.deleteMany({ where: { code: { startsWith: "SHOP-" } } });
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

beforeEach(async () => {
  await wipe();

  const connection = await db.integrationConnection.create({
    data: {
      provider: "SHOPIFY",
      externalRef: "cashmere-test.myshopify.com",
      displayName: "Cashmere Boutique (test)",
      accessToken: "shpat_test",
      webhookSecret: "test-secret",
    },
  });
  connectionId = connection.id;

  await receiveFinishedGoods(
    {
      variantId, locationId, entityId: brandId,
      quantity: "100", unitCost: "420", materialUnitCost: "340",
      receivedDate: day,
    },
    { userId },
  );
});

afterAll(async () => { await wipe(); await db.$disconnect(); });

function order(over: Partial<ShopifyOrder> = {}): ShopifyOrder {
  const id = orderSeq++;
  return {
    id,
    name: `#${id}`,
    created_at: day.toISOString(),
    currency: "EGP",
    financial_status: "paid",
    line_items: [
      { id: id * 10, sku, quantity: 2, price: "1500.00", total_discount: "0.00" },
    ],
    ...over,
  };
}

describe("importing website orders", () => {
  it("creates an internal sale that relieves the same stock", async () => {
    const result = await importOrders({ connectionId, orders: [order()] }, { userId });

    expect(result.created).toBe(1);
    expect(result.failed).toBe(0);

    const sale = await db.salesOrder.findFirstOrThrow({ include: { lines: true } });
    expect(sale.source).toBe("SHOPIFY");
    expect(Number(sale.netAmount)).toBe(3000);
    // The same FIFO path a till sale uses — there is no softer route in.
    expect(Number(sale.cogsAmount)).toBeCloseTo(840, 2);

    const lot = await db.inventoryLot.findFirstOrThrow({ where: { variantId } });
    expect(lot.remainingQty.toString()).toBe("98");
  });

  it("does not import the same order twice", async () => {
    const o = order();
    await importOrders({ connectionId, orders: [o] }, { userId });
    const second = await importOrders({ connectionId, orders: [o] }, { userId });

    expect(second.created).toBe(0);
    expect(second.duplicates).toBe(1);
    // Stock relieved twice is not recoverable, so this is the guard that
    // matters most.
    const lot = await db.inventoryLot.findFirstOrThrow({ where: { variantId } });
    expect(lot.remainingQty.toString()).toBe("98");
    expect(await db.salesOrder.count()).toBe(1);
  });

  it("converts a Shopify discount amount into a rate", async () => {
    await importOrders(
      {
        connectionId,
        orders: [
          order({
            line_items: [
              { id: 1, sku, quantity: 2, price: "1000.00", total_discount: "300.00" },
            ],
          }),
        ],
      },
      { userId },
    );

    const sale = await db.salesOrder.findFirstOrThrow();
    // 2,000 gross less a 300 discount is 1,700 net.
    expect(Number(sale.netAmount)).toBe(1700);
    expect(Number(sale.discountAmount)).toBe(300);
  });

  it("charges shipping as revenue", async () => {
    await importOrders(
      { connectionId, orders: [order({ shipping_lines: [{ price: "75.00" }] })] },
      { userId },
    );
    const sale = await db.salesOrder.findFirstOrThrow();
    expect(Number(sale.shippingAmount)).toBe(75);
  });
});

describe("what cannot be matched", () => {
  it("raises an exception for an unknown SKU instead of guessing", async () => {
    const result = await importOrders(
      {
        connectionId,
        orders: [
          order({
            line_items: [{ id: 1, sku: "NOSUCH-SKU-XL", quantity: 1, price: "500.00" }],
          }),
        ],
      },
      { userId },
    );

    expect(result.created).toBe(0);
    expect(result.failed).toBe(1);

    const exception = await db.integrationException.findFirstOrThrow();
    expect(exception.reason).toMatch(/Unrecognised SKU/i);
    expect(exception.status).toBe("OPEN");
    // Nothing was written: guessing which garment was meant would relieve the
    // wrong stock and misstate margin.
    expect(await db.salesOrder.count()).toBe(0);
  });

  it("keeps the payload so the decision is made on real evidence", async () => {
    await importOrders(
      {
        connectionId,
        orders: [order({ line_items: [{ id: 1, sku: null, quantity: 1, price: "500.00", title: "Mystery item" }] })],
      },
      { userId },
    );

    const exception = await db.integrationException.findFirstOrThrow();
    expect(exception.payload).toMatchObject({ name: expect.any(String) });
  });

  it("imports the good orders in a batch and quarantines only the bad", async () => {
    const result = await importOrders(
      {
        connectionId,
        orders: [
          order(),
          order({ line_items: [{ id: 99, sku: "GHOST-BLK-M", quantity: 1, price: "100.00" }] }),
          order(),
        ],
      },
      { userId },
    );

    expect(result.created).toBe(2);
    expect(result.failed).toBe(1);
    expect(await db.salesOrder.count()).toBe(2);
  });

  it("skips an order cancelled before it reached us", async () => {
    const result = await importOrders(
      { connectionId, orders: [order({ cancelled_at: day.toISOString() })] },
      { userId },
    );
    // Importing then reversing would move stock that never left the shelf.
    expect(result.created).toBe(0);
    expect(await db.salesOrder.count()).toBe(0);
  });
});

describe("customers", () => {
  it("creates the shopper and reuses them on the next order", async () => {
    // A fresh email, so this exercises creation rather than the email match
    // covered by the next test.
    const shopper = { id: 777, first_name: "شادية", last_name: "كمال", email: "shadia-777@example.com" };

    await importOrders({ connectionId, orders: [order({ customer: shopper })] }, { userId });
    await importOrders({ connectionId, orders: [order({ customer: shopper })] }, { userId });

    const customers = await db.customer.findMany({ where: { shopifyCustomerId: "777" } });
    expect(customers).toHaveLength(1);
    expect(customers[0].acquiredVia).toBe("SHOPIFY");

    const orders = await db.salesOrder.findMany();
    expect(orders).toHaveLength(2);
    expect(new Set(orders.map((o) => o.customerId)).size).toBe(1);
  });

  it("matches an existing customer by email rather than creating a second", async () => {
    const existing = await db.customer.create({
      data: {
        code: "SHOP-EXISTING", name: "Existing Shopper",
        email: "repeat@example.com", emailNormalised: "repeat@example.com",
      },
    });

    await importOrders(
      {
        connectionId,
        orders: [order({ customer: { id: 888, email: "Repeat@Example.com" } })],
      },
      { userId },
    );

    const sale = await db.salesOrder.findFirstOrThrow();
    expect(sale.customerId).toBe(existing.id);
    // No second record was invented for the same person.
    expect(await db.customer.count({ where: { shopifyCustomerId: "888" } })).toBe(0);
  });
});

describe("sync logging", () => {
  it("records the outcome of every run", async () => {
    await importOrders(
      {
        connectionId,
        orders: [order(), order({ line_items: [{ id: 5, sku: "GHOST-X-M", quantity: 1, price: "10.00" }] })],
      },
      { userId },
    );

    const log = await db.syncLog.findFirstOrThrow();
    expect(log.processed).toBe(2);
    expect(log.created).toBe(1);
    expect(log.failed).toBe(1);
    expect(log.status).toBe("PARTIAL");
    expect(log.finishedAt).not.toBeNull();

    const connection = await db.integrationConnection.findUniqueOrThrow({
      where: { id: connectionId },
    });
    expect(connection.lastSyncedAt).not.toBeNull();
    expect(connection.lastError).toMatch(/could not be imported/i);
  });
});

describe("webhook signatures", () => {
  const secret = "shhh";
  const body = JSON.stringify({ id: 1, name: "#1" });
  const valid = crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");

  it("accepts a genuine signature", () => {
    expect(verifyWebhookSignature(body, valid, secret)).toBe(true);
  });

  it("rejects a forged one", () => {
    expect(verifyWebhookSignature(body, "not-the-signature", secret)).toBe(false);
  });

  it("rejects a body that has been altered in transit", () => {
    expect(verifyWebhookSignature(JSON.stringify({ id: 2 }), valid, secret)).toBe(false);
  });

  it("rejects a signature of the wrong length without throwing", () => {
    // timingSafeEqual throws on length mismatch, so the length is checked
    // first — an exception here would take the webhook endpoint down.
    expect(() => verifyWebhookSignature(body, "short", secret)).not.toThrow();
    expect(verifyWebhookSignature(body, "short", secret)).toBe(false);
  });
});

async function onHand(): Promise<number> {
  const lots = await db.inventoryLot.findMany({ where: { variantId } });
  return lots.reduce((s, l) => s + Number(l.remainingQty), 0);
}

async function receivable(): Promise<number> {
  const [row] = await db.$queryRaw<{ balance: string }[]>`
    SELECT COALESCE(SUM(l."debit") - SUM(l."credit"), 0)::text AS balance
    FROM "journal_lines" l
    JOIN "journal_entries" e ON e."id" = l."journalEntryId"
    JOIN "accounts" a ON a."id" = l."accountId"
    WHERE a."code" = '1210' AND e."status" = 'POSTED'
  `;
  return Number(row.balance);
}

/**
 * An order's later news.
 *
 * Once an order was mapped, every later delivery about it was skipped as a
 * duplicate — so a pending order that was then paid stayed unpaid in the
 * books, and a cancelled one stayed sold.
 */
describe("what happens to an order after it is imported", () => {
  it("records the payment when a pending order is later paid", async () => {
    const pending = order({ financial_status: "pending" });
    await importOrders({ connectionId, orders: [pending] }, { userId });
    expect(await receivable()).toBeCloseTo(3000, 2);

    const result = await importOrders(
      { connectionId, orders: [{ ...pending, financial_status: "paid" }] },
      { userId },
    );
    expect(result.updated).toBe(1);
    expect(await receivable()).toBeCloseTo(0, 2);

    // A second "paid" for the same order changes nothing.
    const again = await importOrders(
      { connectionId, orders: [{ ...pending, financial_status: "paid" }] },
      { userId },
    );
    expect(again.updated).toBe(0);
    expect(await db.salesPayment.count()).toBe(1);
  });

  it("reverses a cancelled order: stock back, money back", async () => {
    const paid = order();
    await importOrders({ connectionId, orders: [paid] }, { userId });
    expect(await onHand()).toBe(98);

    await importOrders(
      { connectionId, orders: [{ ...paid, cancelled_at: day.toISOString() }] },
      { userId },
    );
    expect(await onHand()).toBe(100);
    expect(await db.return.count()).toBe(1);

    // Cancelled twice is cancelled once.
    await importOrders(
      { connectionId, orders: [{ ...paid, cancelled_at: day.toISOString() }] },
      { userId },
    );
    expect(await db.return.count()).toBe(1);
  });

  it("clears the debt rather than paying cash out when an unpaid order is cancelled", async () => {
    const pending = order({ financial_status: "pending" });
    await importOrders({ connectionId, orders: [pending] }, { userId });
    await importOrders(
      { connectionId, orders: [{ ...pending, cancelled_at: day.toISOString() }] },
      { userId },
    );
    expect(await receivable()).toBeCloseTo(0, 2);
    expect(await onHand()).toBe(100);
  });

  it("raises a refund for a person once, instead of guessing what came back", async () => {
    const paid = order();
    await importOrders({ connectionId, orders: [paid] }, { userId });
    const refunded = { ...paid, financial_status: "partially_refunded" };
    await importOrders({ connectionId, orders: [refunded] }, { userId });
    await importOrders({ connectionId, orders: [refunded] }, { userId });

    const raised = await db.integrationException.findMany({ where: { reason: { startsWith: "Refunded on Shopify" } } });
    expect(raised).toHaveLength(1);
    expect(await onHand()).toBe(98);
  });
});

describe("the webhook inbox", () => {
  it("records a delivery and answers a repeat of it without doing anything twice", async () => {
    const o = order();
    const first = await receiveWebhook({ connectionId, webhookId: "wh-1", topic: "orders/create", payload: o });
    const repeat = await receiveWebhook({ connectionId, webhookId: "wh-1", topic: "orders/create", payload: o });

    expect(first.duplicate).toBe(false);
    expect(repeat.duplicate).toBe(true);
    expect(await db.salesOrder.count()).toBe(1);
    const event = await db.shopifyWebhookEvent.findUniqueOrThrow({ where: { webhookId: "wh-1" } });
    expect(event.status).toBe("PROCESSED");
  });

  it("acknowledges a topic it does not act on, and keeps it", async () => {
    const result = await receiveWebhook({
      connectionId, webhookId: "wh-2", topic: "products/update", payload: { id: 1 },
    });
    expect(result.ignored).toBe(true);
    expect(await db.shopifyWebhookEvent.count()).toBe(1);
  });

  it("retries what failed, unattended, once the cause is gone", async () => {
    // A delivery whose first attempt died on something transient — the
    // database restarting mid-import — is left recorded and failed.
    const o = order();
    await db.shopifyWebhookEvent.create({
      data: {
        connectionId,
        webhookId: "wh-3",
        topic: "orders/create",
        payload: o as unknown as object,
        status: "FAILED",
        attempts: 1,
        lastError: "the connection was lost",
      },
    });

    const pass = await retryFailedWebhooks();

    expect(pass.tried).toBe(1);
    expect(pass.recovered).toBe(1);
    const event = await db.shopifyWebhookEvent.findUniqueOrThrow({ where: { webhookId: "wh-3" } });
    expect(event.status).toBe("PROCESSED");
    // And the sale it was carrying is now on the books.
    expect(await db.salesOrder.count({ where: { shopifyOrderId: String(o.id) } })).toBe(1);
  });

  it("stops retrying after six attempts and leaves it for a person", async () => {
    // Malformed beyond anything a retry can fix.
    await db.shopifyWebhookEvent.create({
      data: {
        connectionId,
        webhookId: "wh-4",
        topic: "orders/create",
        payload: { id: 9901, line_items: null } as unknown as object,
        status: "FAILED",
        attempts: 1,
        lastError: "unexpected",
      },
    });

    for (let attempt = 0; attempt < 8; attempt++) await retryFailedWebhooks();

    const event = await db.shopifyWebhookEvent.findUniqueOrThrow({ where: { webhookId: "wh-4" } });
    expect(event.status).toBe("FAILED");
    expect(event.attempts).toBe(6);
    // Still listed, so somebody is asked to look at it.
    expect((await failedWebhookEvents()).some((f) => f.id === event.id)).toBe(true);
  });
});
