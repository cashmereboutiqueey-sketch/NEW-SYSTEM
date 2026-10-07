import { describe, expect, it, vi } from "vitest";
import { createFlextockClient, FlextockApiError } from "./flextock-api";

describe("Flextock HTTP client", () => {
  const credentials = { username: "merchant", password: "test-password", apiKey: "test-key" };
  it("authenticates, submits catalog identities and creates an order with a bearer token", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access: "test-access", refresh: "unused" }))
      .mockResolvedValueOnce(Response.json({ response: [{ sku_code: "SKU-1", message: "SKU code already exists." }] }))
      .mockResolvedValueOnce(Response.json({ message: "Order created successfully." }));
    const client = createFlextockClient(credentials, request);
    await client.createProducts([{ sku_code: "SKU-1", sku_name: "Dress", price: 500 }]);
    await client.createOrder({ order_code: "SO-1" });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[0][0]).toBe("https://api.flextock.com/base/auth/");
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({ username: "merchant", password: "test-password", key: "test-key" });
    expect(request.mock.calls[2][1]?.headers).toMatchObject({ Authorization: "Bearer test-access" });
  });

  it("rejects an unconfirmed catalog response before order submission", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access: "test-access" }))
      .mockResolvedValueOnce(Response.json({ response: [{ sku_code: "SKU-1", message: "SKU rejected" }] }));
    await expect(createFlextockClient(credentials, request).createProducts([{ sku_code: "SKU-1", sku_name: "Dress", price: 500 }]))
      .rejects.toThrow(FlextockApiError);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
