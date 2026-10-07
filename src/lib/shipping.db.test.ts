import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { receiveFinishedGoods } from "./inventory";
import { createSale } from "./sales";
import { correctDirectBankPayment } from "./reconciliation";
import {
  createCourierZone, readyToShip, createShipmentBatches, recordFlextockStatus,
  updateDestination, courierOwesUs, FLEXTOCK, ShippingError,
} from "./shipping";
import { createFlextockClient } from "./flextock-api";
import { prepareFlextockOrder, submitFlextockOrder, refreshFlextockShipment } from "./flextock-shipping";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
let brandId: string;
let channelId: string;
let locationId: string;
let variantId: string;
let userId: string;
let day: Date;
const ctx = () => ({ userId, reason: null });

beforeAll(async () => {
  brandId = (await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } })).id;
  channelId = (await db.salesChannel.findFirstOrThrow()).id;
  locationId = (await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } })).id;
  variantId = (await db.variant.findFirstOrThrow({ orderBy: { sku: "asc" } })).id;
  userId = (await db.user.findFirstOrThrow({ where: { email: "owner@cashmere.eg" } })).id;
  const period = await db.fiscalPeriod.findFirstOrThrow({ where: { status: "OPEN" }, orderBy: { startDate: "asc" } });
  day = new Date(period.startDate);
});

async function wipe() {
  await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
  await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
  try {
    await db.shipment.deleteMany({});
    await db.shipmentBatch.deleteMany({});
    await db.commandReceipt.deleteMany({});
    await db.salesPayment.deleteMany({});
    await db.salesOrderLine.deleteMany({});
    await db.salesOrder.deleteMany({});
    await db.courierZone.deleteMany({});
    await db.tillCashEvent.deleteMany({});
    await db.inventoryMovement.deleteMany({});
    await db.inventoryLot.deleteMany({});
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
  await receiveFinishedGoods(
    { variantId, locationId, entityId: brandId, quantity: "50", unitCost: "400", materialUnitCost: "300", receivedDate: day },
    { userId: null, reason: null },
  );
});
afterAll(async () => { await wipe(); await db.$disconnect(); });

async function zone() {
  return createCourierZone({ governorate: "الإسكندرية", region: "سموحة", price: "32" }, ctx());
}

async function order(courierZoneId: string | null, address: string | null = "12 Test Street", source: "MODERATOR" | "WHOLESALE" = "MODERATOR") {
  return createSale({
    source, channelId, entityId: brandId, locationId, orderDate: day,
    shippingAmount: 45,
    lines: [{ variantId, quantity: 2, retailPrice: 880, discountPct: 0 }],
    payments: [{ method: "COD", amount: 1805, fee: 0, collected: false }],
    destination: {
      recipientName: "Mona", phone: "01001234567", secondPhone: null,
      courierZoneId, addressLine: address,
    },
  }, ctx());
}

