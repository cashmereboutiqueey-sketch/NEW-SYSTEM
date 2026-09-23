import { describe, it, expect } from "vitest";
import { costFor, checkRow, isMaterial, type CountedRow } from "./opening-balance";

/** What the business already had, and what anybody can say it cost. */

const row = (over: Partial<CountedRow> = {}): CountedRow => ({
  rowNumber: 2,
  kind: "GARMENT",
  code: "0012-BLK-2XL",
  location: "LOC-ALX",
  quantity: "3",
  unitCost: "",
  ...over,
});

describe("settling on a cost", () => {
  it("takes what somebody typed over anything it could work out", () => {
    // The person holding the garment knows more than the bill does.
    const v = costFor({ statedCost: "250", bomCost: "300", retailPrice: "1000", retailCostRatio: "0.4" });
    expect(v.unitCost.toString()).toBe("250");
    expect(v.basis).toBe("STATED");
  });

  it("falls to the bill when nobody typed one", () => {
    const v = costFor({ bomCost: "300", retailPrice: "1000", retailCostRatio: "0.4" });
    expect(v.unitCost.toString()).toBe("300");
    expect(v.basis).toBe("DERIVED_FROM_BOM");
  });

  it("estimates from the selling price only when there is nothing else", () => {
    const v = costFor({ retailPrice: "1000", retailCostRatio: "0.4" });
    expect(v.unitCost.toString()).toBe("400");
    expect(v.basis).toBe("ESTIMATED_FROM_RETAIL");
    expect(v.refusal).toBeNull();
  });

  it("always says which of the three it used", () => {
    const bases = [
      costFor({ statedCost: "1" }).basis,
      costFor({ bomCost: "1" }).basis,
      costFor({ retailPrice: "10", retailCostRatio: "0.5" }).basis,
    ];
    expect(bases).toEqual(["STATED", "DERIVED_FROM_BOM", "ESTIMATED_FROM_RETAIL"]);
  });

  it("refuses a cost of zero, which is the most flattering wrong number there is", () => {
    // Stock carried at nothing shows every sale of it as pure profit.
    const v = costFor({ statedCost: "0", retailPrice: "1000", retailCostRatio: "0.4" });
    expect(v.refusal).toMatch(/pure profit/i);
  });

  it("refuses when there is no cost, no bill and no price to guess from", () => {
    const v = costFor({ retailCostRatio: "0.4" });
    expect(v.refusal).toMatch(/no selling price|estimate from/i);
  });

  it("refuses to guess when nobody said what fraction of the price is cost", () => {
    const v = costFor({ retailPrice: "1000" });
    expect(v.refusal).toMatch(/ratio/i);
  });

  it("refuses a ratio that is not a fraction of a price", () => {
    expect(costFor({ retailPrice: "1000", retailCostRatio: "1.5" }).refusal).not.toBeNull();
    expect(costFor({ retailPrice: "1000", retailCostRatio: "0" }).refusal).not.toBeNull();
  });

  it("rounds to the piastre, because a lot cost is money", () => {
    expect(costFor({ retailPrice: "999.99", retailCostRatio: "0.333" }).unitCost.toString()).toBe("333");
  });
});

describe("checking a counted row", () => {
  it("accepts an ordinary one", () => {
    const v = checkRow(row());
    expect(v.kind).toBe("valid");
  });

  it("takes a cost left blank, which is how a cost gets worked out", () => {
    expect(checkRow(row({ unitCost: "" })).kind).toBe("valid");
  });

  it("refuses a kind it does not know, naming what it does", () => {
    const v = checkRow(row({ kind: "SHOES" }));
    expect(v.kind).toBe("invalid");
    if (v.kind === "invalid") expect(v.reason).toContain("FABRIC");
  });

  it("refuses a row with nothing counted on it", () => {
    for (const quantity of ["0", "", "-3", "abc"]) {
      expect(checkRow(row({ quantity })).kind, quantity).toBe("invalid");
    }
  });

  it("refuses stock that is nowhere", () => {
    expect(checkRow(row({ location: "" })).kind).toBe("invalid");
  });

  it("refuses a code that is not there", () => {
    expect(checkRow(row({ code: "  " })).kind).toBe("invalid");
  });

  it("refuses a cost that is not a number", () => {
    expect(checkRow(row({ unitCost: "-5" })).kind).toBe("invalid");
    expect(checkRow(row({ unitCost: "cheap" })).kind).toBe("invalid");
  });
});

describe("telling cloth from garments", () => {
  it("knows both words for each", () => {
    expect(isMaterial("FABRIC")).toBe(true);
    expect(isMaterial("material")).toBe(true);
    expect(isMaterial("GARMENT")).toBe(false);
    expect(isMaterial(" variant ")).toBe(false);
  });
});
