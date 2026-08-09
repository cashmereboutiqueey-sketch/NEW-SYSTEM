import { describe, it, expect } from "vitest";
import { simulate, compare, type Baseline } from "./scenario";
import { dec } from "@/lib/money";

/**
 * The simulator has to agree with the rest of the system, or it is a second
 * set of books that happens to be prettier. These tests pin the arithmetic to
 * the same relationships the ledger enforces.
 */

const baseline: Baseline = {
  conversionCost: 568_000,
  materialCost: 1_200_000,
  grossAvailableMinutes: 499_200,
  utilisationRate: 0.6,
  efficiencyRate: 0.8,
  smvPerUnit: 33,
  unitsSold: 2_000,
  retailPrice: 1_650,
  discountRate: 0.1,
  returnRate: 0.08,
  factoryMarginPct: 0.18,
  brandFixedCosts: 180_000,
  marketingSpend: 120_000,
  variableSellingCostPerUnit: 57,
};

describe("the measured month reproduces itself", () => {
  it("gives back the documented minute rate when nothing is changed", () => {
    const out = simulate(baseline);

    // 568,000 / (499,200 × 0.6 × 0.8 = 239,616)
    expect(Number(out.minuteRate)).toBeCloseTo(2.3705, 4);
    expect(Number(out.fullCapacityMinuteRate)).toBeCloseTo(1.1378, 4);
    expect(Number(out.idlePenaltyPerMinute)).toBeCloseTo(1.2326, 4);
  });

  it("carries the idle penalty into the garment", () => {
    const out = simulate(baseline);
    // 1.2326 × 33 minutes
    expect(Number(out.idlePenaltyPerMinute) * 33).toBeCloseTo(40.68, 1);
  });

  it("builds the transfer price from cost and margin, not the other way round", () => {
    const out = simulate(baseline);
    expect(Number(out.transferPrice)).toBeCloseTo(
      Number(out.factoryCostPerUnit) * 1.18,
      6,
    );
  });
});

describe("group profit adds up", () => {
  it("equals the two entities added together", () => {
    const out = simulate(baseline);
    expect(Number(out.groupProfit)).toBeCloseTo(
      Number(out.brandProfit) + Number(out.factoryProfit),
      6,
    );
  });

  it("equals external revenue less real cost less brand overhead", () => {
    const out = simulate(baseline);

    // Derived independently of the simulator: what the group actually earned.
    const fromFirstPrinciples =
      (Number(out.effectiveRevenue) -
        Number(out.factoryCostPerUnit) -
        Number(baseline.variableSellingCostPerUnit)) *
        Number(out.unitsSold) -
      Number(baseline.brandFixedCosts) -
      Number(baseline.marketingSpend);

    expect(Number(out.groupProfit)).toBeCloseTo(fromFirstPrinciples, 4);
  });

  it("does not count the transfer margin twice", () => {
    const out = simulate(baseline);
    // The margin the group charged itself is inside factoryProfit and is
    // subtracted again inside brandProfit through the transfer price.
    const transferMargin =
      (Number(out.transferPrice) - Number(out.factoryCostPerUnit)) * Number(out.unitsSold);
    expect(Number(out.factoryProfit)).toBeCloseTo(transferMargin, 4);
    expect(Number(out.groupProfit)).not.toBeCloseTo(
      Number(out.brandProfit) + 2 * transferMargin,
      2,
    );
  });
});

