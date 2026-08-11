import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { createPurchaseOrder } from "./purchasing";
import { approvePurchaseOrder, APPROVAL_THRESHOLD_KEY } from "./approvals";
import { cashForecast } from "./cash-flow";
import { apAging } from "./reports";
import { dec } from "./money";

/**
 * What a purchase order does, and does not, do to the books.
 *
 * Ordering is not owing. A supplier is owed when their goods arrive, not when
 * somebody writes an order, so nothing posts and payables do not move. That
 * is correct, and it surprises people.
 *
 * What is not correct is an order disappearing. Before approvals existed
 * every order was confirmed the moment it was written, so the cash forecast
 * and the committed total caught them all by filtering on CONFIRMED. Adding
 * approval made a large order start as a draft — and silently dropped it out
 * of both, which is how a business commits to buy fabric and sees nothing
 * coming. These tests exist because that happened.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let supplierId: string;
let materialId: string;
let factoryId: string;
let ownerId: string;
let approverId: string;
let day: Date;

beforeAll(async () => {
  supplierId = (await db.supplier.findFirstOrThrow()).id;
  materialId = (await db.material.findFirstOrThrow()).id;
  factoryId = (await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } })).id;
  ownerId = (await db.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  approverId = (
    await db.user.findFirstOrThrow({ where: { id: { not: ownerId } } })
  ).id;

  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" },
    orderBy: { startDate: "asc" },
  });
  day = new Date(period.startDate);

  await db.setting.upsert({
    where: { key: APPROVAL_THRESHOLD_KEY },
    update: { value: "10000" },
    create: {
      key: APPROVAL_THRESHOLD_KEY, value: "10000", type: "DECIMAL", group: "Finance",
      labelAr: "حد الاعتماد المالي", labelEn: "Approval threshold",
    },
  });
});

beforeEach(async () => {
  await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
  await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
  try {
    await db.goodsReceiptLine.deleteMany({});
    await db.goodsReceipt.deleteMany({});
    await db.purchaseOrderLine.deleteMany({});
    await db.purchaseOrder.deleteMany({});
    await db.expensePayment.deleteMany({});
    await db.expense.deleteMany({});
    await db.inventoryMovement.deleteMany({});
    await db.inventoryLot.deleteMany({});
    await db.journalLine.deleteMany({});
    await db.journalEntry.deleteMany({});
    await db.documentSequence.deleteMany({});
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
  }
});

afterAll(async () => {
  await db.$disconnect();
});

/** `unitPrice` × 500, so 100 is a 50,000 order and needs approving. */
function anOrder(unitPrice: number) {
  return createPurchaseOrder(
    {
      supplierId,
      orderDate: day,
      expectedDate: day,
      lines: [{ materialId, quantity: 500, unitPrice }],
    },
    { userId: ownerId, reason: null },
  );
}

/** The forecast is bucketed by week, so the lines live inside the weeks. */
async function forecastLines(kind?: string) {
  const forecast = await cashForecast(factoryId);
  const all = forecast.weeks.flatMap((w) => w.lines);
  return kind ? all.filter((l) => l.kind === kind) : all;
}

async function forecastOut(kind: string) {
  const lines = await forecastLines(kind);
  return lines.reduce((s, l) => s.plus(dec(l.amount)), dec(0));
}

describe("ordering is not owing", () => {
  it("posts nothing to the ledger", async () => {
    const before = await db.journalEntry.count();
    await anOrder(100);

    // A supplier is owed when their goods arrive. Writing an order commits
    // the business to buy; it does not create a debt.
    expect(await db.journalEntry.count()).toBe(before);
  });

  it("leaves payables alone", async () => {
    await anOrder(100);

    const aging = await apAging(factoryId);
    // Nothing is payable, because nothing has been delivered or invoiced.
    expect(dec(aging.total ?? 0).toNumber()).toBe(0);
  });
});

describe("but an order never disappears", () => {
  it("shows in the forecast while it waits for a signature", async () => {
    await anOrder(100); // 50,000 — over the limit, so it starts as a draft

    const order = await db.purchaseOrder.findFirstOrThrow({});
    expect(order.status).toBe("DRAFT");

    // The regression this file exists for: a draft used to fall out of every
    // filter and the money simply vanished from the forecast.
    const waiting = await forecastOut("AWAITING_APPROVAL");
    expect(waiting.toNumber()).toBeGreaterThan(0);
  });

  it("counts it as waiting rather than committed", async () => {
    await anOrder(100);

    // A proposal presented as a decision already taken would be wrong in the
    // other direction, so the two are separate kinds.
    expect((await forecastOut("PURCHASE_COMMITMENT")).toNumber()).toBe(0);
    expect((await forecastOut("AWAITING_APPROVAL")).toNumber()).toBeGreaterThan(0);
  });

  it("moves from waiting to committed once approved", async () => {
    const created = await anOrder(100);

    await approvePurchaseOrder(
      { purchaseOrderId: created.purchaseOrderId },
      { userId: approverId, reason: null },
    );

    expect((await forecastOut("AWAITING_APPROVAL")).toNumber()).toBe(0);
    expect((await forecastOut("PURCHASE_COMMITMENT")).toNumber()).toBeGreaterThan(0);
  });

  it("treats a small order as committed straight away", async () => {
    await anOrder(10); // 5,000 — under the limit, nobody needs to sign

    const order = await db.purchaseOrder.findFirstOrThrow({});
    expect(order.status).toBe("CONFIRMED");
    expect((await forecastOut("PURCHASE_COMMITMENT")).toNumber()).toBeGreaterThan(0);
    expect((await forecastOut("AWAITING_APPROVAL")).toNumber()).toBe(0);
  });

  it("drops a rejected order out of the forecast entirely", async () => {
    const created = await anOrder(100);
    await db.purchaseOrder.update({
      where: { id: created.purchaseOrderId },
      data: { rejectedAt: new Date(), rejectionReason: "السعر غالي" },
    });

    // Sent back is not waiting: nobody is going to pay it as it stands.
    expect((await forecastOut("AWAITING_APPROVAL")).toNumber()).toBe(0);
  });

  it("counts the order once, not in both places", async () => {
    await anOrder(100);
    await anOrder(10);

    const poLines = (await forecastLines()).filter(
      (l) => l.kind === "PURCHASE_COMMITMENT" || l.kind === "AWAITING_APPROVAL",
    );
    // Two orders, two lines. A double count would overstate what is going out.
    expect(poLines).toHaveLength(2);
  });
});
