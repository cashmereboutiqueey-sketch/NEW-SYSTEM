import "server-only";
import { db } from "./db";
import { writeAudit, type AuditContext } from "./audit";
import { shopifyRequest, ShopifyError, type ShopifyConnection } from "./shopify";

type GqlResult<T> = { data?: T; errors?: { message: string }[] };
type RemoteVariant = {
  id: string;
  sku: string | null;
  selectedOptions: { name: string; value: string }[];
};
type RemoteProduct = {
  id: string;
  handle: string;
  status: string;
  tags: string[];
  variants: { nodes: RemoteVariant[]; pageInfo: { hasNextPage: boolean } };
};

const PRODUCT_FIELDS = `id handle status tags variants(first: 250) {
  nodes { id sku selectedOptions { name value } }
  pageInfo { hasNextPage }
}`;

async function graphql<T>(connection: ShopifyConnection, query: string, variables: object): Promise<T> {
  const response = await shopifyRequest(connection, "graphql.json", {
    method: "POST",
    body: { query, variables },
  });
  const body = (await response.json()) as GqlResult<T>;
  if (body.errors?.length) {
    throw new ShopifyError(body.errors.map((e) => e.message).join("; "));
  }
  if (!body.data) throw new ShopifyError("Shopify returned no catalog data.");
  return body.data;
}

function userErrors(errors: { field?: string[] | null; message: string }[]) {
  if (errors.length) {
    throw new ShopifyError(errors.map((e) => `${e.field?.join(".") ?? "product"}: ${e.message}`).join("; "));
  }
}

function numericId(gid: string): string {
  const id = /\/(\d+)$/.exec(gid)?.[1];
  if (!id) throw new ShopifyError(`Shopify returned an invalid ID: ${gid}`);
  return id;
}

function option(variant: RemoteVariant, name: string): string | undefined {
  return variant.selectedOptions.find((o) => o.name.toLowerCase() === name.toLowerCase())?.value;
}

async function productByHandle(connection: ShopifyConnection, handle: string): Promise<RemoteProduct | null> {
  const data = await graphql<{ productByIdentifier: RemoteProduct | null }>(
    connection,
    `query StyleProduct($identifier: ProductIdentifierInput!) {
      productByIdentifier(identifier: $identifier) { ${PRODUCT_FIELDS} }
    }`,
    { identifier: { handle } },
  );
  return data.productByIdentifier;
}

async function productById(connection: ShopifyConnection, id: string): Promise<RemoteProduct> {
  const data = await graphql<{ product: RemoteProduct | null }>(
    connection,
    `query StyleProductById($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS} } }`,
    { id },
  );
  if (!data.product) throw new ShopifyError("The linked Shopify product was deleted. Restore it or unlink it before retrying.");
  return data.product;
}

async function existingSku(connection: ShopifyConnection, sku: string): Promise<RemoteVariant[]> {
  const data = await graphql<{ productVariants: { nodes: RemoteVariant[]; pageInfo: { hasNextPage: boolean } } }>(
    connection,
    `query ExistingStyleSku($query: String!) {
      productVariants(first: 100, query: $query) {
        nodes { id sku selectedOptions { name value } }
        pageInfo { hasNextPage }
      }
    }`,
    { query: `sku:${sku}` },
  );
  if (data.productVariants.pageInfo.hasNextPage) {
    throw new ShopifyError(`Shopify returned too many matches while checking SKU ${sku}.`);
  }
  return data.productVariants.nodes.filter((v) => v.sku?.toUpperCase() === sku.toUpperCase());
}

/**
 * The ERP owns the style code and SKUs. Shopify receives a draft catalog copy.
 * A retry first reads Shopify by the deterministic handle, so a lost response
 * after product creation cannot produce a second product.
 */
