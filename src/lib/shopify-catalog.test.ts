import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  request: vi.fn(),
  mappings: [] as { connectionId: string; objectType: string; externalId: string; internalId: string; externalRef: string }[],
}));

vi.mock("./shopify", () => ({
  ShopifyError: class ShopifyError extends Error {},
  shopifyRequest: state.request,
}));
vi.mock("./audit", () => ({ writeAudit: vi.fn() }));
vi.mock("./db", () => {
  const db = {
    integrationConnection: {
      findFirst: vi.fn(async () => ({
        id: "connection-1", provider: "SHOPIFY", externalRef: "cashmere.myshopify.com",
        accessToken: "test", apiVersion: "2026-04",
      })),
    },
    style: {
      findUnique: vi.fn(async () => ({
        id: "style-1", code: "DALIA", nameEn: "Dalia", retailPrice: "1500",
        variants: [
          { id: "v-small", sku: "DALIA-BLK-S", barcode: "DALIA-BLK-S", colorCodeId: "black", colorCode: { nameEn: "Black" }, sizeCode: { code: "S" } },
          { id: "v-medium", sku: "DALIA-BLK-M", barcode: "DALIA-BLK-M", colorCodeId: "black", colorCode: { nameEn: "Black" }, sizeCode: { code: "M" } },
        ],
      })),
    },
    externalMapping: {
      findFirst: vi.fn(async ({ where }: { where: { objectType: string; internalId: string } }) =>
        state.mappings.find((m) => m.objectType === where.objectType && m.internalId === where.internalId) ?? null),
      findUnique: vi.fn(async ({ where }: { where: { connectionId_objectType_externalId: { objectType: string; externalId: string } } }) =>
        state.mappings.find((m) => m.objectType === where.connectionId_objectType_externalId.objectType && m.externalId === where.connectionId_objectType_externalId.externalId) ?? null),
      create: vi.fn(async ({ data }: { data: (typeof state.mappings)[number] }) => { state.mappings.push(data); return data; }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return { db };
});

const { syncShopifyStyleDraft } = await import("./shopify-catalog");

function respond(data: object): Response {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

describe("Shopify style draft sync", () => {
  let product: {
    id: string; handle: string; status: string; tags: string[];
    variants: { nodes: { id: string; sku: string | null; selectedOptions: { name: string; value: string }[] }[]; pageInfo: { hasNextPage: boolean } };
  } | null;
  let productCreates: number;
  let variantCreates: number;
  let foreignSku: string | null;

  beforeEach(() => {
    state.mappings.length = 0;
    state.request.mockReset();
    product = null;
    productCreates = 0;
    variantCreates = 0;
    foreignSku = null;
    state.request.mockImplementation(async (_connection: unknown, _path: string, init: { body: { query: string; variables: Record<string, unknown> } }) => {
      const { query, variables } = init.body;
      if (query.includes("productByIdentifier")) return respond({ productByIdentifier: product });
      if (query.includes("productVariants(first:")) return respond({ productVariants: {
        nodes: foreignSku ? [{ id: "gid://shopify/ProductVariant/999", sku: foreignSku, selectedOptions: [] }] : [],
        pageInfo: { hasNextPage: false },
      } });
      if (query.includes("productCreate(")) {
        productCreates += 1;
        const input = variables.product as { handle: string; status: string; tags: string[] };
        expect(input.status).toBe("DRAFT");
        product = {
          id: "gid://shopify/Product/100", handle: input.handle, status: input.status, tags: input.tags,
          variants: { nodes: [{ id: "gid://shopify/ProductVariant/101", sku: null, selectedOptions: [] }], pageInfo: { hasNextPage: false } },
        };
        return respond({ productCreate: { product: { id: product.id }, userErrors: [] } });
      }
      if (query.includes("productVariantsBulkCreate(")) {
        variantCreates += 1;
        expect(variables.strategy).toBe("REMOVE_STANDALONE_VARIANT");
        const variants = variables.variants as { inventoryItem: { sku: string }; optionValues: { optionName: string; name: string }[] }[];
        expect(variants.map((v) => v.inventoryItem.sku)).toEqual(["DALIA-BLK-S", "DALIA-BLK-M"]);
        product!.variants.nodes = variants.map((v, i) => ({
          id: `gid://shopify/ProductVariant/${102 + i}`,
          sku: v.inventoryItem.sku,
          selectedOptions: v.optionValues.map((o) => ({ name: o.optionName, value: o.name })),
        }));
        return respond({ productVariantsBulkCreate: { userErrors: [] } });
      }
      if (query.includes("product(id:")) return respond({ product });
      throw new Error(`Unexpected Shopify operation: ${query}`);
    });
  });

  it("creates one draft with exact ERP SKUs and maps it only once", async () => {
    const first = await syncShopifyStyleDraft("style-1", { userId: "owner" });
    const retry = await syncShopifyStyleDraft("style-1", { userId: "owner" });

    expect(first).toMatchObject({ connected: true, created: true, variants: 2, productId: "100" });
    expect(retry.created).toBe(false);
    expect(productCreates).toBe(1);
    expect(variantCreates).toBe(1);
    expect(state.mappings).toHaveLength(3);
    expect(state.mappings.filter((m) => m.objectType === "variant").map((m) => m.externalRef)).toEqual([
      "DALIA-BLK-S", "DALIA-BLK-M",
    ]);
  });

  it("refuses to attach a style to somebody else's Shopify product", async () => {
    product = {
      id: "gid://shopify/Product/200", handle: "cashmere-dalia", status: "ACTIVE", tags: [],
      variants: { nodes: [], pageInfo: { hasNextPage: false } },
    };
    await expect(syncShopifyStyleDraft("style-1", { userId: "owner" })).rejects.toThrow(/belongs to another product/);
    expect(productCreates).toBe(0);
    expect(state.mappings).toHaveLength(0);
  });

  it("recovers a draft that Shopify created before the response was lost", async () => {
    product = {
      id: "gid://shopify/Product/100", handle: "cashmere-dalia", status: "DRAFT",
      tags: ["cashmere-os", "cashmere-style:DALIA"],
      variants: {
        nodes: [{ id: "gid://shopify/ProductVariant/101", sku: null, selectedOptions: [] }],
        pageInfo: { hasNextPage: false },
      },
    };

    const result = await syncShopifyStyleDraft("style-1", { userId: "owner" });

    expect(result).toMatchObject({ created: false, variants: 2, productId: "100" });
    expect(productCreates).toBe(0);
    expect(variantCreates).toBe(1);
    expect(state.mappings).toHaveLength(3);
  });

  it("does not create a duplicate SKU already used by another product", async () => {
    foreignSku = "DALIA-BLK-S";

    await expect(syncShopifyStyleDraft("style-1", { userId: "owner" })).rejects.toThrow(/already exists on another Shopify product/);

    expect(variantCreates).toBe(0);
    expect(state.mappings).toHaveLength(0);
  });
});
