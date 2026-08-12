import "server-only";
import { db } from "./db";
import { dec, type Decimal, type Numeric } from "./money";
import {
  priceFromMargin, marginOf, markupOf, discountLadder,
  floorPrice, maximumDiscount, breakEvenDiscount,
} from "@/core/pricing";

/**
 * The brand's pricing engine — the second of the two.
 *
 * The factory prices its own cost: materials plus minutes, plus a markup, and
 * the answer is the transfer price. That is where the factory's job ends.
 *
 * The brand starts from that transfer price as its cost of goods and has to
 * cover things the factory never sees — the shop's rent, the people standing
 * in it, the advertising that brought the customer in, the bag the garment
 * leaves in, and the ones that come back. Only what survives all of that is
 * profit. Pricing a garment at "transfer price plus a bit" is how a shop turns
 * over money all season and finds nothing at the end of it.
 *
 * Everything here is measured from what is already recorded, and everything
 * measured can be overridden. Rent and salaries move, so the measurement is a
 * starting point rather than a rule; what it must never be is invented. When a
 * figure is typed rather than measured the result says so, because a price
 * built on an assumption should not look like a price built on the books.
 */

export class BrandPricingError extends Error {}

/** What the shop costs to run, per garment, before anything is marked up. */
export type PricingBasis = {
  months: number;
  /** Rent, salaries, utilities — whatever is flagged into the brand fixed pool. */
  monthlyOverhead: Decimal;
  overheadMeasured: boolean;
  /**
   * Units a month the overhead is spread over.
   *
   * Absorption costing spreads fixed cost over the volume you expect, not
   * over the volume you happened to do. Trailing actuals are a reasonable
   * stand-in for a shop in steady state and are catastrophic for one that is
   * not: a quarter in which ten garments sold would load every garment with a
   * month's rent and suggest a price nobody would ever charge.
   */
  monthlyUnits: Decimal;
  unitsBasis: "typed" | "planned" | "measured";
  /** monthlyOverhead ÷ monthlyUnits. Null when there is nothing to divide by. */
  overheadPerUnit: Decimal | null;
  marketingPerUnit: Decimal;
  marketingMeasured: boolean;
  packagingPerUnit: Decimal;
  shippingPerUnit: Decimal;
  /** The share that comes back. A return costs the whole garment, not a part. */
  returnRate: Decimal;
  /** Everything above, per garment, excluding the garment itself. */
  costToSellPerUnit: Decimal | null;
  /**
   * The volume assumption is carrying more weight than the garment.
   *
   * When absorbed overhead exceeds what the garment itself cost, the price is
   * mostly a statement about how much the shop expects to sell, and reading it
   * as a costing is a mistake. Reported rather than corrected: the number may
   * be perfectly true for a shop that has just opened.
   */
  overheadDominates: boolean;
};

export type PricingOverrides = {
  monthlyOverhead?: Numeric | null;
  monthlyUnits?: Numeric | null;
  marketingPerUnit?: Numeric | null;
  packagingPerUnit?: Numeric | null;
  shippingPerUnit?: Numeric | null;
  returnRate?: Numeric | null;
  targetMargin?: Numeric | null;
};

const SETTING_KEYS = [
  "brand.packagingPerUnit",
  "brand.shippingPerUnit",
  "brand.returnRate",
  "brand.targetMargin",
  "brand.minimumMargin",
  "brand.expectedMonthlyUnits",
] as const;

/**
 * What it costs to sell a garment, before the garment.
 *
 * The overhead pool and the unit count are both measured over the same window
 * so that dividing one by the other means something. Three months by default:
 * long enough to survive one quiet month, short enough that last year's rent
 * is not still in the number.
 */
