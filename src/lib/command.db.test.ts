import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { receiveFinishedGoods } from "./inventory";
import { createSale } from "./sales";
import { collectPayment } from "./receivables";
import { recordReturn } from "./returns";
import { receiveGoods } from "./purchasing";
import { command, formCommand } from "./command";

/**
 * A business command is one transaction, and one effect per request.
 *
 * These are the failures the production audit found, each reproduced against
 * the real database rather than argued from the code:
 *
 *   - a sale that failed on its second line had already relieved the first
 *     line's stock and posted its cost (C02);
 *   - two sales of the last garment could both succeed (C03);
 *   - a second press of the same form did the work twice;
 *   - two collections of the same debt could both be taken (C06);
 *   - cash could be refunded for a sale nobody had paid for (C07);
 *   - one purchase-order line could be received twice on one receipt (C05).
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let brandId: string;
let channelId: string;
let locationId: string;
let stockedVariantId: string;
let emptyVariantId: string;
let cashierId: string;
let customerId: string;
let day: Date;

const UNIT_COST = "500";
const RETAIL = 1500;

beforeAll(async () => {
  brandId = (await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } })).id;
  channelId = (await db.salesChannel.findFirstOrThrow()).id;
  locationId = (await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } })).id;
  const variants = await db.variant.findMany({ take: 2, orderBy: { sku: "asc" } });
  [stockedVariantId, emptyVariantId] = [variants[0].id, variants[1].id];
  cashierId = (await db.user.findFirstOrThrow({ where: { email: "owner@cashmere.eg" } })).id;

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
    await db.commandReceipt.deleteMany({});
    await db.return.deleteMany({});
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
    await db.customer.deleteMany({ where: { code: { startsWith: "CMD-" } } });
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
  }
  customerId = (
    await db.customer.create({
      data: { code: "CMD-CREDIT", name: "عميل آجل", phone: "01000000077", creditLimit: "50000", creditDays: 30 },
    })
  ).id;
}

async function givenStock(quantity: number, variantId = stockedVariantId) {
  await receiveFinishedGoods(
    {
      variantId, locationId, entityId: brandId,
      quantity: String(quantity), unitCost: UNIT_COST, materialUnitCost: "400",
      receivedDate: day,
    },
    { userId: null },
  );
}

async function onHand(variantId = stockedVariantId): Promise<number> {
  const lots = await db.inventoryLot.findMany({ where: { variantId } });
  return lots.reduce((s, l) => s + Number(l.remainingQty), 0);
}

async function postedTotal(code: string): Promise<number> {
  const [row] = await db.$queryRaw<{ balance: string }[]>`
    SELECT COALESCE(SUM(l."debit") - SUM(l."credit"), 0)::text AS balance
    FROM "journal_lines" l
    JOIN "journal_entries" e ON e."id" = l."journalEntryId"
    JOIN "accounts" a ON a."id" = l."accountId"
    WHERE a."code" = ${code} AND e."status" = 'POSTED'
  `;
  return Number(row.balance);
}

/** A sale on the credit customer's account, so it needs no payment to be valid. */
function sale(over: Partial<Parameters<typeof createSale>[0]> = {}) {
  return {
    source: "MANUAL" as const,
    channelId, entityId: brandId, locationId,
    customerId,
    orderDate: day,
    lines: [{ variantId: stockedVariantId, quantity: 1, retailPrice: RETAIL, discountPct: 0 }],
    payments: [],
    ...over,
  };
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await db.customer.deleteMany({ where: { code: { startsWith: "CMD-" } } });
  await db.$disconnect();
});

