import { describe, it, expect } from "vitest";
import {
  encodeCode128B,
  code128Bars,
  code128Svg,
  canEncode,
  BarcodeError,
  QUIET_ZONE_MODULES,
} from "./barcode";

describe("Code 128 B encoding", () => {
  it("wraps the value in a start and stop symbol", () => {
    const codes = encodeCode128B("A");
    expect(codes[0]).toBe(104);
    expect(codes[codes.length - 1]).toBe(106);
  });

  it("maps characters by their offset from space", () => {
    // "A" is ASCII 65, so its symbol value is 33.
    expect(encodeCode128B("A")[1]).toBe(33);
    // "0" is ASCII 48 → 16.
    expect(encodeCode128B("0")[1]).toBe(16);
  });

  it("computes the checksum the way a scanner verifies it", () => {
    // "HI345678" in pure subset B: values 40,41,19,20,21,22,23,24, weighted
    // by position on top of the start value gives 953, and 953 mod 103 is 26.
    // The widely quoted 92 for this string assumes subset C for the digits,
    // which packs them in pairs — a different encoding of the same text.
    const codes = encodeCode128B("HI345678");
    expect(codes[codes.length - 2]).toBe(26);
  });

  it("checksums a real SKU deterministically", () => {
    const a = encodeCode128B("DALIA-BLK-2XL");
    const b = encodeCode128B("DALIA-BLK-2XL");
    expect(a).toEqual(b);
    // Start, thirteen characters, checksum, stop.
    expect(a).toHaveLength(16);
  });

  it("gives different codes a different checksum", () => {
    const check = (v: string) => {
      const codes = encodeCode128B(v);
      return codes[codes.length - 2];
    };
    expect(check("DALIA-BLK-M")).not.toBe(check("DALIA-BLK-L"));
  });

  it("refuses Arabic rather than dropping it silently", () => {
    // Dropping the characters would print a label for a different SKU than
    // the one asked for, which is worse than refusing.
    expect(() => encodeCode128B("داليا")).toThrow(BarcodeError);
    expect(() => encodeCode128B("DALIA-أسود")).toThrow(/cannot go in a Code 128 barcode/i);
  });

  it("refuses an empty value", () => {
    expect(() => encodeCode128B("")).toThrow(BarcodeError);
  });

  it("accepts every character a SKU can contain", () => {
    expect(() => encodeCode128B("ABCXYZ0123456789-_.")).not.toThrow();
  });
});

describe("bar geometry", () => {
  it("leaves a quiet zone on both sides", () => {
    const { bars, totalModules } = code128Bars("DALIA-BLK-M");
    // Nothing is printed inside the first ten modules.
    expect(bars[0].x).toBeGreaterThanOrEqual(QUIET_ZONE_MODULES);
    const lastEdge = bars[bars.length - 1].x + bars[bars.length - 1].width;
    expect(totalModules - lastEdge).toBeGreaterThanOrEqual(QUIET_ZONE_MODULES);
  });

  it("produces an eleven-module symbol per character", () => {
    const short = code128Bars("A").totalModules;
    const longer = code128Bars("AB").totalModules;
    expect(longer - short).toBe(11);
  });

  it("never overlaps two bars", () => {
    const { bars } = code128Bars("DALIA-BLK-2XL");
    for (let i = 1; i < bars.length; i++) {
      const previousEdge = bars[i - 1].x + bars[i - 1].width;
      expect(bars[i].x).toBeGreaterThanOrEqual(previousEdge);
    }
  });

  it("ends on a bar, as the stop pattern requires", () => {
    const { bars, totalModules } = code128Bars("A");
    const lastEdge = bars[bars.length - 1].x + bars[bars.length - 1].width;
    expect(lastEdge).toBe(totalModules - QUIET_ZONE_MODULES);
  });
});

describe("SVG output", () => {
  it("renders at a module width scanners can read", () => {
    const svg = code128Svg("DALIA-BLK-M");
    // Physical units, not pixels — a barcode sized in pixels prints at
    // whatever size the browser feels like.
    expect(svg).toMatch(/width="[\d.]+mm"/);
    expect(svg).toMatch(/height="[\d.]+mm"/);
  });

  it("disables antialiasing, which greys bar edges and breaks scanning", () => {
    expect(code128Svg("DALIA-BLK-M")).toContain('shape-rendering="crispEdges"');
  });

  it("prints the code underneath so a human can read it too", () => {
    const svg = code128Svg("DALIA-BLK-M");
    expect(svg).toContain("DALIA-BLK-M</text>");
  });

  it("can omit the text for a very small label", () => {
    expect(code128Svg("DALIA-BLK-M", { showText: false })).not.toContain("<text");
  });

  it("scales with the module width", () => {
    const narrow = code128Svg("DALIA-BLK-M", { moduleWidthMm: 0.25 });
    const wide = code128Svg("DALIA-BLK-M", { moduleWidthMm: 0.5 });
    const widthOf = (svg: string) => Number(svg.match(/width="([\d.]+)mm"/)![1]);
    expect(widthOf(wide)).toBeCloseTo(widthOf(narrow) * 2, 1);
  });

  it("escapes characters that would break the markup", () => {
    const svg = code128Svg("A&B<C");
    expect(svg).toContain("A&amp;B&lt;C");
  });

  it("carries no external reference", () => {
    // The print stylesheet blocks outbound requests, and an image that fails
    // to load leaves a blank label nobody notices.
    const svg = code128Svg("DALIA-BLK-M");
    // The xmlns namespace is a bare identifier, never fetched; what must not
    // appear is anything the renderer would go and load.
    expect(svg).not.toContain("<image");
    expect(svg).not.toContain("xlink:href");
    expect(svg).not.toMatch(/url\(/);
  });
});

describe("checking before printing", () => {
  it("passes a valid SKU", () => {
    expect(canEncode("DALIA-BLK-2XL")).toEqual({ ok: true });
  });

  it("explains why a value cannot be printed", () => {
    const result = canEncode("داليا-أسود");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Latin letters/i);
  });
});