export async function syncShopifyStyleDraft(
  styleId: string,
  ctx: AuditContext,
): Promise<{ connected: boolean; created: boolean; variants: number; productId?: string }> {
  const connection = await db.integrationConnection.findFirst({
    where: { provider: "SHOPIFY", isActive: true },
    orderBy: { createdAt: "asc" },
  });
  if (!connection) return { connected: false, created: false, variants: 0 };

  const style = await db.style.findUnique({
    where: { id: styleId },
    include: {
      variants: { include: { colorCode: true, sizeCode: true }, orderBy: { sku: "asc" } },
    },
  });
  if (!style) throw new ShopifyError("Style not found.");
  if (!style.variants.length) throw new ShopifyError("Generate this style's SKUs first.");
  if (style.variants.length > 250) throw new ShopifyError("This style has more than 250 SKUs; split or paginate it before syncing.");
  const colourNames = new Map<string, string>();
  for (const variant of style.variants) {
    const previous = colourNames.get(variant.colorCode.nameEn);
    if (previous && previous !== variant.colorCodeId) {
      throw new ShopifyError(`Two color codes are both named ${variant.colorCode.nameEn}. Give them distinct English names before syncing.`);
    }
    colourNames.set(variant.colorCode.nameEn, variant.colorCodeId);
  }

  const handle = `cashmere-${style.code.toLowerCase()}`;
  const ownershipTag = `cashmere-style:${style.code}`;
  const mappedProduct = await db.externalMapping.findFirst({
    where: { connectionId: connection.id, objectType: "product", internalId: style.id },
  });

  let product = mappedProduct
    ? await productById(connection, `gid://shopify/Product/${mappedProduct.externalId}`)
    : await productByHandle(connection, handle);
  let created = false;

  if (product && !product.tags.includes(ownershipTag)) {
    throw new ShopifyError(`Shopify handle ${handle} belongs to another product. Resolve that collision before syncing.`);
  }
  if (product && mappedProduct && numericId(product.id) !== mappedProduct.externalId) {
    throw new ShopifyError("The Shopify product mapping points to a different product.");
  }

  if (!product) {
    const colours = [...new Set(style.variants.map((v) => v.colorCode.nameEn))];
    const sizes = [...new Set(style.variants.map((v) => v.sizeCode.code))];
    const data = await graphql<{
      productCreate: { product: { id: string } | null; userErrors: { field?: string[]; message: string }[] };
    }>(connection, `mutation CreateStyleDraft($product: ProductCreateInput!) {
      productCreate(product: $product) { product { id } userErrors { field message } }
    }`, {
      product: {
        title: style.nameEn,
        handle,
        status: "DRAFT",
        tags: ["cashmere-os", ownershipTag],
        productOptions: [
          { name: "Color", values: colours.map((name) => ({ name })) },
          { name: "Size", values: sizes.map((name) => ({ name })) },
        ],
      },
    });
    userErrors(data.productCreate.userErrors);
    if (!data.productCreate.product) throw new ShopifyError("Shopify did not create the draft product.");
    created = true;
    product = await productById(connection, data.productCreate.product.id);
  }

  if (product.variants.pageInfo.hasNextPage) {
    throw new ShopifyError("This Shopify product has more than 250 variants; catalog sync needs pagination before it can continue safely.");
  }

  const existing = product.variants.nodes;
  const missing: typeof style.variants = [];
  for (const local of style.variants) {
    const bySku = existing.filter((v) => v.sku?.toUpperCase() === local.sku.toUpperCase());
    if (bySku.length > 1) throw new ShopifyError(`Shopify has duplicate SKU ${local.sku}.`);
    if (bySku.length === 1) {
      if (bySku[0].sku !== local.sku) throw new ShopifyError(`Shopify SKU ${bySku[0].sku} must match ERP code ${local.sku} exactly.`);
      if (option(bySku[0], "Color") !== local.colorCode.nameEn || option(bySku[0], "Size") !== local.sizeCode.code) {
        throw new ShopifyError(`Shopify SKU ${local.sku} has different color or size options.`);
      }
      continue;
    }
    if (existing.some((v) => v.sku && option(v, "Color") === local.colorCode.nameEn && option(v, "Size") === local.sizeCode.code)) {
      throw new ShopifyError(`A Shopify variant already uses ${local.colorCode.nameEn}/${local.sizeCode.code} with another SKU.`);
    }
    const elsewhere = await existingSku(connection, local.sku);
    if (elsewhere.length) throw new ShopifyError(`SKU ${local.sku} already exists on another Shopify product.`);
    missing.push(local);
  }

  if (missing.length) {
    const removePlaceholder = existing.length === 1 && !existing[0].sku;
    const data = await graphql<{
      productVariantsBulkCreate: { userErrors: { field?: string[]; message: string }[] };
    }>(connection, `mutation CreateStyleVariants(
      $productId: ID!, $variants: [ProductVariantsBulkInput!]!, $strategy: ProductVariantsBulkCreateStrategy
    ) {
      productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) {
        userErrors { field message }
      }
    }`, {
      productId: product.id,
      strategy: removePlaceholder ? "REMOVE_STANDALONE_VARIANT" : "DEFAULT",
      variants: missing.map((v) => ({
        optionValues: [
          { optionName: "Color", name: v.colorCode.nameEn },
          { optionName: "Size", name: v.sizeCode.code },
        ],
        inventoryItem: { sku: v.sku, tracked: true },
        barcode: v.barcode ?? v.sku,
        inventoryPolicy: "DENY",
        taxable: false,
        ...(style.retailPrice != null ? { price: style.retailPrice.toString() } : {}),
      })),
    });
    userErrors(data.productVariantsBulkCreate.userErrors);
    product = await productById(connection, product.id);
  }

  if (product.variants.pageInfo.hasNextPage) throw new ShopifyError("Shopify returned an incomplete variant list.");
  const matched = style.variants.map((local) => {
    const remote = product!.variants.nodes.find((v) => v.sku === local.sku);
    if (!remote) throw new ShopifyError(`Shopify did not return SKU ${local.sku} after synchronization.`);
    return { local, remote };
  });

  await db.$transaction(async (tx) => {
    const mappings = [
      { objectType: "product", externalId: numericId(product!.id), internalId: style.id, externalRef: style.code },
      ...matched.map(({ local, remote }) => ({
        objectType: "variant", externalId: numericId(remote.id), internalId: local.id, externalRef: local.sku,
      })),
    ];
    for (const mapping of mappings) {
      const previous = await tx.externalMapping.findUnique({
        where: { connectionId_objectType_externalId: {
          connectionId: connection.id, objectType: mapping.objectType, externalId: mapping.externalId,
        } },
      });
      if (previous && previous.internalId !== mapping.internalId) {
        throw new ShopifyError(`Shopify ${mapping.objectType} ${mapping.externalId} is linked to a different ERP record.`);
      }
      if (!previous) await tx.externalMapping.create({ data: { connectionId: connection.id, ...mapping } });
    }
    await writeAudit(tx, {
      action: "SHOPIFY_STYLE_DRAFT_SYNCED",
      entityName: "Style",
      entityId: style.id,
      after: { productId: numericId(product!.id), created, skus: matched.map(({ local }) => local.sku) },
      ctx,
    });
  });

  return { connected: true, created, variants: matched.length, productId: numericId(product.id) };
}