export async function pricingBasis(
  entityId: string,
  options: { monthsBack?: number; overrides?: PricingOverrides } = {},
): Promise<PricingBasis> {
  const months = options.monthsBack ?? 3;
  const overrides = options.overrides ?? {};
  const since = new Date();
  since.setMonth(since.getMonth() - months);

  const [overheadRows, unitRows, marketing, settings] = await Promise.all([
    // The same pool break-even uses, so the two screens cannot disagree about
    // what the shop costs to run.
    db.$queryRaw<{ total: string }[]>`
      SELECT COALESCE(SUM(l."debit") - SUM(l."credit"), 0)::text AS total
      FROM "journal_lines" l
      JOIN "journal_entries" e ON e."id" = l."journalEntryId"
      JOIN "accounts" a ON a."id" = l."accountId"
      WHERE a."includeInBrandFixedPool" = true
        AND e."status" = 'POSTED'
        AND l."entityId" = ${entityId}
        AND e."postingDate" >= ${since}
    `,
    db.$queryRaw<{ units: string }[]>`
      SELECT COALESCE(SUM(l."quantity"), 0)::text AS units
      FROM "sales_order_lines" l
      JOIN "sales_orders" o ON o."id" = l."salesOrderId"
      WHERE o."entityId" = ${entityId}
        AND o."orderDate" >= ${since}
        AND o."status" <> 'CANCELLED'
    `,
    db.campaignSpend.aggregate({
      where: { spendDate: { gte: since } },
      _sum: { amount: true },
    }),
    db.setting.findMany({ where: { key: { in: [...SETTING_KEYS] } } }),
  ]);

  const setting = (key: string, fallback: string) =>
    dec(settings.find((s) => s.key === key)?.value ?? fallback);

  const measuredOverhead = dec(overheadRows[0]?.total ?? 0).div(Math.max(months, 1));
  const measuredUnits = dec(unitRows[0]?.units ?? 0).div(Math.max(months, 1));
  const measuredMarketing = dec(marketing._sum.amount ?? 0).div(Math.max(months, 1));

  const monthlyOverhead =
    overrides.monthlyOverhead != null ? dec(overrides.monthlyOverhead) : measuredOverhead;
  // Typed first, then the planned volume the owner has set, then what the
  // shop actually did. The plan wins over the measurement because that is
  // what absorption costing asks for, and because a shop that has just opened
  // would otherwise price itself out of ever selling anything.
  const planned = setting("brand.expectedMonthlyUnits", "0");
  const monthlyUnits =
    overrides.monthlyUnits != null
      ? dec(overrides.monthlyUnits)
      : planned.greaterThan(0)
        ? planned
        : measuredUnits;
  const unitsBasis: "typed" | "planned" | "measured" =
    overrides.monthlyUnits != null ? "typed" : planned.greaterThan(0) ? "planned" : "measured";

  // Marketing is spread across everything sold, because a campaign rarely
  // names one style. Stated rather than buried: it is an allocation, not a
  // measurement of what this garment cost to advertise.
  const marketingPerUnit =
    overrides.marketingPerUnit != null
      ? dec(overrides.marketingPerUnit)
      : monthlyUnits.greaterThan(0)
        ? measuredMarketing.div(monthlyUnits)
        : dec(0);

  const packagingPerUnit =
    overrides.packagingPerUnit != null
      ? dec(overrides.packagingPerUnit)
      : setting("brand.packagingPerUnit", "0");
  const shippingPerUnit =
    overrides.shippingPerUnit != null
      ? dec(overrides.shippingPerUnit)
      : setting("brand.shippingPerUnit", "0");
  const returnRate =
    overrides.returnRate != null ? dec(overrides.returnRate) : setting("brand.returnRate", "0");

  const overheadPerUnit = monthlyUnits.greaterThan(0)
    ? monthlyOverhead.div(monthlyUnits)
    : null;

  return {
    months,
    monthlyOverhead,
    overheadMeasured: overrides.monthlyOverhead == null,
    monthlyUnits,
    unitsBasis,
    overheadPerUnit,
    marketingPerUnit,
    marketingMeasured: overrides.marketingPerUnit == null,
    packagingPerUnit,
    shippingPerUnit,
    returnRate,
    costToSellPerUnit: overheadPerUnit
      ? overheadPerUnit.plus(marketingPerUnit).plus(packagingPerUnit).plus(shippingPerUnit)
      : null,
    // Filled in by the caller, which is the only place that knows what the
    // garments themselves cost.
    overheadDominates: false,
  };
}