describe("a sale is all or nothing (C02)", () => {
  it("leaves no stock relieved and nothing posted when a later line fails", async () => {
    await givenStock(50);

    await expect(
      createSale(
        sale({
          lines: [
            { variantId: stockedVariantId, quantity: 2, retailPrice: RETAIL, discountPct: 0 },
            // Nothing of this one is on the shelf.
            { variantId: emptyVariantId, quantity: 1, retailPrice: RETAIL, discountPct: 0 },
          ],
        }),
        { userId: cashierId },
      ),
    ).rejects.toThrow(/Not enough finished goods/i);

    // Before, the first line's two garments had already left, at cost, with
    // a movement pointing at no order.
    expect(await onHand()).toBe(50);
    expect(await db.salesOrder.count()).toBe(0);
    expect(await db.inventoryMovement.count({ where: { type: "SALE" } })).toBe(0);
    expect(await postedTotal("5300")).toBe(0);
  });

  it("names its order on the stock movement it made", async () => {
    await givenStock(5);
    const result = await createSale(sale(), { userId: cashierId });

    const movement = await db.inventoryMovement.findFirstOrThrow({ where: { type: "SALE" } });
    expect(movement.referenceId).toBe(result.salesOrderId);
  });
});

describe("the last garment goes once (C03)", () => {
  it("lets exactly one of two simultaneous sales have it", async () => {
    await givenStock(1);

    const outcomes = await Promise.allSettled([
      createSale(sale(), { userId: cashierId }),
      createSale(sale(), { userId: cashierId }),
    ]);

    const sold = outcomes.filter((o) => o.status === "fulfilled");
    const refused = outcomes.filter((o) => o.status === "rejected");
    expect(sold).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(String((refused[0] as PromiseRejectedResult).reason)).toMatch(/Not enough finished goods/i);

    expect(await onHand()).toBe(0);
    expect(await db.salesOrder.count()).toBe(1);
  });

  it("never lets a lot go below zero, whatever interleaving happens", async () => {
    await givenStock(3);
    await Promise.allSettled(
      Array.from({ length: 6 }, () => createSale(sale(), { userId: cashierId })),
    );
    expect(await onHand()).toBe(0);
    expect(await db.salesOrder.count()).toBe(3);
  });
});

describe("a second press is not a second sale", () => {
  it("returns the recorded result for the same request", async () => {
    await givenStock(5);
    const ctx = { userId: cashierId, requestId: "cmd-test-0001" };

    const first = await createSale(sale(), ctx);
    const again = await createSale(sale(), ctx);

    expect(again.salesOrderId).toBe(first.salesOrderId);
    expect(await db.salesOrder.count()).toBe(1);
    expect(await onHand()).toBe(4);
  });

  it("refuses the same request identity carrying different values", async () => {
    await givenStock(5);
    const ctx = { userId: cashierId, requestId: "cmd-test-0002" };

    await createSale(sale(), ctx);
    await expect(
      createSale(
        sale({ lines: [{ variantId: stockedVariantId, quantity: 3, retailPrice: RETAIL, discountPct: 0 }] }),
        ctx,
      ),
    ).rejects.toThrow(/different values/i);
    expect(await onHand()).toBe(4);
  });

  it("answers both of two simultaneous presses with one sale", async () => {
    await givenStock(5);
    const ctx = { userId: cashierId, requestId: "cmd-test-0003" };

    const [a, b] = await Promise.all([createSale(sale(), ctx), createSale(sale(), ctx)]);
    expect(a.salesOrderId).toBe(b.salesOrderId);
    expect(await db.salesOrder.count()).toBe(1);
  });

  it("recognises a form's retry even when the action stamps a fresh time on it", async () => {
    await givenStock(5);
    const form = new FormData();
    form.set("requestId", "cmd-form-0001");
    form.set("variantId", stockedVariantId);

    // What an action does: builds the service input with "now" in it. The
    // retry's input differs from the first; the form it came from does not.
    const submit = () =>
      formCommand("test.sale", form, { userId: cashierId }, () =>
        createSale(sale({ orderDate: new Date() }), { userId: cashierId }),
      );

    const first = await submit();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = await submit();

    expect(again.salesOrderId).toBe(first.salesOrderId);
    expect(await db.salesOrder.count()).toBe(1);
  });

  it("keeps no receipt for a request that failed, so it can be tried again", async () => {
    await givenStock(1);
    const ctx = { userId: cashierId, requestId: "cmd-test-0004" };

    await expect(
      createSale(
        sale({ lines: [{ variantId: stockedVariantId, quantity: 2, retailPrice: RETAIL, discountPct: 0 }] }),
        ctx,
      ),
    ).rejects.toThrow(/Not enough/i);
    expect(await db.commandReceipt.count()).toBe(0);
  });

  it("runs a command inside another as part of it, with one receipt", async () => {
    await givenStock(5);
    await command("test.outer", { n: 1 }, { userId: cashierId, requestId: "cmd-test-0005" }, async () => {
      await createSale(sale(), { userId: cashierId, requestId: "cmd-inner-0005" });
      await createSale(sale(), { userId: cashierId });
    });

    expect(await db.salesOrder.count()).toBe(2);
    const receipts = await db.commandReceipt.findMany();
    expect(receipts.map((r) => r.operation)).toEqual(["test.outer"]);
  });
});

