import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Where the Shopify access token is allowed to go.
 *
 * No database and no network: `fetch` is replaced, so every test can see
 * exactly which requests would have left the server and what they carried.
 * The database module is replaced too, only because importing the connector
 * would otherwise open a connection pool it never uses here.
 */

vi.mock("./db", () => ({ db: {} }));

const { verifyShopConnection, ShopifyError } = await import("./shopify");

const TOKEN = "shpat_synthetic_test_token";
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function shopResponse(): Response {
  return new Response(
    JSON.stringify({ shop: { name: "Cashmere", domain: "cashmere.eg", currency: "EGP" } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("the Shopify request boundary", () => {
  it("sends the token to the shop and nowhere else", async () => {
    fetchMock.mockResolvedValue(shopResponse());

    const shop = await verifyShopConnection({
      externalRef: "cashmere-eg.myshopify.com",
      accessToken: TOKEN,
      apiVersion: null,
    });

    expect(shop.name).toBe("Cashmere");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(url).hostname).toBe("cashmere-eg.myshopify.com");
    expect(init.headers["X-Shopify-Access-Token"]).toBe(TOKEN);
  });

  // The audit's reproduction: this passed the old suffix check, resolved to
  // audit.invalid, and carried the token there.
  it.each([
    "audit.invalid/#.myshopify.com",
    "evil.example/.myshopify.com",
    "token@evil.example/.myshopify.com",
    "evil.example?.myshopify.com",
  ])("refuses %s without making any request", async (externalRef) => {
    await expect(
      verifyShopConnection({ externalRef, accessToken: TOKEN, apiVersion: null }),
    ).rejects.toBeInstanceOf(ShopifyError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an API version that would reshape the path", async () => {
    await expect(
      verifyShopConnection({
        externalRef: "cashmere-eg.myshopify.com",
        accessToken: TOKEN,
        apiVersion: "2024-10/../../../x",
      }),
    ).rejects.toBeInstanceOf(ShopifyError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not follow a redirect, because the token would go with it", async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 301, headers: { Location: "https://evil.example/" } }),
    );

    await expect(
      verifyShopConnection({
        externalRef: "cashmere-eg.myshopify.com",
        accessToken: TOKEN,
        apiVersion: null,
      }),
    ).rejects.toThrow(/redirect/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].redirect).toBe("manual");
  });
});
