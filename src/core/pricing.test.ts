import { describe, it, expect } from "vitest";
import {
  markupToMargin, marginToMarkup, priceFromMarkup, priceFromMargin,
  marginOf, markupOf, afterDiscount, breakEvenDiscount, floorPrice,
  maximumDiscount, discountLadder,
} from "./pricing";

/**
 * Markup and margin are the same profit over two different denominators, and
 * confusing them overstates every profit figure in the business.
 */

describe("markup is not margin", () => {
  it("turns a 25% markup into a 20% margin", () => {
    // 600 → 750. Profit 150. Over cost that is 25%; over price it is 20%.
    expect(Number(markupToMargin(0.25))).toBeCloseTo(0.2, 10);
  });

  it("turns a 20% margin back into a 25% markup", () => {
    expect(Number(marginToMarkup(0.2))).toBeCloseTo(0.25, 10);
  });

  it("round-trips at any rate", () => {
    for (const markup of [0.05, 0.18, 0.25, 0.5, 1, 3]) {
      expect(Number(marginToMarkup(markupToMargin(markup)))).toBeCloseTo(markup, 10);
    }
  });

  it("shows how far apart they get", () => {
    // The gap widens with the rate, which is why quoting the markup as the
    // margin flatters the fat products most.
    expect(Number(markupToMargin(1))).toBeCloseTo(0.5, 10); // 100% markup, 50% margin
    expect(Number(markupToMargin(3))).toBeCloseTo(0.75, 10); // 300% markup, 75% margin
  });

  it("agrees with itself: they are the same money", () => {
    const price = priceFromMarkup(600, 0.25);
    expect(Number(price)).toBe(750);
    expect(Number(priceFromMargin(600, 0.2))).toBeCloseTo(750, 10);
    expect(Number(marginOf(750, 600))).toBeCloseTo(0.2, 10);
    expect(Number(markupOf(750, 600))).toBeCloseTo(0.25, 10);
  });

  it("refuses a margin of 100% or more instead of returning a huge markup", () => {
    // Profit cannot be the whole of a price that still has a cost in it.
    expect(() => marginToMarkup(1)).toThrow(RangeError);
    expect(() => priceFromMargin(600, 1.2)).toThrow(RangeError);
  });

  it("reports no margin on a free garment rather than zero", () => {
    // Zero would read as "we broke even", which is a different claim.
    expect(marginOf(0, 600)).toBeNull();
    expect(markupOf(750, 0)).toBeNull();
  });
});

describe("what a discount really costs", () => {
  // A garment bought at 750 and priced at 1200: a 37.5% margin.
  const PRICE = 1200;
  const COST = 750;

  it("takes more of the profit than it takes of the price", () => {
    const at = afterDiscount(PRICE, COST, 0.2);

    expect(Number(at.price)).toBe(960);
    expect(Number(at.profit)).toBe(210); // was 450
    // A fifth off the price is over half the profit. This is the whole point.
    expect(Number(at.profitGivenUp)).toBeCloseTo(0.5333, 4);
  });

  it("is harmless at zero", () => {
    const at = afterDiscount(PRICE, COST, 0);
    expect(Number(at.profit)).toBe(450);
    expect(Number(at.profitGivenUp)).toBe(0);
  });

  it("wipes the profit out at exactly the margin", () => {
    // The break-even discount is the margin itself: the price has fallen to
    // the cost.
    const wipeout = breakEvenDiscount(PRICE, COST)!;
    expect(Number(wipeout)).toBeCloseTo(0.375, 10);

    const at = afterDiscount(PRICE, COST, wipeout);
    expect(Number(at.profit)).toBeCloseTo(0, 8);
    expect(Number(at.price)).toBeCloseTo(COST, 8);
  });

  it("goes past the profit into the cost", () => {
    const at = afterDiscount(PRICE, COST, 0.5);
    expect(Number(at.profit)).toBe(-150); // paying people to take it away
    expect(Number(at.margin)).toBeLessThan(0);
  });

  it("reports no proportion given up when there was no profit to give", () => {
    // Priced at 700 against a 750 cost: already losing 50. Dividing by that
    // negative base would report a *negative* share given up, reading as
    // though discounting had helped.
    const at = afterDiscount(700, 750, 0.2);

    expect(Number(at.profit)).toBe(-190);
    expect(at.profitGivenUp).toBeNull();
  });

  it("bites harder the thinner the margin", () => {
    // Same 10% off. On a fat margin it costs a quarter of the profit; on a
    // thin one it costs three-quarters.
    const fat = afterDiscount(1000, 500, 0.1); // 50% margin
    const thin = afterDiscount(1000, 870, 0.1); // 13% margin

    expect(Number(fat.profitGivenUp)).toBeCloseTo(0.2, 4);
    expect(Number(thin.profitGivenUp)).toBeCloseTo(0.7692, 4);
  });
});

describe("the number a salesperson can refuse to go under", () => {
  it("prices the floor from the margin the owner will accept", () => {
    // 750 cost, never below a 20% margin → 937.50.
    expect(Number(floorPrice(750, 0.2))).toBeCloseTo(937.5, 6);
  });

  it("turns that floor into a discount they can be given", () => {
    const room = maximumDiscount(1200, 750, 0.2);
    expect(Number(room)).toBeCloseTo(0.21875, 6);

    // Taking exactly that much lands on the floor, not through it.
    const at = afterDiscount(1200, 750, room);
    expect(Number(at.margin)).toBeCloseTo(0.2, 8);
  });

  it("gives away nothing when the price is already at the floor", () => {
    expect(Number(maximumDiscount(937.5, 750, 0.2))).toBeCloseTo(0, 8);
    // And refuses to go negative when it is already below.
    expect(Number(maximumDiscount(800, 750, 0.2))).toBe(0);
  });
});

describe("the ladder", () => {
  const ladder = discountLadder(1200, 750);

  it("starts at the full price", () => {
    expect(Number(ladder[0].discount)).toBe(0);
    expect(Number(ladder[0].price)).toBe(1200);
    expect(Number(ladder[0].profit)).toBe(450);
    expect(ladder[0].belowCost).toBe(false);
  });

  it("marks the rungs that sell at a loss", () => {
    // 37.5% is break-even, so 40% and 50% are losses.
    const losing = ladder.filter((r) => r.belowCost).map((r) => Number(r.discount));
    expect(losing).toEqual([0.4, 0.5]);
  });

  it("loses profit faster than it loses price at every rung", () => {
    for (const rung of ladder.slice(1)) {
      expect(Number(rung.profitGivenUp)).toBeGreaterThan(Number(rung.discount));
    }
  });
});