describe("a debt is collected once (C06)", () => {
  it("takes only one of two simultaneous full collections", async () => {
    await givenStock(5);
    const credit = await createSale(sale({ customerId }), { userId: cashierId });

    const collect = () =>
      collectPayment(
        { salesOrderId: credit.salesOrderId, method: "CASH", amount: String(RETAIL), collectedOn: day },
        { userId: cashierId, reason: null },
      );
    const outcomes = await Promise.allSettled([collect(), collect()]);

    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const payments = await db.salesPayment.findMany({ where: { salesOrderId: credit.salesOrderId } });
    expect(payments.reduce((s, p) => s + Number(p.amount), 0)).toBe(RETAIL);
    // Receivable cleared exactly once, not driven negative.
    expect(await postedTotal("1210")).toBeCloseTo(0, 2);
  });
});

describe("a refund is capped by what was collected (C07)", () => {
  it("refuses cash back on a sale nobody has paid for", async () => {
    await givenStock(5);
    const unpaid = await createSale(sale({ customerId }), { userId: cashierId });

    await expect(
      recordReturn(
        {
          salesOrderId: unpaid.salesOrderId, variantId: stockedVariantId, quantity: 1,
          disposition: "RESTOCK", refundMethod: "CASH", returnDate: day,
        },
        { userId: cashierId, reason: null },
      ),
    ).rejects.toThrow(/refundable/i);
    expect(await db.return.count()).toBe(0);
  });

  it("still lets the return clear the debt instead", async () => {
    await givenStock(5);
    const unpaid = await createSale(sale({ customerId }), { userId: cashierId });

    await recordReturn(
      {
        salesOrderId: unpaid.salesOrderId, variantId: stockedVariantId, quantity: 1,
        disposition: "RESTOCK", refundMethod: "AGAINST_BALANCE", returnDate: day,
      },
      { userId: cashierId, reason: null },
    );
    expect(await postedTotal("1210")).toBeCloseTo(0, 2);
  });

  it("lets only one of two simultaneous returns have the last returnable piece", async () => {
    await givenStock(5);
    const paid = await createSale(
      sale({ payments: [{ method: "CASH", amount: RETAIL, fee: 0, collected: true }] }),
      { userId: cashierId },
    );

    const giveBack = () =>
      recordReturn(
        {
          salesOrderId: paid.salesOrderId, variantId: stockedVariantId, quantity: 1,
          disposition: "RESTOCK", refundMethod: "CASH", returnDate: day,
        },
        { userId: cashierId, reason: null },
      );
    const outcomes = await Promise.allSettled([giveBack(), giveBack()]);

    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(await db.return.count()).toBe(1);
    expect(await onHand()).toBe(5);
  });
});

describe("a receipt names each order line once (C05)", () => {
  it("refuses the same purchase-order line twice on one receipt", async () => {
    await expect(
      receiveGoods(
        {
          purchaseOrderId: "po", receivedDate: day, locationId, entityId: brandId,
          lines: [
            { purchaseOrderLineId: "line-1", acceptedQty: 10, actualUnitPrice: 50 },
            { purchaseOrderLineId: "line-1", acceptedQty: 10, actualUnitPrice: 50 },
          ],
        },
        { userId: cashierId },
      ),
    ).rejects.toThrow(/only once/i);
  });
});
