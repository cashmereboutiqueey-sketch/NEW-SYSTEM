import { describe, it, expect } from "vitest";
import { buildSku, parseSku, isValidSku } from "./sku";

describe("SKU convention [STYLENAME]-[COLORCODE]-[SIZE]", () => {
  it("builds a SKU from its three parts", () => {
    expect(
      buildSku({ styleCode: "DALIA", colorCode: "BLK", sizeCode: "2XL" }),
    ).toBe("DALIA-BLK-2XL");
  });

  it("normalises case and whitespace on the way in", () => {
    expect(
      buildSku({ styleCode: " dalia ", colorCode: "blk", sizeCode: "m" }),
    ).toBe("DALIA-BLK-M");
  });

  it("round-trips every seeded colour code", () => {
    const colors = ["BLK", "BLU", "CRM", "OLV", "BRN", "YLW", "BEI", "GRY", "BBL", "WHT"];
    for (const color of colors) {
      const sku = buildSku({ styleCode: "NOUR", colorCode: color, sizeCode: "L" });
      expect(parseSku(sku)).toEqual({
        styleCode: "NOUR",
        colorCode: color,
        sizeCode: "L",
      });
    }
  });

  it("round-trips every seeded size", () => {
    for (const size of ["M", "L", "XL", "2XL", "3XL"]) {
      const sku = buildSku({ styleCode: "FAYROUZ", colorCode: "CRM", sizeCode: size });
      expect(parseSku(sku)?.sizeCode).toBe(size);
    }
  });

  it("rejects a colour code that is not three letters", () => {
    expect(() =>
      buildSku({ styleCode: "DALIA", colorCode: "BLACK", sizeCode: "M" }),
    ).toThrow();
  });

  it("rejects a style code containing the separator", () => {
    expect(() =>
      buildSku({ styleCode: "DAL-IA", colorCode: "BLK", sizeCode: "M" }),
    ).toThrow();
  });

  it("returns null for malformed external SKUs rather than throwing", () => {
    for (const bad of ["DALIA-BLK", "DALIA-BLK-M-EXTRA", "", "   ", "DALIA_BLK_M"]) {
      expect(parseSku(bad)).toBeNull();
      expect(isValidSku(bad)).toBe(false);
    }
  });

  it("accepts lowercase input from an external system", () => {
    expect(parseSku("dalia-blk-2xl")).toEqual({
      styleCode: "DALIA",
      colorCode: "BLK",
      sizeCode: "2XL",
    });
  });
});
