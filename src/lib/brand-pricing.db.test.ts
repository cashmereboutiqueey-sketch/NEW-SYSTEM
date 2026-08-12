import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { brandPriceList, priceStyle, pricingGap } from "./brand-pricing";

/**
 * The brand's pricing engine.
 *
 * The factory prices its own cost and stops. The brand starts from the
 * transfer price and still has a shop to pay for — rent, the people in it,
 * the advertising, the bag, and the garments that come back. A price that
 * clears the transfer price and nothing else is how a shop turns over money
 * all season and finds nothing at the end of it.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const TRANSFER_PRICE = 750;
const MONTHLY_OVERHEAD = 60_000;
const MONTHLY_UNITS = 200; // → 300 of overhead a garment

let brandId: string;
let factoryId: string;
let styleId: string;
let otherStyleId: string;
let minuteRatePeriodId: string;

/**
 * What the demo held before this file ran.
 *
 * These tests null every retail price and clear the cost snapshots, which is
 * fine inside the run and ruinous after it: the app would come up with no
 * prices and nothing costed, and the next person to open it — including me,
 * an hour later — would be debugging a database this file emptied.
 */
let originalPrices: { id: string; retailPrice: string | null }[] = [];
let originalSettings: { key: string; value: string }[] = [];

beforeAll(async () => {
  brandId = (await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } })).id;
  factoryId = (await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } })).id;

  const styles = await db.style.findMany({ take: 2, orderBy: { code: "asc" } });
  styleId = styles[0].id;
  otherStyleId = styles[1]?.id ?? styles[0].id;

  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" },
    orderBy: { startDate: "asc" },
  });

  originalPrices = (
    await db.style.findMany({ select: { id: true, retailPrice: true } })
  ).map((s) => ({ id: s.id, retailPrice: s.retailPrice?.toString() ?? null }));
  originalSettings = (
    await db.setting.findMany({
      where: { key: { startsWith: "brand." } },
      select: { key: true, value: true },
    })
  ).map((s) => ({ key: s.key, value: s.value }));

  minuteRatePeriodId = (
    await db.minuteRatePeriod.upsert({
      where: { entityId_fiscalPeriodId: { entityId: factoryId, fiscalPeriodId: period.id } },
      update: {},
      create: {
        entityId: factoryId, fiscalPeriodId: period.id,
        operators: 40, workingDays: "26", hoursPerDay: "9",
        utilisationRate: "0.85", efficiencyRate: "0.75",
        totalConversionCost: "364000", netCostPool: "364000",
        grossAvailableMinutes: "561600", productiveMinutes: "358020",
        actualMinuteRate: "1.5078", fullCapacityMinuteRate: "0.6481",
        idlePenaltyPerMinute: "0.8597", idleMinutes: "203580",
      },
    })
  ).id;
});

beforeEach(async () => {
  await db.costSnapshotLine.deleteMany({});
  await db.costSnapshot.deleteMany({});
  await db.style.updateMany({ data: { retailPrice: null } });

  await db.setting.updateMany({
    where: { key: "brand.returnRate" },
    data: { value: "0" },
  });
  for (const key of ["brand.packagingPerUnit", "brand.shippingPerUnit"]) {
    await db.setting.updateMany({ where: { key }, data: { value: "0" } });
  }
});

afterAll(async () => {
  // Put the demo back. The cost snapshots this file created are still gone —
  // they were never real — so the demo is reloaded rather than patched when
  // the costings are wanted again.
  for (const style of originalPrices) {
    await db.style.update({
      where: { id: style.id },
      data: { retailPrice: style.retailPrice },
    });
  }
  for (const setting of originalSettings) {
    await db.setting.update({ where: { key: setting.key }, data: { value: setting.value } });
  }
  await db.$disconnect();
});

/** A frozen transfer price for a style: what the brand pays the factory. */
async function costed(style = styleId, transferPrice = TRANSFER_PRICE) {
  await db.costSnapshot.create({
    data: {
      styleId: style, minuteRatePeriodId,
      minuteRate: "1.5078", fullCapacityRate: "1.2", smvMinutes: "39",
      wasteRate: "0.1", factoryMarkupPct: "0.25",
      fabricCost: "540", trimCost: "10", materialCost: "550",
      cmtCost: "50", factoryTotalCost: String(transferPrice * 0.8),
      transferPrice: String(transferPrice),
      idleCapacityPenalty: "12",
    },
  });
}

