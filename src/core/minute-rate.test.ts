import { describe, it, expect } from "vitest";
import {
  calculateMinuteRate,
  idlePenaltyPerUnit,
  isQuoteAboveFloor,
  type CapacityInputs,
} from "./minute-rate";

/**
 * The worked example from the README and the cost engine spec:
 *
 *   40 operators × 26 days × 8 hours          = 499,200 gross minutes
 *   utilisation 60% × efficiency 80%          = 239,616 productive minutes
 *   cost pool EGP 568,000
 *   actual rate        568,000 / 239,616      = 2.3705 EGP/min
 *   full capacity rate 568,000 / 499,200      = 1.1378 EGP/min
 *   idle penalty                               = 1.2326 EGP/min
 *   on a 33-minute style                       = EGP 40.68 of pure idleness
 */
const SEEDED: CapacityInputs = {
  operators: 40,
  workingDays: 26,
  hoursPerDay: 8,
  utilisationRate: "0.60",
  efficiencyRate: "0.80",
};

describe("the seeded worked example", () => {
  const result = calculateMinuteRate(SEEDED, { grossCostPool: "568000" });

  it("derives gross available minutes", () => {
    expect(result.grossAvailableMinutes.toString()).toBe("499200");
  });

  it("derives productive minutes from utilisation and efficiency", () => {
    expect(result.productiveMinutes.toString()).toBe("239616");
  });

  it("reports idle minutes as the gap", () => {
    expect(result.idleMinutes.toString()).toBe("259584");
  });

  it("matches the documented actual minute rate", () => {
    expect(result.actualMinuteRate!.toFixed(4)).toBe("2.3705");
  });

  it("matches the documented full-capacity floor", () => {
    expect(result.fullCapacityMinuteRate!.toFixed(4)).toBe("1.1378");
  });

  it("matches the documented idle penalty per minute", () => {
    expect(result.idlePenaltyPerMinute!.toFixed(4)).toBe("1.2326");
  });

  it("converts idle capacity into EGP on a 33-minute garment", () => {
    const perUnit = idlePenaltyPerUnit(result.idlePenaltyPerMinute, 33);
    expect(perUnit!.toFixed(2)).toBe("40.68");
  });
});

describe("utilisation and efficiency are distinct levers", () => {
  it("raises the rate when utilisation falls, leaving the floor untouched", () => {
    // A sales problem: the factory could make more but nobody ordered it.
    const busy = calculateMinuteRate(
      { ...SEEDED, utilisationRate: "0.90" },
      { grossCostPool: "568000" },
    );
    const idle = calculateMinuteRate(
      { ...SEEDED, utilisationRate: "0.40" },
      { grossCostPool: "568000" },
    );

    expect(idle.actualMinuteRate!.greaterThan(busy.actualMinuteRate!)).toBe(true);
    // The floor depends only on capacity and cost, so it does not move.
    expect(idle.fullCapacityMinuteRate!.toFixed(4)).toBe(
      busy.fullCapacityMinuteRate!.toFixed(4),
    );
  });

  it("raises the rate when efficiency falls, leaving the floor untouched", () => {
    // A shop-floor problem: the work was there, the line was slow.
    const good = calculateMinuteRate(
      { ...SEEDED, efficiencyRate: "0.95" },
      { grossCostPool: "568000" },
    );
    const poor = calculateMinuteRate(
      { ...SEEDED, efficiencyRate: "0.55" },
      { grossCostPool: "568000" },
    );

    expect(poor.actualMinuteRate!.greaterThan(good.actualMinuteRate!)).toBe(true);
    expect(poor.fullCapacityMinuteRate!.toFixed(4)).toBe(
      good.fullCapacityMinuteRate!.toFixed(4),
    );
  });

  it("treats the two as independent multipliers, not one blended factor", () => {
    // 0.6 × 0.8 and 0.8 × 0.6 give the same productive minutes, which is why
    // the rate alone cannot tell you which disease you have — the stored
    // inputs must be kept separately, and they are.
    const a = calculateMinuteRate(
      { ...SEEDED, utilisationRate: "0.60", efficiencyRate: "0.80" },
      { grossCostPool: "568000" },
    );
    const b = calculateMinuteRate(
      { ...SEEDED, utilisationRate: "0.80", efficiencyRate: "0.60" },
      { grossCostPool: "568000" },
    );
    expect(a.productiveMinutes.toString()).toBe(b.productiveMinutes.toString());
  });
});

