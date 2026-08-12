import { describe, it, expect } from "vitest";
import {
  calculateStyleCost,
  idleCapacityPenalty,
  isBelowArmsLength,
  type BomLineInput,
} from "./style-costing";

const fabric: BomLineInput = {
  materialId: "m1", materialCode: "FAB-JER-180",
  materialNameEn: "Cotton jersey", materialNameAr: "جيرسيه قطن",
  materialType: "FABRIC",
  standardConsumption: "1.5",
  unitCost: "172.20", // 168 base + 2.5% freight
};

const thread: BomLineInput = {
  materialId: "m2", materialCode: "TRM-THR",
  materialNameEn: "Thread", materialNameAr: "خيط",
  materialType: "TRIM",
  standardConsumption: "1",
  unitCost: "6.50",
};

const button: BomLineInput = {
  materialId: "m3", materialCode: "TRM-BTN",
  materialNameEn: "Button", materialNameAr: "زرار",
  materialType: "TRIM",
  standardConsumption: "5",
  unitCost: "1.20",
};

const base = {
  bomLines: [fabric, thread, button],
  plannedWasteRate: "0.08",
  smvMinutes: "33",
  minuteRate: "2.3705",
  factoryMarkupPct: "0.18",
};

describe("style costing", () => {
  const r = calculateStyleCost(base);

  it("applies waste to consumption, not to cost", () => {
    // 1.5m × 1.08 = 1.62m actually issued from the store
    expect(r.lines[0].effectiveConsumption.toString()).toBe("1.62");
    expect(r.lines[0].lineCost.toFixed(4)).toBe("278.9640");
  });

  it("separates fabric from trims while costing every line", () => {
    // thread 1 × 1.08 × 6.50 + buttons 5 × 1.08 × 1.20
    expect(r.trimCost.toFixed(4)).toBe("13.5000");
    expect(r.fabricCost.toFixed(4)).toBe("278.9640");
    expect(r.materialCost.toFixed(4)).toBe("292.4640");
  });

  it("costs manufacturing at SMV times the minute rate", () => {
    // 33 minutes × 2.3705
    expect(r.cmtCost.toFixed(4)).toBe("78.2265");
  });

  it("adds the margin to full cost including materials, per decision D-002", () => {
    expect(r.factoryTotalCost.toFixed(4)).toBe("370.6905");
    // 370.6905 × 1.18
    expect(r.transferPrice.toFixed(2)).toBe("437.41");
    expect(r.factoryMarginValue.toFixed(2)).toBe("66.72");
  });

  it("earns margin on fabric too, which a conversion-only basis would not", () => {
    const conversionOnlyPrice = r.materialCost.plus(r.cmtCost.times(1.18));
    expect(r.transferPrice.greaterThan(conversionOnlyPrice)).toBe(true);
  });

  it("passes a fabric price rise through amplified by the margin", () => {
    // The consequence recorded in D-002: +10% on fabric raises the transfer
    // price by more than the fabric increase itself.
    const dearer = calculateStyleCost({
      ...base,
      bomLines: [{ ...fabric, unitCost: "189.42" }, thread, button],
    });
    const fabricIncrease = dearer.fabricCost.minus(r.fabricCost);
    const priceIncrease = dearer.transferPrice.minus(r.transferPrice);
    expect(priceIncrease.greaterThan(fabricIncrease)).toBe(true);
  });
});