async function pricedAt(amount: number, style = styleId) {
  await db.style.update({ where: { id: style }, data: { retailPrice: String(amount) } });
}

/** Overheads typed in, so the test does not depend on what the demo happens to hold. */
const basis = {
  monthlyOverhead: MONTHLY_OVERHEAD,
  monthlyUnits: MONTHLY_UNITS,
  marketingPerUnit: 0,
  packagingPerUnit: 0,
  shippingPerUnit: 0,
  returnRate: 0,
};

const list = () => brandPriceList(brandId, { overrides: basis });
const mine = <T extends { styleId: string }>(rows: T[]) => rows.find((r) => r.styleId === styleId)!;

describe("what a garment really costs the brand", () => {
  it("spreads the shop's overhead over the garments it expects to sell", async () => {
    await costed();

    const { basis: b } = await list();

    // 60,000 a month over 200 garments.
    expect(Number(b.overheadPerUnit)).toBe(300);
    expect(Number(b.costToSellPerUnit)).toBe(300);
  });

  it("adds the shop's cost to what the factory charged", async () => {
    await costed();

    const row = mine((await list()).styles);

    expect(Number(row.transferPrice)).toBe(TRANSFER_PRICE);
    expect(Number(row.costToSell)).toBe(300);
    expect(Number(row.trueCost)).toBe(1050);
  });

  it("makes the garments that sell carry the ones that come back", async () => {
    await costed();

    // At a 10% return rate, one garment in ten earns nothing, so the nine
    // that do sell have to cover it: 1050 × 0.1 ÷ 0.9.
    const { styles } = await brandPriceList(brandId, {
      overrides: { ...basis, returnRate: 0.1 },
    });
    const row = mine(styles);

    expect(Number(row.returnAllowance)).toBeCloseTo(116.67, 2);
    expect(Number(row.trueCost)).toBeCloseTo(1166.67, 2);
  });

  it("charges nothing for returns when nothing comes back", async () => {
    await costed();
    expect(Number(mine((await list()).styles).returnAllowance)).toBe(0);
  });
});

describe("the flattering number and the honest one", () => {
  it("reports both, and they are not the same", async () => {
    await costed();
    await pricedAt(1500);

    const row = mine((await list()).styles);

    // Against the transfer price alone: 750 profit on 1500. Half.
    expect(Number(row.grossMargin)).toBeCloseTo(0.5, 6);
    // After the shop has been paid for: 450 on 1500. Under a third.
    expect(Number(row.actualMargin)).toBeCloseTo(0.3, 6);
  });

  it("catches a garment that clears the factory but not the shop", async () => {
    await costed();
    await pricedAt(900); // above the 750 transfer price, below the 1050 true cost

    const row = mine((await list()).styles);

    // It looks like a 16.7% margin and it is a loss of 150 a piece. This is
    // the case the whole screen exists for.
    expect(Number(row.grossMargin)).toBeCloseTo(0.1667, 4);
    expect(row.losesMoney).toBe(true);
    expect(Number(row.actualMargin)).toBeLessThan(0);
  });
});

describe("what the price should be", () => {
  it("prices to a margin, not to a markup", async () => {
    await costed();

    const row = mine((await list()).styles);

    // 55% target on a 1050 true cost: 1050 ÷ 0.45. Marking cost up by 55%
    // would give 1627.50 and a margin of only 35.5%.
    expect(Number(row.suggestedPrice)).toBeCloseTo(2333.33, 2);
    expect(Number(row.suggestedPrice)).not.toBeCloseTo(1627.5, 2);
  });

  it("says how far short today's price is", async () => {
    await costed();
    await pricedAt(1800);

    const row = mine((await list()).styles);
    expect(Number(row.shortfall)).toBeCloseTo(533.33, 2);
  });

  it("moves the answer when the rent is typed over", async () => {
    await costed();

    const cheap = mine((await list()).styles);
    const dear = mine(
      (await brandPriceList(brandId, {
        overrides: { ...basis, monthlyOverhead: MONTHLY_OVERHEAD * 2 },
      })).styles,
    );

    // 600 of overhead a garment instead of 300.
    expect(Number(dear.trueCost)).toBe(1350);
    expect(Number(dear.suggestedPrice)).toBeGreaterThan(Number(cheap.suggestedPrice));
  });

  it("suggests nothing for a style nobody has costed", async () => {
    // No snapshot: there is no defensible cost, and an invented suggestion
    // would be worse than none.
    await pricedAt(1500);

    const row = mine((await list()).styles);

    expect(row.stale).toBe(true);
    expect(row.trueCost).toBeNull();
    expect(row.suggestedPrice).toBeNull();
    // Still listed, because a garment being sold at a price nobody can
    // justify is exactly what somebody needs to see.
    expect(row.retailPrice).not.toBeNull();
  });
});