describe("CMT revenue credit", () => {
  it("lowers the net pool and therefore the rate the brand pays", () => {
    const without = calculateMinuteRate(SEEDED, { grossCostPool: "568000" });
    const with100k = calculateMinuteRate(SEEDED, {
      grossCostPool: "568000",
      cmtRevenueCredit: "100000",
    });

    expect(with100k.netCostPool.toString()).toBe("468000");
    expect(with100k.actualMinuteRate!.lessThan(without.actualMinuteRate!)).toBe(true);
  });

  it("keeps the gross pool and the credit visible for the drill-down", () => {
    const result = calculateMinuteRate(SEEDED, {
      grossCostPool: "568000",
      cmtRevenueCredit: "100000",
    });
    expect(result.grossCostPool.toString()).toBe("568000");
    expect(result.cmtRevenueCredit.toString()).toBe("100000");
    expect(result.netCostPool.toString()).toBe("468000");
  });

  it("lowers the full-capacity floor too, since the floor is pool-based", () => {
    const without = calculateMinuteRate(SEEDED, { grossCostPool: "568000" });
    const credited = calculateMinuteRate(SEEDED, {
      grossCostPool: "568000",
      cmtRevenueCredit: "100000",
    });
    expect(
      credited.fullCapacityMinuteRate!.lessThan(without.fullCapacityMinuteRate!),
    ).toBe(true);
  });
});

describe("degenerate inputs", () => {
  it("reports no rate rather than Infinity when nothing is productive", () => {
    // A shut month. Infinity here would surface as an absurd garment cost.
    const result = calculateMinuteRate(
      { ...SEEDED, utilisationRate: "0" },
      { grossCostPool: "568000" },
    );
    expect(result.productiveMinutes.toString()).toBe("0");
    expect(result.actualMinuteRate).toBeNull();
    expect(result.idlePenaltyPerMinute).toBeNull();
  });

  it("reports no rate when there are no operators", () => {
    const result = calculateMinuteRate(
      { ...SEEDED, operators: 0 },
      { grossCostPool: "568000" },
    );
    expect(result.actualMinuteRate).toBeNull();
    expect(result.fullCapacityMinuteRate).toBeNull();
  });

  it("gives no idle penalty at full utilisation and efficiency", () => {
    const result = calculateMinuteRate(
      { ...SEEDED, utilisationRate: "1", efficiencyRate: "1" },
      { grossCostPool: "568000" },
    );
    expect(result.idlePenaltyPerMinute!.toString()).toBe("0");
    expect(result.idleMinutes.toString()).toBe("0");
  });

  it("handles a zero cost pool without dividing by zero", () => {
    const result = calculateMinuteRate(SEEDED, { grossCostPool: "0" });
    expect(result.actualMinuteRate!.toString()).toBe("0");
  });

  it("keeps full precision rather than rounding mid-chain", () => {
    const result = calculateMinuteRate(SEEDED, { grossCostPool: "568000" });
    // Rounded to 4dp this is 2.3705; the stored value carries more, so a long
    // costing chain does not drift.
    expect(result.actualMinuteRate!.toString()).not.toBe("2.3705");
    expect(result.actualMinuteRate!.toFixed(4)).toBe("2.3705");
  });
});

describe("external CMT quote floor", () => {
  const { fullCapacityMinuteRate } = calculateMinuteRate(SEEDED, {
    grossCostPool: "568000",
  });

  it("accepts a quote at or above the full-capacity rate", () => {
    expect(isQuoteAboveFloor("1.50", fullCapacityMinuteRate)).toBe(true);
    expect(isQuoteAboveFloor(fullCapacityMinuteRate!, fullCapacityMinuteRate)).toBe(true);
  });

  it("rejects a quote below the floor even though it beats variable cost", () => {
    expect(isQuoteAboveFloor("0.90", fullCapacityMinuteRate)).toBe(false);
  });

  it("rejects everything when no floor can be computed", () => {
    // Without a rate there is no basis to approve a quote, so refuse rather
    // than wave it through.
    expect(isQuoteAboveFloor("5.00", null)).toBe(false);
  });
});