describe("waste", () => {
  it("raises cost as planned waste rises", () => {
    const low = calculateStyleCost({ ...base, plannedWasteRate: "0.02" });
    const high = calculateStyleCost({ ...base, plannedWasteRate: "0.15" });
    expect(high.materialCost.greaterThan(low.materialCost)).toBe(true);
  });

  it("lets a single line override the style rate", () => {
    // Fabric wastes at 12% while trims waste at the style's 8%.
    const r = calculateStyleCost({
      ...base,
      bomLines: [{ ...fabric, wasteRateOverride: "0.12" }, thread, button],
    });
    expect(r.lines[0].wasteRate.toString()).toBe("0.12");
    expect(r.lines[1].wasteRate.toString()).toBe("0.08");
    expect(r.lines[0].effectiveConsumption.toFixed(4)).toBe("1.6800");
  });

  it("treats zero waste as costing exactly the standard consumption", () => {
    const r = calculateStyleCost({ ...base, plannedWasteRate: "0" });
    expect(r.lines[0].effectiveConsumption.toString()).toBe("1.5");
  });
});

describe("size multiplier", () => {
  it("scales consumption without needing a separate BOM", () => {
    const m = calculateStyleCost(base);
    const xxl = calculateStyleCost({ ...base, sizeConsumptionFactor: "1.18" });
    expect(xxl.materialCost.greaterThan(m.materialCost)).toBe(true);
    // 1.5 × 1.18 × 1.08
    expect(xxl.lines[0].effectiveConsumption.toFixed(4)).toBe("1.9116");
  });

  it("leaves manufacturing cost alone, since SMV is sized separately", () => {
    const m = calculateStyleCost(base);
    const xxl = calculateStyleCost({ ...base, sizeConsumptionFactor: "1.18" });
    expect(xxl.cmtCost.toString()).toBe(m.cmtCost.toString());
  });
});

describe("minute rate sensitivity", () => {
  it("raises the transfer price when the factory runs emptier", () => {
    // The same garment costs more when utilisation drops, because the minute
    // rate carries the idle capacity.
    const busy = calculateStyleCost({ ...base, minuteRate: "1.4223" });
    const idle = calculateStyleCost({ ...base, minuteRate: "2.3705" });
    expect(idle.transferPrice.greaterThan(busy.transferPrice)).toBe(true);
  });

  it("prices a zero-SMV item on materials alone", () => {
    const r = calculateStyleCost({ ...base, smvMinutes: "0" });
    expect(r.cmtCost.toString()).toBe("0");
    expect(r.factoryTotalCost.toString()).toBe(r.materialCost.toString());
  });
});

describe("idle capacity penalty", () => {
  it("converts the rate gap into EGP on one garment", () => {
    expect(idleCapacityPenalty("2.3705", "1.1378", "33").toFixed(2)).toBe("40.68");
  });

  it("is zero when the factory is full", () => {
    expect(idleCapacityPenalty("1.1378", "1.1378", "33").toString()).toBe("0");
  });
});

describe("arm's-length floor", () => {
  it("flags a margin below the configured minimum", () => {
    expect(isBelowArmsLength("0.08", "0.12")).toBe(true);
  });

  it("accepts a margin at or above the minimum", () => {
    expect(isBelowArmsLength("0.12", "0.12")).toBe(false);
    expect(isBelowArmsLength("0.18", "0.12")).toBe(false);
  });

  it("flags a zero margin, which is the discount the rule exists to catch", () => {
    // Selling to the brand at cost does not save money; it moves the factory's
    // loss into the brand's accounts.
    expect(isBelowArmsLength("0", "0.12")).toBe(true);
  });
});

describe("precision", () => {
  it("keeps full precision through the chain rather than rounding per step", () => {
    const r = calculateStyleCost({
      ...base,
      bomLines: [{ ...fabric, standardConsumption: "1.3333", unitCost: "99.99" }],
    });
    // Rounding each intermediate to 2dp would drift; the stored value carries
    // more digits than the displayed one.
    expect(r.transferPrice.toString().length).toBeGreaterThan(
      r.transferPrice.toFixed(2).length,
    );
  });

  it("produces an empty-BOM cost of manufacturing only", () => {
    const r = calculateStyleCost({ ...base, bomLines: [] });
    expect(r.materialCost.toString()).toBe("0");
    expect(r.factoryTotalCost.toString()).toBe(r.cmtCost.toString());
  });
});
