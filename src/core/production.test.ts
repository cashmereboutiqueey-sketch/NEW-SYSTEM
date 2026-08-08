import { describe, it, expect } from "vitest";
import {
  explodeBom,
  variance,
  actualWasteRate,
  wasteDriftExceeded,
  orderYield,
  lineEfficiency,
  earnedMinutes,
} from "./production";

const bom = [
  { materialId: "m1", materialCode: "FAB-JER-180", standardConsumption: "1.5" },
  { materialId: "m2", materialCode: "TRM-BTN-18", standardConsumption: "5" },
];

describe("BOM explosion", () => {
  it("scales the whole run and includes waste", () => {
    const req = explodeBom(bom, 200, "0.08");
    // 1.5 × 1.08 × 200
    expect(req[0].requiredQty.toString()).toBe("324");
    expect(req[1].requiredQty.toString()).toBe("1080");
  });

  it("plans with waste rather than the theoretical minimum", () => {
    // Planning the waste-free quantity guarantees running short mid-cut.
    const withWaste = explodeBom(bom, 100, "0.08")[0].requiredQty;
    const withoutWaste = explodeBom(bom, 100, "0")[0].requiredQty;
    expect(withWaste.greaterThan(withoutWaste)).toBe(true);
    expect(withoutWaste.toString()).toBe("150");
  });

  it("honours a per-line waste override", () => {
    const req = explodeBom(
      [{ ...bom[0], wasteRateOverride: "0.15" }, bom[1]],
      100, "0.08",
    );
    expect(req[0].wasteRate.toString()).toBe("0.15");
    expect(req[1].wasteRate.toString()).toBe("0.08");
  });

  it("applies the size multiplier", () => {
    const base = explodeBom(bom, 100, "0")[0].requiredQty;
    const large = explodeBom(bom, 100, "0", "1.18")[0].requiredQty;
    expect(large.toString()).toBe("177");
    expect(large.greaterThan(base)).toBe(true);
  });

  it("returns nothing for an empty BOM instead of failing", () => {
    expect(explodeBom([], 100, "0.08")).toEqual([]);
  });
});

describe("variance", () => {
  it("marks using less than planned as favourable", () => {
    const v = variance("324", "310");
    expect(v.variance.toString()).toBe("-14");
    expect(v.favourable).toBe(true);
  });

  it("marks an overrun as unfavourable and reports the percentage", () => {
    const v = variance("100", "112");
    expect(v.variance.toString()).toBe("12");
    expect(v.variancePct!.toString()).toBe("0.12");
    expect(v.favourable).toBe(false);
  });

  it("treats hitting plan exactly as favourable", () => {
    const v = variance("324", "324");
    expect(v.variance.toString()).toBe("0");
    expect(v.favourable).toBe(true);
  });

  it("gives no percentage against a zero plan rather than dividing by zero", () => {
    const v = variance("0", "50");
    expect(v.variancePct).toBeNull();
    expect(v.variance.toString()).toBe("50");
  });
});

describe("actual waste", () => {
  it("derives the rate from what was really issued", () => {
    // 324 issued against 300 standard = 8% waste.
    expect(actualWasteRate("324", "300")!.toString()).toBe("0.08");
  });

  it("reports negative waste when less was issued than standard", () => {
    // Real, and worth seeing: it usually means the standard is wrong.
    expect(actualWasteRate("290", "300")!.toFixed(4)).toBe("-0.0333");
  });

  it("returns null when nothing was required", () => {
    expect(actualWasteRate("10", "0")).toBeNull();
  });

  it("flags drift only past the configured threshold", () => {
    // 12% actual against 8% planned is 4 points of drift.
    expect(wasteDriftExceeded("0.12", "0.08", "0.03")).toBe(true);
    expect(wasteDriftExceeded("0.10", "0.08", "0.03")).toBe(false);
  });

  it("does not flag waste that came in under plan", () => {
    expect(wasteDriftExceeded("0.05", "0.08", "0.03")).toBe(false);
  });
});

describe("yield", () => {
  it("splits output into good, rejected and reworked", () => {
    const y = orderYield({ goodQty: 190, rejectedQty: 4, reworkQty: 6 });
    expect(y.totalOutput.toString()).toBe("200");
    expect(y.yieldRate!.toString()).toBe("0.95");
    expect(y.defectRate!.toString()).toBe("0.05");
  });

  it("reports a perfect run", () => {
    const y = orderYield({ goodQty: 200 });
    expect(y.yieldRate!.toString()).toBe("1");
    expect(y.defectRate!.toString()).toBe("0");
  });

  it("gives no rate before anything has come off the line", () => {
    const y = orderYield({ goodQty: 0 });
    expect(y.yieldRate).toBeNull();
  });
});

describe("line efficiency", () => {
  it("compares earned minutes against clocked minutes", () => {
    // 200 good × 33 SMV = 6,600 earned against 8,250 clocked.
    const earned = earnedMinutes(200, "33");
    expect(earned.toString()).toBe("6600");
    expect(lineEfficiency(earned, "8250")!.toString()).toBe("0.8");
  });

  it("can exceed one when the line beats the standard", () => {
    // Worth surfacing rather than capping: usually the SMV is too generous.
    expect(lineEfficiency("6600", "6000")!.toString()).toBe("1.1");
  });

  it("gives no figure for a line that clocked nothing", () => {
    expect(lineEfficiency("0", "0")).toBeNull();
  });

  it("stays separate from utilisation", () => {
    // A line can convert its clocked minutes perfectly and still sit idle for
    // most of the month; efficiency alone cannot reveal that.
    expect(lineEfficiency("6600", "6600")!.toString()).toBe("1");
  });
});