export type StylePricing = {
  styleId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  imageName: string | null;

  /** What the brand pays the factory. Its cost of goods, and the factory's revenue. */
  transferPrice: Decimal | null;
  /** Rent, salaries, marketing, packaging, shipping — per garment. */
  costToSell: Decimal | null;
  /**
   * What a return costs, spread over the garments that do sell. A garment that
   * comes back has already absorbed its selling cost and earns nothing.
   */
  returnAllowance: Decimal | null;
  /** Everything the garment has to cover before a piastre is profit. */
  trueCost: Decimal | null;

  /** What the shop charges today. */
  retailPrice: Decimal | null;
  /** The margin that price actually earns against trueCost. */
  actualMargin: Decimal | null;
  /** And against the transfer price alone, which is the flattering one. */
  grossMargin: Decimal | null;
  actualMarkup: Decimal | null;

  /** What it would have to be to hit the target. */
  suggestedPrice: Decimal | null;
  targetMargin: Decimal;
  /** suggestedPrice − retailPrice: positive means today's price is short. */
  shortfall: Decimal | null;

  /** The lowest price that still clears the minimum margin. */
  floor: Decimal | null;
  minimumMargin: Decimal;
  /** The biggest discount off today's price that still clears the floor. */
  discountRoom: Decimal | null;
  /** The discount at which this garment stops earning anything at all. */
  wipeoutDiscount: Decimal | null;

  /** Below cost at today's price: selling it loses money on every piece. */
  losesMoney: boolean;
  /** Priced off a transfer price that no longer reflects a current costing. */
  stale: boolean;
};

/**
 * Price every style the brand sells.
 *
 * A style with no cost snapshot has no defensible cost, so it gets no
 * suggestion — an invented one would be worse than none. It is still listed,
 * because a garment being sold at a price nobody can justify is the thing
 * somebody needs to see.
 */
export async function brandPriceList(
  entityId: string,
  options: { monthsBack?: number; overrides?: PricingOverrides } = {},
): Promise<{ basis: PricingBasis; styles: StylePricing[] }> {
  const basis = await pricingBasis(entityId, options);
  const overrides = options.overrides ?? {};

  const settings = await db.setting.findMany({ where: { key: { in: [...SETTING_KEYS] } } });
  const setting = (key: string, fallback: string) =>
    dec(settings.find((s) => s.key === key)?.value ?? fallback);

  const targetMargin =
    overrides.targetMargin != null ? dec(overrides.targetMargin) : setting("brand.targetMargin", "0.55");
  const minimumMargin = setting("brand.minimumMargin", "0.25");

  const styles = await db.style.findMany({
    where: { isActive: true },
    include: { costSnapshots: { orderBy: { createdAt: "desc" }, take: 1 } },
    orderBy: { code: "asc" },
  });

  const rows = styles.map((style): StylePricing => {
    const snapshot = style.costSnapshots[0];
    const transferPrice = snapshot ? dec(snapshot.transferPrice) : null;
    const retailPrice = style.retailPrice ? dec(style.retailPrice) : null;
    const costToSell = basis.costToSellPerUnit;

    // A return costs the whole garment: it came back, so it earned nothing,
    // and the garments that did sell have to carry it. At a 5% return rate
    // every sold garment carries 1/19th of another one's cost to sell.
    const returnAllowance =
      costToSell && basis.returnRate.lessThan(1)
        ? transferPrice
          ? transferPrice.plus(costToSell).times(basis.returnRate).div(dec(1).minus(basis.returnRate))
          : null
        : null;

    const trueCost =
      transferPrice && costToSell
        ? transferPrice.plus(costToSell).plus(returnAllowance ?? dec(0))
        : null;

    const suggestedPrice =
      trueCost && targetMargin.lessThan(1) ? priceFromMargin(trueCost, targetMargin) : null;
    const floor =
      trueCost && minimumMargin.lessThan(1) ? floorPrice(trueCost, minimumMargin) : null;

    return {
      styleId: style.id,
      code: style.code,
      nameAr: style.nameAr,
      nameEn: style.nameEn,
      imageName: style.imageName,

      transferPrice,
      costToSell,
      returnAllowance,
      trueCost,

      retailPrice,
      actualMargin: retailPrice && trueCost ? marginOf(retailPrice, trueCost) : null,
      grossMargin: retailPrice && transferPrice ? marginOf(retailPrice, transferPrice) : null,
      actualMarkup: retailPrice && trueCost ? markupOf(retailPrice, trueCost) : null,

      suggestedPrice,
      targetMargin,
      shortfall: suggestedPrice && retailPrice ? suggestedPrice.minus(retailPrice) : null,

      floor,
      minimumMargin,
      discountRoom:
        retailPrice && trueCost ? maximumDiscount(retailPrice, trueCost, minimumMargin) : null,
      // Null once the garment already loses money: there is no discount that
      // wipes out a profit that is not there, and a negative percentage on the
      // screen reads as though there were still room.
      wipeoutDiscount:
        retailPrice && trueCost && retailPrice.greaterThan(trueCost)
          ? breakEvenDiscount(retailPrice, trueCost)
          : null,

      losesMoney: Boolean(retailPrice && trueCost && retailPrice.lessThan(trueCost)),
      stale: !snapshot,
    };
  });

  // The volume assumption is doing more work than the garment when absorbed
  // overhead outweighs the median transfer price. Median, not average, so one
  // uncosted style cannot hide it.
  const costs = rows
    .map((r) => r.transferPrice)
    .filter((p): p is Decimal => p != null)
    .sort((a, b) => Number(a.minus(b)));
  const medianCost = costs.length ? costs[Math.floor(costs.length / 2)] : null;

  // Whatever is losing money first, then whatever is furthest below target.
  return {
    basis: {
      ...basis,
      overheadDominates: Boolean(
        medianCost && basis.overheadPerUnit?.greaterThan(medianCost),
      ),
    },
    styles: rows.sort((a, b) => {
      if (a.losesMoney !== b.losesMoney) return a.losesMoney ? -1 : 1;
      return Number((b.shortfall ?? dec(0)).minus(a.shortfall ?? dec(0)));
    }),
  };
}

