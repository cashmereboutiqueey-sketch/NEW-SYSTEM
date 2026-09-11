import { describe, it, expect } from "vitest";
import { isShopDomain, normaliseShopDomain, isApiVersion } from "./shopify-domain";

describe("shop domains", () => {
  it("accepts a shop's internal domain", () => {
    expect(normaliseShopDomain("cashmere-eg.myshopify.com")).toBe("cashmere-eg.myshopify.com");
  });

  it("forgives the way an address is pasted from a browser bar", () => {
    expect(normaliseShopDomain("  https://Cashmere-EG.myshopify.com/ ")).toBe(
      "cashmere-eg.myshopify.com",
    );
    expect(normaliseShopDomain("http://shop1.myshopify.com")).toBe("shop1.myshopify.com");
  });

  it("refuses the public brand address", () => {
    expect(normaliseShopDomain("cashmere.com")).toBeNull();
    expect(normaliseShopDomain("myshopify.com")).toBeNull();
    expect(normaliseShopDomain(".myshopify.com")).toBeNull();
  });

  // Each of these ends in .myshopify.com, which is all the old check asked,
  // and each makes a URL parser send the request somewhere else.
  it.each([
    "audit.invalid/#.myshopify.com",
    "evil.example/.myshopify.com",
    "evil.example?.myshopify.com",
    "evil.example#.myshopify.com",
    "token@evil.example/.myshopify.com",
    "evil.example\\.myshopify.com",
    "evil.example%2f.myshopify.com",
    "evil.example:443/.myshopify.com",
  ])("refuses %s, which would carry the token to another host", (attempt) => {
    expect(normaliseShopDomain(attempt)).toBeNull();
  });

  it("refuses ports, second labels and look-alike suffixes", () => {
    expect(normaliseShopDomain("shop.myshopify.com:8443")).toBeNull();
    expect(normaliseShopDomain("a.b.myshopify.com")).toBeNull();
    expect(normaliseShopDomain("shop.myshopify.com.evil.example")).toBeNull();
    expect(normaliseShopDomain("shop.myshopify.co")).toBeNull();
    expect(normaliseShopDomain("-shop.myshopify.com")).toBeNull();
    expect(normaliseShopDomain("shop .myshopify.com")).toBeNull();
    expect(normaliseShopDomain("")).toBeNull();
  });

  it("names exactly the host it was given once built into a URL", () => {
    // The guarantee that matters: whatever passes the check is the host.
    const domain = normaliseShopDomain("https://cashmere-eg.myshopify.com/")!;
    expect(new URL(`https://${domain}/admin/api/2025-01/shop.json`).hostname).toBe(domain);
  });

  it("holds stored values to the canonical form, with no forgiveness", () => {
    expect(isShopDomain("cashmere-eg.myshopify.com")).toBe(true);
    expect(isShopDomain("Cashmere-EG.myshopify.com")).toBe(false);
    expect(isShopDomain("https://cashmere-eg.myshopify.com")).toBe(false);
  });
});

describe("API versions", () => {
  it("accepts Shopify's dated releases", () => {
    expect(isApiVersion("2024-10")).toBe(true);
    expect(isApiVersion("2025-07")).toBe(true);
  });

  it("refuses anything that could reshape the request path", () => {
    expect(isApiVersion("2024-10/../../x")).toBe(false);
    expect(isApiVersion("2024-10?x=1")).toBe(false);
    expect(isApiVersion("")).toBe(false);
  });
});
