import { describe, it, expect } from "vitest";
import {
  dec,
  sum,
  safeDiv,
  roundMoney,
  formatMoney,
  formatPercent,
  Decimal,
} from "@/lib/money";

/**
 * These guard the arithmetic foundation the whole costing engine sits on.
 * If Decimal handling drifts, every figure in Phase 2 drifts with it.
 */
describe("decimal arithmetic", () => {
  it("does not accumulate binary floating point error", () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE754 floats.
    expect(sum(["0.1", "0.2"]).equals(new Decimal("0.3"))).toBe(true);
  });

  it("sums a realistic BOM without drift", () => {
    const lines = ["168.0000", "78.0000", "3.2000", "9.9000", "2.4000", "0.9500", "2.1000", "3.7500"];
    expect(sum(lines).toString()).toBe("268.3");
  });

  it("treats null and undefined as zero rather than NaN", () => {
    expect(dec(null).toString()).toBe("0");
    expect(dec(undefined).toString()).toBe("0");
  });

  it("returns null on division by zero instead of Infinity", () => {
    // A contribution margin of zero must not silently produce an infinite
    // break-even that renders as a plausible-looking huge number.
    expect(safeDiv("500000", "0")).toBeNull();
  });

  it("divides with enough precision for a minute rate", () => {
    // 568,000 EGP of conversion cost over 239,616 productive minutes.
    const rate = safeDiv("568000", "239616");
    expect(rate).not.toBeNull();
    expect(rate!.toDecimalPlaces(8).toString()).toBe("2.3704594");
  });

  it("rounds money half-up at the piastre, only at the end", () => {
    expect(roundMoney("1234.5650").toString()).toBe("1234.57");
    expect(roundMoney("1234.5649").toString()).toBe("1234.56");
    expect(roundMoney("0.005").toString()).toBe("0.01");
  });

  it("keeps full precision through a chain before rounding", () => {
    // consumption × (1 + waste) × unit cost, rounded once at the end
    const consumption = dec("2.30");
    const waste = dec("0.08");
    const unitCost = dec("232.00").times(dec(1).plus("0.03").plus("0.02"));
    const fabricCost = consumption.times(dec(1).plus(waste)).times(unitCost);
    // 2.30 m × 1.08 waste × (232.00 × 1.05 freight+duty) = 605.1024
    expect(fabricCost.toString()).toBe("605.1024");
    expect(roundMoney(fabricCost).toString()).toBe("605.1");
  });
});

describe("display formatting", () => {
  it("uses Latin digits in the Arabic UI, as Egyptian accounting does", () => {
    const out = formatMoney("1234.5", "ar");
    expect(out).toContain("1,234.50");
    expect(out).toContain("ج.م");
    // No Eastern Arabic numerals should reach a financial figure.
    expect(out).not.toMatch(/[٠-٩]/);
  });

  it("always shows money to the piastre", () => {
    expect(formatMoney("1234", "en")).toBe("EGP 1,234.00");
    expect(formatMoney("0.5", "en")).toBe("EGP 0.50");
  });

  it("renders stored fractions as percentages", () => {
    expect(formatPercent("0.14", "en")).toBe("14.0%");
    expect(formatPercent("0.085", "en", 2)).toBe("8.50%");
  });

  it("shows an em dash for absent values rather than zero", () => {
    // A missing figure and a genuine zero mean very different things in a
    // costing report; they must never look the same.
    expect(formatMoney(null, "en")).toBe("—");
    expect(formatMoney(0, "en")).toBe("EGP 0.00");
  });
});
