import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { receiveFinishedGoods } from "./inventory";
import { createSale } from "./sales";
import { correctDirectBankPayment } from "./reconciliation";
import {
  createCourierZone, readyToShip, createShipmentBatches, recordFlextockStatus,
  updateDestination, courierOwesUs, FLEXTOCK, ShippingError,
} from "./shipping";

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

async function order(courierZoneId: string | null, address: string | null = "12 Test Street") {
  return createSale({
    source: "MODERATOR", channelId, entityId: brandId, locationId, orderDate: day,
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
});
