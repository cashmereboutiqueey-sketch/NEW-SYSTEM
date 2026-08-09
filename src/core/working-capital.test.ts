import { describe, it, expect } from "vitest";
import {
  cashConversionCycle,
  contribution,
  breakEven,
  gmroi,
  sellThrough,
  type UnitEconomics,
} from "./working-capital";

describe("cash conversion cycle", () => {
  const inputs = {
    rawMaterialDays: 30,
    productionLeadDays: 21,
    finishedGoodsDays: 45,
    collectionDays: 14,
    supplierCreditDays: 40,
  };

  it("sums the cycle and subtracts supplier credit", () => {
    // 30 + 21 + 45 + 14 − 40
    const r = cashConversionCycle(inputs, 600000);
    expect(r.cashConversionDays.toString()).toBe("70");
  });

  it("converts days into capital actually locked", () => {
    // 70 days at 20,000 a day of cost.
    const r = cashConversionCycle(inputs, 600000);
    expect(r.workingCapitalLocked.toString()).toBe("1400000");
  });

  it("includes fabric waiting to be cut", () => {
    // Raw-material days are in by explicit decision: fabric in the store is
    // locked capital, and it is what supplier credit is meant to cover.
    const withFabric = cashConversionCycle(inputs, 600000);
    const without = cashConversionCycle({ ...inputs, rawMaterialDays: 0 }, 600000);
    expect(withFabric.cashConversionDays.minus(without.cashConversionDays).toString()).toBe("30");
  });

  it("shows how much of the cycle suppliers are funding", () => {
    const r = cashConversionCycle(inputs, 600000);
    expect(r.supplierFunded.toString()).toBe("800000");
  });

  it("reports no locked capital when suppliers fund the whole cycle", () => {
    // A negative cycle means the business is financed by its suppliers.
    const r = cashConversionCycle({ ...inputs, supplierCreditDays: 150 }, 600000);
    expect(r.cashConversionDays.isNegative()).toBe(true);
    expect(r.workingCapitalLocked.toString()).toBe("0");
  });

  it("locks more capital as the business grows", () => {
    const small = cashConversionCycle(inputs, 300000);
    const large = cashConversionCycle(inputs, 900000);
    // A positive cycle means every unit of growth consumes cash.
    expect(large.workingCapitalLocked.greaterThan(small.workingCapitalLocked)).toBe(true);
  });
});

describe("contribution", () => {
  const unit: UnitEconomics = {
    retailPrice: "1500",
    discountRate: "0.15",
    returnRate: "0.10",
    transferPrice: "700",
    packaging: "25",
    shipping: "60",
    paymentFee: "30",
    marketingPerUnit: "120",
    returnHandlingCost: "15",
  };

  it("nets discount then returns off the retail price", () => {
    const c = contribution(unit);
    expect(c.netPrice.toString()).toBe("1275");
    expect(c.effectiveRevenue.toString()).toBe("1147.5");
  });

  it("sums every variable cost including marketing", () => {
    const c = contribution(unit);
    expect(c.variableCost.toString()).toBe("950");
  });

  it("reports contribution and its percentage", () => {
    const c = contribution(unit);
    expect(c.contributionMargin.toString()).toBe("197.5");
    expect(c.contributionMarginPct!.toFixed(4)).toBe("0.1721");
  });

  it("can report a negative contribution", () => {
    // Heavy discounting genuinely can cost more than it earns, and saying so
    // plainly is the point.
    const c = contribution({ ...unit, discountRate: "0.5" });
    expect(c.contributionMargin.isNegative()).toBe(true);
  });

  it("adds only brand-side costs on top of the transfer price", () => {
    // Factory overhead is already absorbed into transfer price, so the 250 of
    // brand cost here is packaging, shipping, fees, marketing and returns —
    // nothing that belongs to the factory appears twice.
    const c = contribution(unit);
    expect(c.variableCost.minus(700).toString()).toBe("250");
  });
});

describe("break-even", () => {
  it("reports units and share of the run", () => {
    // 60,000 of brand fixed costs over 197.50 contribution.
    const b = breakEven("197.5", 60000, 500);
    expect(b.achievable).toBe(true);
    if (b.achievable) {
      expect(b.units.toFixed(0)).toBe("304");
      expect(b.shareOfRun!.toFixed(4)).toBe("0.6076");
    }
  });

  it("flags a run that must sell most of itself just to break even", () => {
    const b = breakEven("197.5", 60000, 500);
    if (b.achievable) expect(b.highRisk).toBe(true);
  });

  it("does not flag a comfortable run", () => {
    const b = breakEven("197.5", 60000, 2000);
    if (b.achievable) {
      expect(b.shareOfRun!.lessThan("0.2")).toBe(true);
      expect(b.highRisk).toBe(false);
    }
  });

  it("says a style never breaks even rather than printing a huge number", () => {
    // Printing 8,000,000 units invites someone to read the target as merely
    // ambitious rather than impossible.
    const b = breakEven("-50", 60000, 500);
    expect(b.achievable).toBe(false);
    if (!b.achievable) expect(b.reason).toBe("NO_CONTRIBUTION");
  });

  it("treats exactly zero contribution as never breaking even", () => {
    expect(breakEven("0", 60000, 500).achievable).toBe(false);
  });

  it("works without a run size, reporting units only", () => {
    const b = breakEven("200", 50000);
    expect(b.achievable).toBe(true);
    if (b.achievable) {
      expect(b.units.toString()).toBe("250");
      expect(b.shareOfRun).toBeNull();
      expect(b.highRisk).toBe(false);
    }
  });
});

describe("inventory return", () => {
  it("reports what each pound of stock earns", () => {
    expect(gmroi(450000, 300000)!.toString()).toBe("1.5");
  });

  it("reports nothing when there is no inventory", () => {
    expect(gmroi(450000, 0)).toBeNull();
  });

  it("computes sell-through as a share of the run", () => {
    expect(sellThrough(400, 1000)!.toString()).toBe("0.4");
  });

  it("reports nothing when nothing was produced", () => {
    expect(sellThrough(0, 0)).toBeNull();
  });
});