describe("each lever moves what it should", () => {
  it("filling the factory lowers the minute rate and the garment cost", () => {
    const before = simulate(baseline);
    const after = simulate(baseline, { utilisationRate: 0.9 });

    expect(Number(after.minuteRate)).toBeLessThan(Number(before.minuteRate));
    expect(Number(after.factoryCostPerUnit)).toBeLessThan(Number(before.factoryCostPerUnit));
    // And the idle penalty shrinks, which is the point of filling it.
    expect(Number(after.idlePenaltyPerMinute)).toBeLessThan(
      Number(before.idlePenaltyPerMinute),
    );
  });

  it("full capacity leaves no idle penalty at all", () => {
    const out = simulate(baseline, { utilisationRate: 1, efficiencyRate: 1 });
    expect(Number(out.idlePenaltyPerMinute)).toBeCloseTo(0, 8);
    expect(Number(out.minuteRate)).toBeCloseTo(Number(out.fullCapacityMinuteRate), 8);
  });

  it("dearer cloth raises the garment but not the minute rate", () => {
    const before = simulate(baseline);
    const after = simulate(baseline, { fabricPriceDeltaPct: 0.1 });

    expect(Number(after.materialCostPerUnit)).toBeCloseTo(
      Number(before.materialCostPerUnit) * 1.1,
      6,
    );
    // Cloth is not a conversion cost, so the rate is untouched.
    expect(Number(after.minuteRate)).toBeCloseTo(Number(before.minuteRate), 8);
  });

  it("a wage rise moves the minute rate but not the cloth", () => {
    const before = simulate(baseline);
    const after = simulate(baseline, { wageDeltaPct: 0.15 });

    expect(Number(after.minuteRate)).toBeCloseTo(Number(before.minuteRate) * 1.15, 6);
    expect(Number(after.materialCostPerUnit)).toBeCloseTo(
      Number(before.materialCostPerUnit),
      8,
    );
  });

  it("selling more does not make cloth cheaper per garment", () => {
    const before = simulate(baseline);
    const after = simulate(baseline, { unitsSoldDeltaPct: 0.5 });

    // A volume change is not a purchasing win. Only the fabric price is.
    expect(Number(after.materialCostPerUnit)).toBeCloseTo(
      Number(before.materialCostPerUnit),
      8,
    );
    expect(Number(after.unitsSold)).toBeCloseTo(3_000, 6);
  });

  it("deeper discounting cuts contribution", () => {
    const before = simulate(baseline);
    const after = simulate(baseline, { discountRate: 0.3 });

    expect(Number(after.contributionPerUnit)).toBeLessThan(
      Number(before.contributionPerUnit),
    );
    expect(Number(after.brandProfit)).toBeLessThan(Number(before.brandProfit));
  });

  it("more returns cut revenue without cutting the cost of making them", () => {
    const before = simulate(baseline);
    const after = simulate(baseline, { returnRate: 0.25 });

    expect(Number(after.effectiveRevenue)).toBeLessThan(Number(before.effectiveRevenue));
    expect(Number(after.factoryCostPerUnit)).toBeCloseTo(
      Number(before.factoryCostPerUnit),
      8,
    );
  });
});

describe("the awkward cases", () => {
  it("reports no break-even rather than an enormous one", () => {
    // Priced below what it costs to put in a bag.
    const out = simulate({ ...baseline, retailPrice: 300 });
    expect(Number(out.contributionPerUnit)).toBeLessThan(0);
    expect(out.breakEvenUnits).toBeNull();
  });

  it("does not divide by an empty factory", () => {
    const out = simulate({ ...baseline, utilisationRate: 0, efficiencyRate: 0 });
    expect(Number(out.minuteRate)).toBe(0);
    expect(Number.isFinite(Number(out.minuteRate))).toBe(true);
  });

  it("does not divide by a month that sold nothing", () => {
    const out = simulate({ ...baseline, unitsSold: 0 });
    expect(Number(out.materialCostPerUnit)).toBe(0);
    expect(Number.isFinite(Number(out.factoryCostPerUnit))).toBe(true);
  });
});

describe("comparing a run with its baseline", () => {
  it("reports a delta for every metric", () => {
    const before = simulate(baseline);
    const after = simulate(baseline, { fabricPriceDeltaPct: 0.1 });
    const rows = compare(before, after);

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Number(row.delta)).toBeCloseTo(
        Number(row.simulated) - Number(row.baseline),
        6,
      );
    }
  });

  it("gives no percentage when the baseline was zero", () => {
    const before = simulate({ ...baseline, unitsSold: 0 });
    const after = simulate({ ...baseline, unitsSold: 0 }, { fabricPriceDeltaPct: 0.1 });
    const rows = compare(before, after);

    const units = rows.find((r) => r.metricKey === "unitsSold");
    expect(units?.deltaPct).toBeNull();
  });

  it("is unchanged when nothing is assumed", () => {
    const out = simulate(baseline);
    const rows = compare(out, simulate(baseline));
    for (const row of rows) expect(Number(row.delta)).toBeCloseTo(0, 8);
  });
});
