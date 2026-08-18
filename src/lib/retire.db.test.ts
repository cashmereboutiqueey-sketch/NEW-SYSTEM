import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { setCollectionActive, setVariantActive, ProductError } from "./products";
import { setClientActive, CMTError } from "./cmt";
import { setConsignorActive, createConsignor, ConsignmentError } from "./consignment";
import { setCampaignStatus } from "./marketing";

/**
 * Closing things down.
 *
 * Every one of these carried a flag or a status that nothing ever set, so a
 * season could be started and never finished, a size introduced and never
 * dropped, a client retired only in somebody's head. Nothing is deleted: the
 * history points at all of it.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let ownerId: string;
const ctx = () => ({ userId: ownerId, reason: null });
const tag = Math.random().toString(36).slice(2, 6).toUpperCase();

beforeAll(async () => {
  ownerId = (await db.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
});

afterAll(async () => {
  await db.$disconnect();
});

describe("closing a season", () => {
  let collectionId: string;

  beforeEach(async () => {
    const c = await db.collection.findFirstOrThrow();
    collectionId = c.id;
    await db.collection.update({ where: { id: c.id }, data: { isActive: true } });
  });

  it("takes it out of the pickers without touching its styles", async () => {
    const before = await db.style.count({ where: { collectionId } });

    const result = await setCollectionActive({ id: collectionId, isActive: false }, ctx());

    expect(result.isActive).toBe(false);
    // Retiring hides; it does not remove.
    expect(await db.style.count({ where: { collectionId } })).toBe(before);
    expect(result.styles).toBe(before);
  });

  it("can be reopened", async () => {
    await setCollectionActive({ id: collectionId, isActive: false }, ctx());
    const back = await setCollectionActive({ id: collectionId, isActive: true }, ctx());
    expect(back.isActive).toBe(true);
  });

  it("refuses while the floor is still cutting it", async () => {
    const style = await db.style.findFirstOrThrow({ where: { collectionId } });
    const run = await db.productionOrder.create({
      data: {
        orderNumber: `PO-RET-${tag}`,
        styleId: style.id,
        status: "IN_PRODUCTION",
        plannedQty: 10,
        orderDate: new Date(),
      },
    });

    // The collection would vanish from the pickers while a run is open.
    await expect(
      setCollectionActive({ id: collectionId, isActive: false }, ctx()),
    ).rejects.toThrow(/production run/i);

    await db.productionOrder.delete({ where: { id: run.id } });
  });

  it("records the change", async () => {
    await setCollectionActive({ id: collectionId, isActive: false }, ctx());

    const log = await db.auditLog.findFirst({
      where: { entityId: collectionId, action: "COLLECTION_CLOSED" },
      orderBy: { createdAt: "desc" },
    });
    expect(log).toBeTruthy();
  });
});

describe("dropping a size", () => {
  let variantId: string;

  beforeEach(async () => {
    const v = await db.variant.findFirstOrThrow();
    variantId = v.id;
    await db.variant.update({ where: { id: v.id }, data: { isActive: true } });
  });

  it("stops it being made without stopping it being sold", async () => {
    const result = await setVariantActive({ id: variantId, isActive: false }, ctx());

    expect(result.isActive).toBe(false);
    // Dropping a size is usually the decision that comes before running the
    // last of it down, so stock on the shelf is not a reason to refuse.
    expect(result.stillOnHand).toBeDefined();
  });

  it("says what is still on the shelf, so nobody goes looking for it", async () => {
    const result = await setVariantActive({ id: variantId, isActive: false }, ctx());
    expect(Number(result.stillOnHand)).toBeGreaterThanOrEqual(0);
  });

  it("can be brought back", async () => {
    await setVariantActive({ id: variantId, isActive: false }, ctx());
    expect((await setVariantActive({ id: variantId, isActive: true }, ctx())).isActive).toBe(true);
  });

  it("refuses one that does not exist", async () => {
    await expect(setVariantActive({ id: "nope", isActive: false }, ctx())).rejects.toThrow(
      ProductError,
    );
  });
});

describe("retiring a CMT client", () => {
  let clientId: string;

  beforeEach(async () => {
    const existing = await db.cMTClient.findFirst();
    if (existing) {
      clientId = existing.id;
      await db.cMTClient.update({ where: { id: existing.id }, data: { isActive: true } });
    } else {
      clientId = (
        await db.cMTClient.create({
          data: { code: `QA${tag}`, name: "عميل اختبار", isActive: true },
        })
      ).id;
    }
  });

  it("takes them out of the dropdowns and keeps their history", async () => {
    const result = await setClientActive({ id: clientId, isActive: false }, ctx());

    expect(result.isActive).toBe(false);
    // The quotes and orders in their name are the record of work that was done.
    expect(result.quotes).toBeGreaterThanOrEqual(0);
  });

  it("refuses while their work is still in the factory", async () => {
    const style = await db.style.findFirstOrThrow();
    const order = await db.cMTOrder.create({
      data: {
        orderNumber: `CMT-RET-${tag}`,
        clientId,
        status: "CONFIRMED",
        quantity: 10,
        smvPerUnit: "30",
        totalMinutes: "300",
        agreedMinuteRate: "1.5",
        contractValue: "450",
        orderDate: new Date(),
      },
    });

    await expect(setClientActive({ id: clientId, isActive: false }, ctx())).rejects.toThrow(
      /still has/i,
    );

    await db.cMTOrder.delete({ where: { id: order.id } });
  });
});

describe("retiring a consignor", () => {
  it("refuses while their goods are still on the shelf", async () => {
    const consignor = await createConsignor(
      { code: `CON-${tag}A`, name: `صاحبة بضاعة ${tag}`, commissionRate: "0.2" },
      ctx(),
    );

    const location = await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } });
    const item = await db.consignmentItem.create({
      data: {
        itemCode: `ITM-${tag}A`,
        consignorId: consignor.id,
        description: "فستان أمانة",
        locationId: location.id,
        quantityReceived: 5,
        quantitySold: 0,
        quantityReturned: 0,
        retailPrice: "500",
        commissionRate: "0.2",
        receivedDate: new Date(),
      },
    });

    // Hiding somebody whose stock you are holding is how a settlement gets
    // forgotten.
    await expect(
      setConsignorActive({ consignorId: consignor.id, isActive: false }, ctx()),
    ).rejects.toThrow(/on your shelf/i);

    await db.consignmentItem.delete({ where: { id: item.id } });
    await db.consignor.delete({ where: { id: consignor.id } });
  });

  it("allows it once nothing is held and nothing is owed", async () => {
    const consignor = await createConsignor(
      { code: `CON-${tag}B`, name: `صاحبة بضاعة ${tag}B`, commissionRate: "0.2" },
      ctx(),
    );

    const result = await setConsignorActive({ consignorId: consignor.id, isActive: false }, ctx());
    expect(result.isActive).toBe(false);

    await db.consignor.delete({ where: { id: consignor.id } });
  });
});

describe("finishing a campaign", () => {
  let campaignId: string;

  beforeEach(async () => {
    const existing = await db.campaign.findFirst();
    if (existing) {
      campaignId = existing.id;
      await db.campaign.update({
        where: { id: existing.id },
        data: { status: "RUNNING", endDate: null },
      });
    }
  });

  it("stops it taking a share of the spend allocation", async () => {
    if (!campaignId) return;

    const result = await setCampaignStatus({ campaignId, status: "FINISHED" }, ctx());

    expect(result.status).toBe("FINISHED");
    // A campaign with no end is what caused the problem, so finishing sets one.
    expect(result.endDate).toBeTruthy();
  });

  it("can be paused and restarted without ending it", async () => {
    if (!campaignId) return;

    const paused = await setCampaignStatus({ campaignId, status: "PAUSED" }, ctx());
    expect(paused.status).toBe("PAUSED");
    expect(paused.endDate).toBeNull();

    const running = await setCampaignStatus({ campaignId, status: "RUNNING" }, ctx());
    expect(running.status).toBe("RUNNING");
  });

  it("leaves the spend already recorded against it alone", async () => {
    if (!campaignId) return;

    const before = await db.campaignSpend.count({ where: { campaignId } });
    const result = await setCampaignStatus({ campaignId, status: "FINISHED" }, ctx());

    expect(result.spendEntries).toBe(before);
    expect(await db.campaignSpend.count({ where: { campaignId } })).toBe(before);
  });
});