/**
 * One garment, opened up, with the discount ladder against it.
 *
 * The ladder is against the true cost rather than the transfer price. A
 * discount measured against cost of goods alone looks survivable long after it
 * has stopped being so, which is exactly the mistake it exists to prevent.
 */
export async function priceStyle(
  entityId: string,
  styleId: string,
  options: { monthsBack?: number; overrides?: PricingOverrides } = {},
) {
  const { basis, styles } = await brandPriceList(entityId, options);
  const style = styles.find((s) => s.styleId === styleId);
  if (!style) throw new BrandPricingError("That style is not priced by the brand.");

  const ladder =
    style.retailPrice && style.trueCost
      ? discountLadder(style.retailPrice, style.trueCost)
      : [];

  return { basis, style, ladder };
}

/**
 * What the shop is charging against what it should be.
 *
 * One line for the dashboard: how many garments are priced below the floor,
 * and what the mispricing is worth across a month of the shop's own volume.
 */
export async function pricingGap(entityId: string, options: { monthsBack?: number } = {}) {
  const { basis, styles } = await brandPriceList(entityId, options);

  const priced = styles.filter((s) => s.shortfall != null);
  const short = priced.filter((s) => (s.shortfall ?? dec(0)).greaterThan(0));
  const losing = styles.filter((s) => s.losesMoney);
  const unpriceable = styles.filter((s) => s.stale);

  // The average shortfall across a month's units. Not a forecast — an
  // indication of what the gap is worth at the volume already being done.
  const averageShortfall = short.length
    ? short.reduce((t, s) => t.plus(s.shortfall ?? dec(0)), dec(0)).div(short.length)
    : dec(0);

  return {
    basis,
    total: styles.length,
    belowTarget: short.length,
    losingMoney: losing.length,
    unpriceable: unpriceable.length,
    averageShortfall,
    monthlyValue: averageShortfall.times(basis.monthlyUnits),
    worst: short[0] ?? null,
  };
}