describe("Flextock handoff", () => {
  it("keeps wholesale orders outside the retail parcel contract", async () => {
    const area = await zone();
    const sale = await order(area.id, "12 Test Street", "WHOLESALE");
    expect((await readyToShip()).some((item) => item.id === sale.salesOrderId)).toBe(false);
    await expect(prepareFlextockOrder(sale.salesOrderId)).rejects.toThrow(/wholesale/);
  });
  it("submits an order before recording handoff and keeps COD delivery under review", async () => {
    const area = await zone();
    const sale = await order(area.id);
    const sku = (await db.variant.findUniqueOrThrow({ where: { id: variantId } })).sku;
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access: "test-access" }))
      .mockResolvedValueOnce(Response.json({ response: [{ sku_code: sku, message: "SKU code created successfully." }] }))
      .mockResolvedValueOnce(Response.json({ message: "Order created successfully." }))
      .mockResolvedValueOnce(Response.json({ order_status: "delivered", tracking_number: "FT-123", tracking_url: "https://flextock.com/track/123" }));
    const client = createFlextockClient({ username: "test", password: "test", apiKey: "test" }, request);
    await submitFlextockOrder(sale.salesOrderId, ctx(), client);
    const shipment = await db.shipment.findFirstOrThrow({ where: { salesOrderId: sale.salesOrderId } });
    expect(shipment.apiSubmittedAt).not.toBeNull();
    expect(Number(shipment.codAmount)).toBe(1805);
    expect((await db.salesOrder.findUniqueOrThrow({ where: { id: sale.salesOrderId } })).status).toBe("SHIPPED");
    await refreshFlextockShipment(sale.orderNumber, ctx(), client);
    const refreshed = await db.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect(refreshed.status).toBe("NEEDS_REVIEW");
    expect(refreshed.trackingNumber).toBe("FT-123");
    expect((await db.salesOrder.findUniqueOrThrow({ where: { id: sale.salesOrderId } })).status).toBe("SHIPPED");
    expect(request).toHaveBeenCalledTimes(4);
  });
  it("adds a confirmed area under Flextock", async () => {
    const created = await zone();
    const saved = await db.courierZone.findUniqueOrThrow({ where: { id: created.id } });
    expect(saved.courier).toBe(FLEXTOCK);
    expect(saved.branch).toBe("DIRECT");
    expect(created.price).toBe("32");
  });

  it("shows a missing area or address before handoff", async () => {
    const sale = await order(null, null);
    const ready = (await readyToShip()).find((item) => item.id === sale.salesOrderId)!;
    expect(ready.problems).toEqual(["no delivery area", "no street address"]);
    await expect(createShipmentBatches({ salesOrderIds: [sale.salesOrderId], acceptedByFlextock: true }, ctx()))
      .rejects.toThrow(/cannot go yet/);
  });

  it("records only accepted orders and blocks duplicate handoff", async () => {
    const area = await zone();
    const sale = await order(area.id);
    await expect(createShipmentBatches({ salesOrderIds: [sale.salesOrderId], acceptedByFlextock: false }, ctx()))
      .rejects.toThrow(/Confirm Flextock accepted/);
    expect(await db.shipment.count()).toBe(0);
    const result = await createShipmentBatches({ salesOrderIds: [sale.salesOrderId], acceptedByFlextock: true }, ctx());
    expect(result.batches).toHaveLength(1);
    expect(result.batches[0].branch).toBe("DIRECT");
    const shipment = await db.shipment.findFirstOrThrow({ where: { salesOrderId: sale.salesOrderId } });
    expect(shipment.courier).toBe(FLEXTOCK);
    expect(Number(shipment.codAmount)).toBe(1805);
    expect((await db.salesOrder.findUniqueOrThrow({ where: { id: sale.salesOrderId } })).status).toBe("SHIPPED");
    await expect(createShipmentBatches({ salesOrderIds: [sale.salesOrderId], acceptedByFlextock: true }, ctx()))
      .rejects.toThrow(ShippingError);
  });

  it("fixes the destination before handoff, and locks it afterward", async () => {
    const area = await zone();
    const sale = await order(null);
    await updateDestination({ salesOrderId: sale.salesOrderId, courierZoneId: area.id }, ctx());
    expect((await readyToShip()).find((item) => item.id === sale.salesOrderId)?.problems).toEqual([]);
    await createShipmentBatches({ salesOrderIds: [sale.salesOrderId], acceptedByFlextock: true }, ctx());
    await expect(updateDestination({ salesOrderId: sale.salesOrderId, courierZoneId: area.id }, ctx()))
      .rejects.toThrow(/already gone/);
  });

  it("updates a dispatched parcel's COD after direct bank payment", async () => {
    const area = await zone();
    const sale = await order(area.id);
    await createShipmentBatches({ salesOrderIds: [sale.salesOrderId], acceptedByFlextock: true }, ctx());
    const result = await correctDirectBankPayment(
      { orderNumber: sale.orderNumber, method: "INSTAPAY", receivedOn: day, reference: "IP-FLEXTOCK" }, ctx(),
    );
    expect(result.shipmentUpdated).toBe(true);
    expect(Number((await db.shipment.findFirstOrThrow({ where: { salesOrderId: sale.salesOrderId } })).codAmount)).toBe(0);
  });

  it("records a confirmed delivery once and its COD due", async () => {
    const area = await zone();
    const sale = await order(area.id);
    await createShipmentBatches({ salesOrderIds: [sale.salesOrderId], acceptedByFlextock: true }, ctx());
    const update = { reference: sale.orderNumber, status: "DELIVERED" as const,
      collectedAmount: "1805", courierFee: "32", dueToUs: "1773", providerStatus: "delivered" };
    expect((await recordFlextockStatus(update, ctx())).delivered).toBe(true);
    expect((await recordFlextockStatus(update, ctx())).changed).toBe(false);
    expect((await db.salesOrder.findUniqueOrThrow({ where: { id: sale.salesOrderId } })).status).toBe("DELIVERED");
    expect((await courierOwesUs()).outstanding).toBe("1773");
  });

  it("does not call expected COD collected without collection figures", async () => {
    const area = await zone();
    const sale = await order(area.id);
    await createShipmentBatches({ salesOrderIds: [sale.salesOrderId], acceptedByFlextock: true }, ctx());
    await recordFlextockStatus({ reference: sale.orderNumber, status: "DELIVERED", providerStatus: "delivered" }, ctx());
    const shipment = await db.shipment.findFirstOrThrow({ where: { salesOrderId: sale.salesOrderId } });
    expect(shipment.status).toBe("NEEDS_REVIEW");
    expect((await db.salesOrder.findUniqueOrThrow({ where: { id: sale.salesOrderId } })).status).toBe("SHIPPED");
    expect((await courierOwesUs()).collected).toBe("0");
  });
});
