import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import {
  rateCard,
  minimumQuantityFor,
  leadTimeDays,
  createQuote,
  createClient,
  CMT_SETUP_MINUTES,
  CMT_MINIMUM_QUANTITY,
  CMTError,
} from "./cmt";
import { dec } from "./money";
import { createExpense } from "./expenses";
import { calculatePeriodMinuteRate } from "./minute-rate";

/**
 * What to tell a client who asks "how few can you make, and for how much".
 *
 * The price falls with quantity for exactly one reason: the setup is spread
 * over more garments. These tests hold that to be arithmetic rather than
 * salesmanship — the number in the table has to be reproducible from the SMV,
 * the setup and the minute rate, or it is a discount somebody invented.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let clientId: string;
let pickyClientId: string;

const ctx = { userId: null as string | null, reason: null };

beforeAll(async () => {
  await db.setting.upsert({
    where: { key: CMT_SETUP_MINUTES },
    update: { value: "480" },
    create: {
      key: CMT_SETUP_MINUTES, value: "480", type: "DECIMAL", group: "cmt",
      labelAr: "دقائق التجهيز للأمر", labelEn: "Setup minutes per run",
    },
  });
  await db.setting.upsert({
    where: { key: CMT_MINIMUM_QUANTITY },
    update: { value: "100" },
    create: {
      key: CMT_MINIMUM_QUANTITY, value: "100", type: "INTEGER", group: "cmt",
      labelAr: "أقل كمية للتصنيع للغير", labelEn: "Minimum CMT run",
    },
  });

  // A rate card is priced off a calculated minute rate, so the test makes one
  // rather than relying on whatever the last suite happened to leave behind.
  const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });
  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" },
    orderBy: { startDate: "asc" },
  });
  const day = new Date(period.startDate);

  const existing = await db.minuteRatePeriod.findFirst({
    where: { entityId: factory.id, fiscalPeriodId: period.id },
  });
  if (!existing) {
    const category = await db.costCategory.findFirstOrThrow({
      where: { includeInMinuteRate: true, entityId: factory.id },
    });
    await createExpense(
      {
        entityId: factory.id, costCategoryId: category.id,
        description: "Conversion pool for the rate card",
        amount: 500_000, incurredDate: day, dueDate: day,
      },
      ctx,
    );
    await calculatePeriodMinuteRate(
      { entityId: factory.id, fiscalPeriodId: period.id }, ctx,
    );
  }

  await db.cMTQuote.deleteMany({ where: { client: { code: { startsWith: "RC-" } } } });
  await db.cMTClient.deleteMany({ where: { code: { startsWith: "RC-" } } });

  clientId = (
    await createClient({ code: "RC-BIG", name: "عميل كبير" }, ctx)
  ).clientId;

  const picky = await createClient({ code: "RC-SMALL", name: "عميل صغير" }, ctx);
  pickyClientId = picky.clientId;
  // Somebody worth taking a short run for.
  await db.cMTClient.update({
    where: { id: pickyClientId },
    data: { minimumQuantity: 50 },
  });
});

afterAll(async () => {
  await db.cMTQuote.deleteMany({ where: { client: { code: { startsWith: "RC-" } } } });
  await db.cMTClient.deleteMany({ where: { code: { startsWith: "RC-" } } });
  await db.$disconnect();
});

describe("the minimum run", () => {
  it("falls back to the house rule", async () => {
    expect(await minimumQuantityFor(clientId)).toBe(100);
    expect(await minimumQuantityFor(null)).toBe(100);
  });

  it("lets a particular client go lower", async () => {
    expect(await minimumQuantityFor(pickyClientId)).toBe(50);
  });

  it("refuses a quote under it", async () => {
    await expect(
      createQuote(
        {
          clientId,
          styleDescription: "قميص",
          quantity: 40,
          smvPerUnit: "25",
          quotedMinuteRate: "999",
          quoteDate: new Date(),
        },
        ctx,
      ),
    ).rejects.toThrow(/below the minimum of 100/i);
  });

  it("accepts the same run from the client whose minimum is lower", async () => {
    const card = await rateCard({ smvPerUnit: "25", clientId: pickyClientId });
    expect(card!.minimumQuantity).toBe(50);
    expect(card!.tiers[0].quantity).toBe(50);
  });
});

describe("the price table", () => {
  it("starts at the client's minimum and climbs", async () => {
    const card = await rateCard({ smvPerUnit: "25", clientId });
    expect(card).not.toBeNull();

    const quantities = card!.tiers.map((t) => t.quantity);
    expect(quantities[0]).toBe(100);
    expect(quantities).toEqual([...quantities].sort((a, b) => a - b));
  });

  it("spreads the setup over the run, and says so", async () => {
    const card = await rateCard({ smvPerUnit: "25", clientId });
    const hundred = card!.tiers.find((t) => t.quantity === 100)!;
    const thousand = card!.tiers.find((t) => t.quantity === 1000)!;

    // 480 setup minutes over 100 pieces is 4.8 each; over 1,000 it is 0.48.
    expect(Number(hundred.setupPerUnit)).toBeCloseTo(4.8, 4);
    expect(Number(thousand.setupPerUnit)).toBeCloseTo(0.48, 4);
  });

  it("prices each tier from the minutes, reproducibly", async () => {
    const card = await rateCard({ smvPerUnit: "25", clientId, marginOverFloor: "0.15" });
    const rate = dec(card!.quotedMinuteRate);

    for (const tier of card!.tiers) {
      const minutes = dec(25).plus(dec(card!.setupMinutes).dividedBy(tier.quantity));
      // The number on the table is (SMV + setup ÷ qty) × rate, and nothing else.
      expect(Number(tier.unitPrice)).toBeCloseTo(
        minutes.times(rate).toDecimalPlaces(2).toNumber(),
        2,
      );
      // The client must be able to reproduce the total from the printed unit
      // price, so this is exact rather than close.
      expect(Number(tier.total)).toBe(
        Number((Number(tier.unitPrice) * tier.quantity).toFixed(2)),
      );
    }
  });

  it("gets cheaper per garment as the run grows, and never dearer", async () => {
    const card = await rateCard({ smvPerUnit: "25", clientId });
    const prices = card!.tiers.map((t) => Number(t.unitPrice));

    for (let i = 1; i < prices.length; i++) {
      expect(prices[i]).toBeLessThan(prices[i - 1]);
    }
  });

  it("quotes above the floor by the margin asked for", async () => {
    const card = await rateCard({ smvPerUnit: "25", clientId, marginOverFloor: "0.20" });
    const floor = dec(card!.floorMinuteRate);
    const quoted = dec(card!.quotedMinuteRate);

    expect(quoted.greaterThan(floor)).toBe(true);
    expect(quoted.toNumber()).toBeCloseTo(floor.times(1.2).toNumber(), 4);
    expect(Number(card!.marginOverFloorPct)).toBeCloseTo(20, 2);
  });

  it("refuses a garment with no minutes in it", async () => {
    await expect(rateCard({ smvPerUnit: "0", clientId })).rejects.toThrow(CMTError);
  });
});

describe("how long it will take", () => {
  it("answers in days from the factory as measured", async () => {
    const lead = await leadTimeDays(dec(10_000));
    expect(lead).not.toBeNull();
    expect(lead!.days).toBeGreaterThan(0);
    expect(lead!.minutesPerDay.greaterThan(0)).toBe(true);
  });

  it("takes longer for more work", async () => {
    const small = await leadTimeDays(dec(5_000));
    const large = await leadTimeDays(dec(50_000));
    expect(large!.days).toBeGreaterThan(small!.days);
  });

  it("says when a run will not fit in what is left this month", async () => {
    const lead = await leadTimeDays(dec(99_999_999));
    // A date that ignores the queue is a date that will be missed.
    expect(lead!.fitsInPeriod).toBe(false);
  });

  it("puts a lead time and a capacity answer on every tier", async () => {
    const card = await rateCard({ smvPerUnit: "25", clientId });
    for (const tier of card!.tiers) {
      expect(tier.leadDays).not.toBeNull();
      expect(typeof tier.capacityAvailable).toBe("boolean");
    }
  });
});
