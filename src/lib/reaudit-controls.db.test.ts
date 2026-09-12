import "dotenv/config";
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { receiveFinishedGoods } from "./inventory";
import { createSale, openPosSession } from "./sales";
import { recordReturn, returnableLines } from "./returns";
import { receiveWebhook, retryFailedWebhooks, type ShopifyOrder } from "./shopify";
import { groupProfitAndLoss } from "./consolidation";
import { recordSettlement } from "./reconciliation";
import { checkoutAction } from "@/app/(app)/pos/actions";
import { can } from "@/core/permissions";

// Authentication is supplied as a real cashier identity; authorization policy,
// action parsing, business services, transactions and PostgreSQL are real.
const actor = vi.hoisted(() => ({ userId: "", role: "POS_CASHIER" as const }));
vi.mock("./auth", async () => {
  const { can } = await import("@/core/permissions");
  class ForbiddenError extends Error {}
  return { ForbiddenError, authorize: async (permission: Parameters<typeof can>[1]) => {
    if (!can(actor.role, permission)) throw new ForbiddenError(permission);
    return actor;
  }};
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
let brandId: string, factoryId: string, locationId: string, variantId: string, channelId: string;
let customerId: string, connectionId: string, sku: string, day: Date;
let sequence = 910000;

beforeAll(async () => {
  brandId = (await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } })).id;
  factoryId = (await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } })).id;
  locationId = (await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } })).id;
  channelId = (await db.salesChannel.findFirstOrThrow()).id;
  actor.userId = (await db.user.upsert({ where: { email: "reaudit-cashier@example.invalid" },
    create: { email: "reaudit-cashier@example.invalid", name: "Audit cashier", passwordHash: "not-a-login-hash", role: "POS_CASHIER" },
    update: { role: "POS_CASHIER" } })).id;
  const variant = await db.variant.findFirstOrThrow();
  variantId = variant.id; sku = variant.sku;
  day = new Date();
});

async function wipe() {
  await db.$executeRawUnsafe('ALTER TABLE "journal_lines" DISABLE TRIGGER USER');
  await db.$executeRawUnsafe('ALTER TABLE "journal_entries" DISABLE TRIGGER USER');
  try {
    await db.commandReceipt.deleteMany();
    await db.shopifyWebhookEvent.deleteMany();
    await db.shopifyOrderState.deleteMany();
    await db.integrationException.deleteMany();
    await db.externalMapping.deleteMany();
    await db.syncLog.deleteMany();
    await db.integrationConnection.deleteMany();
    await db.return.deleteMany();
    await db.garmentUnit.deleteMany();
    await db.settlementLine.deleteMany();
    await db.settlement.deleteMany();
    await db.salesPayment.deleteMany();
    await db.salesOrderLine.deleteMany();
    await db.salesOrder.deleteMany();
    await db.tillCashEvent.deleteMany();
    await db.posSession.deleteMany();
    await db.inventoryMovement.deleteMany();
    await db.inventoryLot.deleteMany();
    await db.bankStatementLine.deleteMany();
    await db.bankStatement.deleteMany();
    await db.journalLine.deleteMany();
    await db.journalEntry.deleteMany();
    await db.auditLog.deleteMany();
    await db.documentSequence.deleteMany();
    await db.customer.deleteMany({ where: { code: "REAUDIT-CUSTOMER" } });
  } finally {
    await db.$executeRawUnsafe('ALTER TABLE "journal_entries" ENABLE TRIGGER USER');
    await db.$executeRawUnsafe('ALTER TABLE "journal_lines" ENABLE TRIGGER USER');
  }
}
beforeEach(async () => {
  await wipe();
  customerId = (await db.customer.create({ data: { code: "REAUDIT-CUSTOMER", name: "Audit fixture", creditLimit: "10000", creditDays: 30 } })).id;
  connectionId = (await db.integrationConnection.create({ data: { provider: "SHOPIFY", externalRef: "audit-fixture.myshopify.com", displayName: "Audit fixture" } })).id;
});
afterAll(async () => { await wipe(); await db.user.deleteMany({ where: { email: "reaudit-cashier@example.invalid" } }); await db.$disconnect(); });

const ctx = () => ({ userId: actor.userId });
async function stock(quantity = 5, cost = "500", margin?: string) {
  const lot = await receiveFinishedGoods({ variantId, locationId, entityId: brandId, quantity: String(quantity), unitCost: cost, materialUnitCost: cost, receivedDate: day }, ctx());
  if (margin) await db.inventoryLot.update({ where: { id: lot.lotId }, data: { transferMarginPerUnit: margin } });
  return lot;
}
function sale(over: Partial<Parameters<typeof createSale>[0]> = {}) {
  return { source: "MANUAL" as const, channelId, entityId: brandId, locationId, customerId, orderDate: day,
    lines: [{ variantId, quantity: 1, retailPrice: 1500, discountPct: 0 }],
    payments: [{ method: "CASH" as const, amount: 1500, fee: 0, collected: true }], ...over };
}
function order(over: Partial<ShopifyOrder> = {}): ShopifyOrder {
  const id = ++sequence;
  return { id, name: `#${id}`, created_at: day.toISOString(), currency: "EGP", financial_status: "paid",
    line_items: [{ id: id * 10, sku, quantity: 1, price: "1500", total_discount: "0" }], ...over };
}
async function balance(code: string, entityId = brandId) {
  const rows = await db.journalLine.aggregate({ where: { entityId, account: { code }, journalEntry: { status: "POSTED" } }, _sum: { debit: true, credit: true } });
  return Number(rows._sum.debit ?? 0) - Number(rows._sum.credit ?? 0);
}

