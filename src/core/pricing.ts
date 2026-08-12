import { Decimal, dec, type Numeric } from "@/lib/money";

/**
 * Markup and margin, and why the difference is not pedantry.
 *
 * They are the same profit over two different denominators:
 *
 *   markup = profit ÷ cost          — what you add when you set the price
 *   margin = profit ÷ selling price — what you report when you count the money
 *
 * A garment costing 600 sold at 750 carries a 25% markup and a 20% margin. The
 * same 150. Quote the markup as though it were the margin and every profit
 * figure in the business is overstated, by more the fatter the margin gets: a
 * 100% markup is a 50% margin, and a 300% markup is a 75% one.
 *
 * The house sets prices by markup — cost is the number you know first. The
 * accounts report margin, because a percentage of revenue is the only one that
 * adds up across a P&L. Both are correct; naming one after the other is not.
 *
 * Everything here is a fraction, never a percentage: 0.25 is twenty-five per
 * cent, matching how rates are stored everywhere else in the system.
 */

/** 25% markup is a 20% margin: 0.25 ÷ 1.25. */
export function markupToMargin(markup: Numeric): Decimal {
  const m = dec(markup);
  return m.div(m.plus(1));
}

/**
 * 20% margin needs a 25% markup: 0.2 ÷ 0.8.
 *
 * A margin of 100% or more is not reachable at any markup — profit cannot be
 * the whole of a price that still has a cost inside it — so it is refused
 * rather than returned as a very large number.
 */
export function marginToMarkup(margin: Numeric): Decimal {
  const m = dec(margin);
  if (m.greaterThanOrEqualTo(1)) {
    throw new RangeError("A margin of 100% or more is not reachable: profit cannot exceed the price.");
  }
  return m.div(dec(1).minus(m));
}

/** Price by adding to cost. This is what the factory does. */
export function priceFromMarkup(cost: Numeric, markup: Numeric): Decimal {
  return dec(cost).times(dec(markup).plus(1));
}

/** Price by leaving room in the price. This is what a brand does. */
export function priceFromMargin(cost: Numeric, margin: Numeric): Decimal {
  const m = dec(margin);
  if (m.greaterThanOrEqualTo(1)) {
    throw new RangeError("A margin of 100% or more is not reachable: profit cannot exceed the price.");
  }
  return dec(cost).div(dec(1).minus(m));
}

/** The margin actually earned on a price that was arrived at some other way. */
export function marginOf(price: Numeric, cost: Numeric): Decimal | null {
  const p = dec(price);
  if (p.isZero()) return null; // a margin on nothing is not zero, it is nothing
  return p.minus(dec(cost)).div(p);
}

/** The markup actually taken. */
export function markupOf(price: Numeric, cost: Numeric): Decimal | null {
  const c = dec(cost);
  if (c.isZero()) return null;
  return dec(price).minus(c).div(c);
}

/**
 * What a discount actually does to the profit.
 *
 * The relationship is not proportional and this is the single most expensive
 * thing for a salesperson not to know. On a 37.5% margin, a 20% discount does
 * not cost a fifth of the profit — it costs 53% of it, because the whole
 * discount comes out of the margin and none of it out of the cost.
 */
export function afterDiscount(
  price: Numeric,
  cost: Numeric,
  discount: Numeric,
): {
  price: Decimal;
  profit: Decimal;
  margin: Decimal | null;
  /** The share of the original profit given away. 0.53 means half of it. */
  profitGivenUp: Decimal | null;
} {
  const full = dec(price);
  const c = dec(cost);
  const discounted = full.times(dec(1).minus(dec(discount)));
  const profit = discounted.minus(c);
  const fullProfit = full.minus(c);

  return {
    price: discounted,
    profit,
    margin: marginOf(discounted, c),
    profitGivenUp: fullProfit.isZero() ? null : fullProfit.minus(profit).div(fullProfit),
  };
}

/**
 * The discount at which the garment stops earning anything.
 *
 * It is exactly the margin: a 37.5% margin is wiped out by a 37.5% discount,
 * because at that point the price has fallen to the cost. Past it the shop is
 * paying people to take the stock away.
 */
export function breakEvenDiscount(price: Numeric, cost: Numeric): Decimal | null {
  return marginOf(price, cost);
}

/**
 * The lowest price that still leaves a stated margin.
 *
 * What a salesperson needs at the counter is not a percentage, it is a number
 * they can refuse to go under.
 */
export function floorPrice(cost: Numeric, minimumMargin: Numeric): Decimal {
  return priceFromMargin(cost, minimumMargin);
}

/** The biggest discount off `price` that still clears `minimumMargin`. */
export function maximumDiscount(
  price: Numeric,
  cost: Numeric,
  minimumMargin: Numeric,
): Decimal {
  const p = dec(price);
  if (p.isZero()) return dec(0);
  const floor = floorPrice(cost, minimumMargin);
  const room = p.minus(floor).div(p);
  // Already at or below the floor: there is nothing to give away.
  return room.lessThan(0) ? dec(0) : room;
}

/**
 * A discount ladder, for showing rather than explaining.
 *
 * Every argument about "it's only ten per cent" ends when the second column is
 * on the screen next to the first.
 */
export const DISCOUNT_LADDER = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5] as const;

export function discountLadder(price: Numeric, cost: Numeric, steps: readonly number[] = DISCOUNT_LADDER) {
  return steps.map((discount) => {
    const at = afterDiscount(price, cost, discount);
    return {
      discount: dec(discount),
      price: at.price,
      profit: at.profit,
      margin: at.margin,
      profitGivenUp: at.profitGivenUp,
      /** Below this the garment is sold at a loss, not at a thin profit. */
      belowCost: at.profit.lessThan(0),
    };
  });
}