describe("the number a salesperson can refuse to go under", () => {
  it("prices the floor from the minimum margin", async () => {
    await costed();
    await pricedAt(2000);

    const row = mine((await list()).styles);

    // 1050 true cost at a 25% minimum → 1400.
    expect(Number(row.floor)).toBeCloseTo(1400, 6);
    // 600 of the 2000 can be given away before hitting it.
    expect(Number(row.discountRoom)).toBeCloseTo(0.3, 6);
  });

  it("gives no discount room on a garment already below the floor", async () => {
    await costed();
    await pricedAt(1200); // above cost, under the 1400 floor

    const row = mine((await list()).styles);

    expect(row.losesMoney).toBe(false);
    expect(Number(row.discountRoom)).toBe(0);
  });

  it("stops naming a wipeout discount once the garment already loses money", async () => {
    await costed();
    await pricedAt(900);

    const row = mine((await list()).styles);

    // There is no discount that wipes out a profit that is not there, and a
    // negative percentage reads as though there were still room.
    expect(row.losesMoney).toBe(true);
    expect(row.wipeoutDiscount).toBeNull();
  });
});

describe("the ladder", () => {
  it("takes more of the profit than it takes of the price", async () => {
    await costed();
    await pricedAt(1500);

    const { ladder } = await priceStyle(brandId, styleId, { overrides: basis });
    const at20 = ladder.find((r) => Number(r.discount) === 0.2)!;

    // 1200 against a 1050 cost: 150 left of the 450 there was.
    expect(Number(at20.price)).toBe(1200);
    expect(Number(at20.profit)).toBe(150);
    expect(Number(at20.profitGivenUp)).toBeCloseTo(0.6667, 4);
  });

  it("marks the rungs that sell at a loss", async () => {
    await costed();
    await pricedAt(1500);

    const { ladder } = await priceStyle(brandId, styleId, { overrides: basis });

    // Break-even is at 30%: the price has fallen to 1050.
    expect(ladder.find((r) => Number(r.discount) === 0.3)!.belowCost).toBe(false);
    expect(ladder.find((r) => Number(r.discount) === 0.4)!.belowCost).toBe(true);
  });

  it("has no ladder for a style with no cost to measure against", async () => {
    await pricedAt(1500);
    const { ladder } = await priceStyle(brandId, styleId, { overrides: basis });
    expect(ladder).toHaveLength(0);
  });
});

describe("the volume assumption", () => {
  it("says when the overhead is bigger than the garment", async () => {
    await costed();

    // Two garments a month against 60,000 of rent: 30,000 a garment. The
    // price would be a statement about volume, not a costing.
    const { basis: b } = await brandPriceList(brandId, {
      overrides: { ...basis, monthlyUnits: 2 },
    });

    expect(Number(b.overheadPerUnit)).toBe(30_000);
    expect(b.overheadDominates).toBe(true);
  });

  it("is quiet when the volume is sensible", async () => {
    await costed();
    const { basis: b } = await list();
    expect(b.overheadDominates).toBe(false);
  });

  it("records where the volume came from", async () => {
    await costed();

    const typed = await brandPriceList(brandId, { overrides: basis });
    expect(typed.basis.unitsBasis).toBe("typed");

    // Nothing typed and nothing planned falls back to what actually sold.
    const measured = await brandPriceList(brandId, {
      overrides: { ...basis, monthlyUnits: null },
    });
    expect(measured.basis.unitsBasis).toBe("measured");
  });
});

describe("the gap across the whole range", () => {
  it("counts what is losing money and what is merely short", async () => {
    if (otherStyleId === styleId) return;

    await costed(styleId);
    await pricedAt(900, styleId); // a loss
    await costed(otherStyleId);
    await pricedAt(1800, otherStyleId); // short of target, still profitable

    const gap = await pricingGap(brandId, {});
    const scoped = await brandPriceList(brandId, { overrides: basis });

    expect(scoped.styles.filter((s) => s.losesMoney)).toHaveLength(1);
    expect(gap.total).toBeGreaterThanOrEqual(2);
    // The loss-maker sorts first: it is what somebody has to deal with today.
    expect(scoped.styles[0].losesMoney).toBe(true);
  });
});