// Regression cases from the independent audit: assert the corrected behavior.
describe("independent re-audit reproductions — current defects", () => {
  it("cashier cannot submit an unfunded deposit tender", async () => {
    await stock();
    expect(can(actor.role, "sales_order:credit")).toBe(false);
    const till = await openPosSession({ locationId, cashierUserId: actor.userId, openingFloat: "0" }, ctx());
    const form = new FormData();
    for (const [key, value] of Object.entries({ locationId, entityId: brandId, channelId, posSessionId: till.posSessionId,
      method: "DEPOSIT", requestId: "reaudit-deposit-tender", cart: JSON.stringify([{ variantId, quantity: 1, retailPrice: 1000000, discountPct: 0 }]) })) form.set(key, value);
    const result = await checkoutAction({}, form);
    expect(result.error).toMatch(/supported.*payment/i);
    expect(result.receipt).toBeUndefined();
    expect(await balance("2400")).toBe(0);
    expect(await balance("1115")).toBe(0);
    expect(await db.salesPayment.count({ where: { method: "DEPOSIT", status: "COLLECTED" } })).toBe(0);
  });

  it("one full return settles both debt and cash", async () => {
    await stock();
    const sold = await createSale(sale({ payments: [{ method: "CASH", amount: 500, fee: 0, collected: true }] }), ctx());
    const input = { salesOrderId: sold.salesOrderId, variantId, quantity: 1, disposition: "RESTOCK" as const, returnDate: day };
    const result = await recordReturn({ ...input, refundMethod: "CASH", creditAgainstBalance: true }, ctx());
    expect(result.cashRefunded).toBe("500");
    expect(result.creditedBalance).toBe("1000");
    expect((await returnableLines(sold.salesOrderId)).lines[0].returnable).toBe(0);
    expect(await balance("1210")).toBe(0);
    expect(await balance("1115")).toBe(0);
  });

  it("late create cannot resurrect a canceled Shopify order", async () => {
    await stock();
    const original = order();
    await receiveWebhook({ connectionId, webhookId: "reaudit-cancel-first", topic: "orders/cancelled", payload: { ...original, cancelled_at: day.toISOString() } });
    await receiveWebhook({ connectionId, webhookId: "reaudit-create-later", topic: "orders/create", payload: original });
    expect(await db.salesOrder.count()).toBe(0);
    expect(await db.return.count()).toBe(0);
    expect(await db.inventoryMovement.count({ where: { type: "SALE" } })).toBe(0);
  });

  it("Shopify cancellation requires review before refund or restock", async () => {
    await stock();
    const original = order();
    await receiveWebhook({ connectionId, webhookId: "reaudit-paid-create", topic: "orders/create", payload: original });
    expect(await balance("1120")).toBe(1500);
    await receiveWebhook({ connectionId, webhookId: "reaudit-no-refund-cancel", topic: "orders/cancelled", payload: { ...original, cancelled_at: day.toISOString(), refunds: [], restock: false } });
    expect(await balance("1120")).toBe(1500);
    expect(await db.return.count({ where: { disposition: "RESTOCK" } })).toBe(0);
  });

  it("durable retry recovers an interrupted received event", async () => {
    await stock();
    const event = await db.shopifyWebhookEvent.create({ data: { connectionId, webhookId: "reaudit-interrupted", topic: "orders/create", payload: JSON.parse(JSON.stringify(order())) } });
    expect(event.status).toBe("RECEIVED");
    expect((await retryFailedWebhooks()).tried).toBe(1);
    expect(await db.salesOrder.count()).toBe(1);
  });

  it("multi-lot return preserves every original margin", async () => {
    await stock(1, "100", "10"); await stock(1, "300", "60");
    const sold = await createSale(sale({ lines: [{ variantId, quantity: 2, retailPrice: 1500, discountPct: 0 }], payments: [{ method: "CASH", amount: 3000, fee: 0, collected: true }] }), ctx());
    await recordReturn({ salesOrderId: sold.salesOrderId, variantId, quantity: 2, disposition: "RESTOCK", refundMethod: "CASH", returnDate: day }, ctx());
    const lots = await db.inventoryLot.findMany({ where: { remainingQty: { gt: 0 } } });
    const deferred = lots.reduce((s, l) => s + Number(l.remainingQty) * Number(l.transferMarginPerUnit), 0);
    expect(deferred).toBe(70);
  });

  it("repair return retains group unrealised profit", async () => {
    await stock(1, "500", "100");
    const sold = await createSale(sale(), ctx());
    await recordReturn({ salesOrderId: sold.salesOrderId, variantId, quantity: 1, disposition: "REPAIR_AND_RESTOCK", refundMethod: "CASH", returnDate: day }, ctx());
    const report = await groupProfitAndLoss();
    expect(Number(report.closingUnrealised)).toBe(100);
    const lot = await db.inventoryLot.findFirstOrThrow({ where: { state: "AWAITING_REPAIR" } });
    expect(Number(lot.transferMarginPerUnit)).toBe(100);
  });

  it("settlement rejects another provider and entity", async () => {
    await stock();
    const sold = await createSale(sale({ source: "MODERATOR", payments: [{ method: "COD", amount: 1500, fee: 0, collected: false }] }), ctx());
    const payment = await db.salesPayment.findFirstOrThrow({ where: { salesOrderId: sold.salesOrderId } });
    await expect(recordSettlement({ provider: "PAYMENT_GATEWAY", entityId: factoryId, settlementDate: day, netReceived: "1500", paymentIds: [payment.id] }, ctx())).rejects.toThrow(/company, provider/);
    expect((await db.salesPayment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe("PENDING");
    expect(await balance("1135", brandId)).toBe(1500);
    expect(await balance("1130", factoryId)).toBe(0);
  });
});
