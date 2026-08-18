import "server-only";
import crypto from "node:crypto";
import { db } from "./db";
import { createSale, SalesError } from "./sales";
import { writeAudit, type AuditContext } from "./audit";
import { dec } from "./money";

/**
 * The Shopify connector.
 *
 * Shopify is authoritative for what happened on the website and nothing else.
 * An imported order becomes an internal sale through the same service a
 * moderator or cashier uses, so it relieves the same FIFO stock and posts the
 * same journals — there is no second, softer path into the ledger.
 *
 * Anything that cannot be matched with certainty becomes an exception rather
 * than a guess. Picking the closest-looking SKU would relieve the wrong
 * garment and misstate both stock and margin.
 */

export class ShopifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopifyError";
  }
}

const API_VERSION = "2024-10";

export type ShopifyOrder = {
  id: number;
  name: string;
  created_at: string;
  currency: string;
  total_discounts?: string;
  shipping_lines?: { price: string }[];
  customer?: {
    id: number;
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
    phone?: string | null;
  } | null;
  shipping_address?: { city?: string | null } | null;
  financial_status?: string;
  cancelled_at?: string | null;
  line_items: {
    id: number;
    sku: string | null;
    /** Stable, and present even when the SKU snapshot on the line is empty. */
    variant_id?: number | null;
    quantity: number;
    price: string;
    total_discount?: string;
    title?: string;
  }[];
};

/**
 * Verifies a webhook came from Shopify.
 *
 * Timing-safe on purpose: comparing digests with === leaks how much of the
 * signature was right, which is enough to forge one given enough attempts.
 */
export function verifyWebhookSignature(
  rawBody: string,
  hmacHeader: string,
  secret: string,
): boolean {
  const digest = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(hmacHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function shopifyFetch<T>(
  connection: { externalRef: string; accessToken: string | null; apiVersion: string | null },
  path: string,
): Promise<T> {
  if (!connection.accessToken) {
    throw new ShopifyError("This shop has no access token configured.");
  }

  const url = `https://${connection.externalRef}/admin/api/${connection.apiVersion ?? API_VERSION}/${path}`;
  const response = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": connection.accessToken,
      "Content-Type": "application/json",
    },
  });

  if (response.status === 429) {
    // Shopify's leaky bucket. Surfacing it plainly lets the caller back off
    // rather than hammering the shop and getting throttled harder.
    throw new ShopifyError("Shopify is rate limiting this shop. Try again shortly.");
  }
  if (!response.ok) {
    throw new ShopifyError(`Shopify returned ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

/** Records an unmatched record for a person to resolve. */
async function raiseException(input: {
  connectionId: string;
  objectType: string;
  externalId: string;
  reason: string;
  payload: unknown;
}) {
  await db.integrationException.create({
    data: {
      connectionId: input.connectionId,
      provider: "SHOPIFY",
      objectType: input.objectType,
      externalId: input.externalId,
      reason: input.reason,
      payload: JSON.parse(JSON.stringify(input.payload ?? null)),
    },
  });
}

/**
 * Imports orders into the internal sales engine.
 *
 * Idempotent twice over: an existing mapping short-circuits the import, and
 * `createSale` itself refuses a duplicate external id. Either guard alone
 * would do; both are cheap and stock relieved twice is not recoverable.
 */
export async function importOrders(
  input: { connectionId: string; orders: ShopifyOrder[] },
  ctx: AuditContext,
): Promise<{ created: number; duplicates: number; failed: number; exceptions: string[] }> {
  const connection = await db.integrationConnection.findUnique({
    where: { id: input.connectionId },
  });
  if (!connection) throw new ShopifyError("Shop connection not found.");

  const [brand, onlineChannel, anyChannel, location] = await Promise.all([
    db.entity.findFirstOrThrow({ where: { kind: "BRAND" } }),
    db.salesChannel.findFirst({ where: { kind: "ONLINE" } }),
    db.salesChannel.findFirstOrThrow(),
    // Website orders ship from the Alexandria warehouse unless configured
    // otherwise; the showroom and the warehouse are one location.
    db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } }),
  ]);
  const channel = onlineChannel ?? anyChannel;

  const log = await db.syncLog.create({
    data: {
      connectionId: connection.id,
      objectType: "order",
      direction: "INBOUND",
      status: "SUCCESS",
      processed: input.orders.length,
    },
  });

  let created = 0;
  let duplicates = 0;
  let failed = 0;
  const exceptions: string[] = [];
  const errors: { externalId: string; reason: string }[] = [];

  for (const order of input.orders) {
    const externalId = String(order.id);

    try {
      if (order.cancelled_at) {
        // Cancelled before it ever reached us: recorded, not imported, since
        // importing then reversing would move stock that never left.
        duplicates += 1;
        continue;
      }

      const mapped = await db.externalMapping.findUnique({
        where: {
          connectionId_objectType_externalId: {
            connectionId: connection.id,
            objectType: "order",
            externalId,
          },
        },
      });
      if (mapped) {
        duplicates += 1;
        continue;
      }

      // --- resolve every SKU before touching stock --------------------
      const lines: { variantId: string; quantity: number; retailPrice: number; discountPct: number }[] = [];
      const unknown: string[] = [];

      for (const item of order.line_items) {
        /**
         * The SKU first, then the variant id.
         *
         * Shopify writes the SKU onto the line at the moment the order is
         * placed and never revisits it, so an order taken before a SKU was
         * filled in carries the empty string for ever. Correcting the
         * catalogue does nothing for it. The variant id is stable and always
         * present, and syncVariantMappings records which garment each one is
         * — so a line with no usable SKU still resolves, and the shop's own
         * history becomes importable rather than permanently stranded.
         */
        const bySku = item.sku
          ? await db.variant.findUnique({ where: { sku: item.sku.trim().toUpperCase() } })
          : null;

        let variant = bySku;

        if (!variant && item.variant_id != null) {
          const mapping = await db.externalMapping.findUnique({
            where: {
              connectionId_objectType_externalId: {
                connectionId: connection.id,
                objectType: "variant",
                externalId: String(item.variant_id),
              },
            },
          });
          if (mapping) {
            variant = await db.variant.findUnique({ where: { id: mapping.internalId } });
          }
        }

        if (!variant) {
          // Named by whatever it does have, so the exception says something a
          // person can act on rather than an id nobody recognises.
          unknown.push(item.sku?.trim() || item.title || `line ${item.id}`);
          continue;
        }

        // Shopify gives a discount amount, not a rate; converting keeps the
        // internal order in the one shape the engine understands.
        const gross = dec(item.price).times(item.quantity);
        const discount = dec(item.total_discount ?? "0");
        const discountPct = gross.isZero() ? dec(0) : discount.div(gross);

        lines.push({
          variantId: variant.id,
          quantity: item.quantity,
          retailPrice: Number(item.price),
          discountPct: Number(discountPct),
        });
      }

      if (unknown.length > 0) {
        await raiseException({
          connectionId: connection.id,
          objectType: "order",
          externalId,
          reason: `Unrecognised SKU: ${unknown.join(", ")}. The order was not imported, because guessing which garment was meant would relieve the wrong stock.`,
          payload: order,
        });
        exceptions.push(`${order.name}: ${unknown.join(", ")}`);
        failed += 1;
        continue;
      }

      const customerId = order.customer
        ? await resolveCustomer(connection.id, order.customer)
        : null;

      const shipping = (order.shipping_lines ?? []).reduce(
        (s, l) => s.plus(dec(l.price)), dec(0),
      );

      const sale = await createSale(
        {
          source: "SHOPIFY",
          externalId,
          channelId: channel.id,
          entityId: brand.id,
          locationId: location.id,
          customerId,
          orderDate: new Date(order.created_at),
          city: order.shipping_address?.city ?? null,
          shippingAmount: Number(shipping),
          lines,
          // Website payment is confirmed by the gateway, not by us. It is
          // recorded as collected only when Shopify says it was paid.
          payments:
            order.financial_status === "paid"
              ? [
                  {
                    method: "CARD" as const,
                    amount: Number(
                      lines.reduce(
                        (s, l) =>
                          s.plus(
                            dec(l.retailPrice)
                              .times(dec(1).minus(dec(l.discountPct)))
                              .times(l.quantity),
                          ),
                        dec(0),
                      ).plus(shipping),
                    ),
                    fee: 0,
                    collected: true,
                  },
                ]
              : [],
        },
        ctx,
      );

      await db.externalMapping.create({
        data: {
          connectionId: connection.id,
          objectType: "order",
          externalId,
          internalId: sale.salesOrderId,
          externalRef: order.name,
        },
      });
      created += 1;
    } catch (error) {
      failed += 1;
      const reason =
        error instanceof SalesError || error instanceof ShopifyError
          ? error.message
          : "Unexpected error while importing.";
      errors.push({ externalId, reason });
      await raiseException({
        connectionId: connection.id,
        objectType: "order",
        externalId,
        reason,
        payload: order,
      });
    }
  }

  await db.syncLog.update({
    where: { id: log.id },
    data: {
      created, duplicates, failed,
      status: failed === 0 ? "SUCCESS" : created > 0 ? "PARTIAL" : "FAILED",
      errors: errors.length > 0 ? JSON.parse(JSON.stringify(errors)) : undefined,
      finishedAt: new Date(),
    },
  });

  await db.integrationConnection.update({
    where: { id: connection.id },
    data: {
      lastSyncedAt: new Date(),
      lastError: failed > 0 ? `${failed} order(s) could not be imported.` : null,
    },
  });

  await db.$transaction(async (tx) => {
    await writeAudit(tx, {
      action: "SHOPIFY_ORDERS_IMPORTED",
      entityName: "IntegrationConnection",
      entityId: connection.id,
      after: { processed: input.orders.length, created, duplicates, failed },
      ctx,
    });
  });

  return { created, duplicates, failed, exceptions };
}

/**
 * Finds or creates the customer behind a website order.
 *
 * Matched on the Shopify customer id first, then email — never on name, which
 * is not unique and would merge strangers.
 */
async function resolveCustomer(
  connectionId: string,
  shopper: NonNullable<ShopifyOrder["customer"]>,
): Promise<string | null> {
  const externalId = String(shopper.id);

  const mapped = await db.externalMapping.findUnique({
    where: {
      connectionId_objectType_externalId: { connectionId, objectType: "customer", externalId },
    },
  });
  if (mapped) return mapped.internalId;

  const email = shopper.email?.trim().toLowerCase() ?? null;
  const existing = email
    ? await db.customer.findFirst({ where: { emailNormalised: email, mergedIntoId: null } })
    : null;

  const name =
    [shopper.first_name, shopper.last_name].filter(Boolean).join(" ").trim() ||
    email ||
    `Shopify ${externalId}`;

  const customer =
    existing ??
    (await db.customer.create({
      data: {
        code: `SHOP-${externalId}`,
        name,
        email: shopper.email ?? null,
        phone: shopper.phone ?? null,
        emailNormalised: email,
        shopifyCustomerId: externalId,
        acquiredVia: "SHOPIFY",
      },
    }));

  await db.externalMapping.create({
    data: { connectionId, objectType: "customer", externalId, internalId: customer.id },
  });

  return customer.id;
}

/** Pulls recent orders from the shop and imports them. */
export async function pullOrders(
  input: { connectionId: string; sinceDays?: number },
  ctx: AuditContext,
) {
  const connection = await db.integrationConnection.findUniqueOrThrow({
    where: { id: input.connectionId },
  });

  const since = new Date(Date.now() - (input.sinceDays ?? 7) * 86_400_000);
  const data = await shopifyFetch<{ orders: ShopifyOrder[] }>(
    connection,
    `orders.json?status=any&updated_at_min=${since.toISOString()}&limit=250`,
  );

  return importOrders({ connectionId: connection.id, orders: data.orders }, ctx);
}

export type ShopifyCheckout = {
  id: number;
  token?: string;
  email?: string | null;
  phone?: string | null;
  created_at: string;
  updated_at?: string;
  total_price?: string;
  abandoned_checkout_url?: string | null;
  customer?: {
    id: number;
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
    phone?: string | null;
  } | null;
  billing_address?: { city?: string | null } | null;
  shipping_address?: { city?: string | null } | null;
  line_items?: {
    sku?: string | null;
    title?: string | null;
    quantity: number;
    price?: string;
  }[];
};

/**
 * Pulls baskets people filled and left.
 *
 * The single most useful marketing record the website produces: a named
 * person, the exact garments they wanted, and a link that puts the basket
 * back in front of them.
 *
 * A checkout that has since been paid for is not abandoned, so anything with
 * a matching later order is marked recovered rather than left on a list
 * somebody would otherwise chase.
 */
export async function pullAbandonedCheckouts(
  input: { connectionId: string; sinceDays?: number },
  ctx: AuditContext,
): Promise<{ imported: number; updated: number; recovered: number }> {
  const connection = await db.integrationConnection.findUniqueOrThrow({
    where: { id: input.connectionId },
  });

  const since = new Date(Date.now() - (input.sinceDays ?? 30) * 86_400_000);
  const data = await shopifyFetch<{ checkouts: ShopifyCheckout[] }>(
    connection,
    `checkouts.json?created_at_min=${since.toISOString()}&limit=250`,
  );

  return saveAbandonedCheckouts(
    { connectionId: connection.id, checkouts: data.checkouts ?? [] },
    ctx,
  );
}

/** Stores checkouts and works out which have since been bought. */
export async function saveAbandonedCheckouts(
  input: { connectionId: string; checkouts: ShopifyCheckout[] },
  ctx: AuditContext,
): Promise<{ imported: number; updated: number; recovered: number }> {
  let imported = 0;
  let updated = 0;
  let recovered = 0;

  for (const checkout of input.checkouts) {
    const externalId = String(checkout.id);
    const email = checkout.email ?? checkout.customer?.email ?? null;
    const phone = checkout.phone ?? checkout.customer?.phone ?? null;
    const normalisedEmail = email?.trim().toLowerCase() ?? null;

    const customer = normalisedEmail
      ? await db.customer.findFirst({
          where: { emailNormalised: normalisedEmail, mergedIntoId: null },
        })
      : null;

    // Somebody who checked out later is not a lost sale. Matching on the
    // shopper rather than the basket, because they often come back and buy
    // something slightly different.
    const laterOrder = customer
      ? await db.salesOrder.findFirst({
          where: {
            customerId: customer.id,
            orderDate: { gte: new Date(checkout.created_at) },
            status: { not: "CANCELLED" },
          },
          orderBy: { orderDate: "asc" },
        })
      : null;

    const record = {
      connectionId: input.connectionId,
      externalId,
      email,
      phone,
      customerName:
        [checkout.customer?.first_name, checkout.customer?.last_name]
          .filter(Boolean)
          .join(" ")
          .trim() || null,
      city: checkout.shipping_address?.city ?? checkout.billing_address?.city ?? null,
      customerId: customer?.id ?? null,
      totalValue: dec(checkout.total_price ?? "0").toString(),
      itemCount: (checkout.line_items ?? []).reduce((s, l) => s + l.quantity, 0),
      lineItems: JSON.parse(
        JSON.stringify(
          (checkout.line_items ?? []).map((l) => ({
            sku: l.sku ?? null,
            title: l.title ?? null,
            quantity: l.quantity,
            price: l.price ?? null,
          })),
        ),
      ),
      recoveryUrl: checkout.abandoned_checkout_url ?? null,
      abandonedAt: new Date(checkout.created_at),
      lastSeenAt: new Date(),
      recoveredOrderId: laterOrder?.id ?? null,
      recoveredAt: laterOrder ? laterOrder.orderDate : null,
    };

    const existing = await db.abandonedCheckout.findUnique({
      where: {
        connectionId_externalId: { connectionId: input.connectionId, externalId },
      },
    });

    await db.abandonedCheckout.upsert({
      where: {
        connectionId_externalId: { connectionId: input.connectionId, externalId },
      },
      create: record,
      // Whoever has already been contacted stays contacted; a refresh must not
      // reset that and cause somebody to be messaged twice.
      update: {
        ...record,
        contactedAt: existing?.contactedAt ?? null,
        contactedVia: existing?.contactedVia ?? null,
        contactNote: existing?.contactNote ?? null,
      },
    });

    if (existing) updated += 1;
    else imported += 1;
    if (laterOrder) recovered += 1;
  }

  await db.$transaction(async (tx) => {
    await writeAudit(tx, {
      action: "ABANDONED_CHECKOUTS_PULLED",
      entityName: "IntegrationConnection",
      entityId: input.connectionId,
      after: { processed: input.checkouts.length, imported, updated, recovered },
      ctx,
    });
  });

  return { imported, updated, recovered };
}

/**
 * The recovery list, worth chasing first.
 *
 * Consent is carried on every row. Someone who unsubscribed is still shown —
 * their basket is real and worth understanding — but marked, so nobody sends
 * them a message they asked not to receive.
 */
export async function recoveryList(options: { includeRecovered?: boolean } = {}) {
  const rows = await db.abandonedCheckout.findMany({
    where: options.includeRecovered ? {} : { recoveredOrderId: null },
    include: { customer: true },
    orderBy: [{ totalValue: "desc" }, { abandonedAt: "desc" }],
    take: 200,
  });

  return rows.map((r) => ({
    id: r.id,
    name: r.customerName ?? r.customer?.name ?? r.email ?? "—",
    email: r.email,
    phone: r.phone ?? r.customer?.phone ?? null,
    city: r.city,
    totalValue: dec(r.totalValue),
    itemCount: r.itemCount,
    items: (r.lineItems as { sku: string | null; title: string | null; quantity: number }[] | null) ?? [],
    recoveryUrl: r.recoveryUrl,
    abandonedAt: r.abandonedAt,
    daysAgo: Math.floor((Date.now() - r.abandonedAt.getTime()) / 86_400_000),
    recovered: Boolean(r.recoveredOrderId),
    contactedAt: r.contactedAt,
    contactedVia: r.contactedVia,
    // A known shopper is a warmer contact than a stranger, and their consent
    // decision is the one that governs whether they can be messaged at all.
    isKnownCustomer: Boolean(r.customerId),
    marketingConsent: r.customer?.marketingConsent ?? null,
    isSuppressed: r.customer?.isSuppressed ?? false,
  }));
}

/** Records that somebody has been followed up, so nobody chases them twice. */
export async function markContacted(
  input: { id: string; via: string; note?: string | null },
  ctx: AuditContext,
) {
  await db.$transaction(async (tx) => {
    const checkout = await tx.abandonedCheckout.update({
      where: { id: input.id },
      data: {
        contactedAt: new Date(),
        contactedVia: input.via,
        contactNote: input.note ?? null,
      },
    });
    await writeAudit(tx, {
      action: "ABANDONED_CHECKOUT_CONTACTED",
      entityName: "AbandonedCheckout",
      entityId: checkout.id,
      after: { via: input.via, value: checkout.totalValue.toString() },
      ctx,
    });
  });
}

/**
 * Reports what stock Shopify should be told about.
 *
 * Deliberately read-only for now: pushing quantities to a live shop can
 * oversell or hide stock, and that is not something to switch on without the
 * owner deciding. The figures are shown so the decision can be made on real
 * numbers.
 */
export async function inventoryToPublish(locationCode = "LOC-ALX") {
  const location = await db.location.findUniqueOrThrow({ where: { code: locationCode } });
  const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });

  const lots = await db.inventoryLot.findMany({
    where: {
      locationId: location.id,
      entityId: brand.id,
      state: "FINISHED_GOODS",
      remainingQty: { gt: 0 },
      variantId: { not: null },
    },
    include: { variant: { include: { style: true } } },
  });

  const byVariant = new Map<string, { sku: string; style: string; available: number; linked: boolean }>();
  for (const lot of lots) {
    const v = lot.variant!;
    const row = byVariant.get(v.id);
    if (row) {
      row.available += Number(lot.remainingQty);
      continue;
    }
    byVariant.set(v.id, {
      sku: v.sku,
      style: v.style.code,
      available: Number(lot.remainingQty),
      linked: Boolean(v.shopifyVariantId),
    });
  }

  return [...byVariant.values()].sort((a, b) => a.sku.localeCompare(b.sku));
}

/**
 * Tie each Shopify variant to the garment it is, by id.
 *
 * Shopify writes the SKU onto an order line at the moment the order is placed
 * and never revisits it. So a SKU corrected today does nothing for the orders
 * already taken — they carry the empty string they were born with, for ever.
 *
 * What they do carry is `variant_id`, which is stable and always present. This
 * records which local garment each Shopify variant is, matched by SKU while
 * the SKUs are readable, so the importer can fall back to the id when the SKU
 * on a line is missing or unrecognised.
 *
 * Idempotent, and matched only where the SKU is unambiguous: a mapping that
 * points at the wrong garment would relieve the wrong stock, which is not
 * recoverable by re-running anything.
 */
export async function syncVariantMappings(
  input: { connectionId: string },
  ctx: AuditContext,
): Promise<{ mapped: number; alreadyMapped: number; noMatch: number; noSku: number }> {
  const connection = await db.integrationConnection.findUniqueOrThrow({
    where: { id: input.connectionId },
  });

  type ShopifyVariant = { id: number; sku: string | null };
  type ShopifyProduct = { id: number; variants: ShopifyVariant[] };

  const variants: ShopifyVariant[] = [];
  let path = "products.json?status=active&limit=250&fields=id,variants";

  for (;;) {
    const url = `https://${connection.externalRef}/admin/api/${connection.apiVersion ?? API_VERSION}/${path}`;
    const res = await fetch(url, {
      headers: { "X-Shopify-Access-Token": connection.accessToken ?? "" },
    });
    if (!res.ok) {
      throw new ShopifyError(`Shopify returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    const body = (await res.json()) as { products: ShopifyProduct[] };
    for (const product of body.products) variants.push(...product.variants);

    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "");
    if (!next) break;
    path = next[1].split("/admin/api/")[1].split("/").slice(1).join("/");
  }

  let mapped = 0;
  let alreadyMapped = 0;
  let noMatch = 0;
  let noSku = 0;

  for (const variant of variants) {
    const sku = (variant.sku ?? "").trim().toUpperCase();
    if (!sku) {
      noSku += 1;
      continue;
    }

    const local = await db.variant.findUnique({ where: { sku } });
    if (!local) {
      noMatch += 1;
      continue;
    }

    const existing = await db.externalMapping.findUnique({
      where: {
        connectionId_objectType_externalId: {
          connectionId: connection.id,
          objectType: "variant",
          externalId: String(variant.id),
        },
      },
    });

    if (existing) {
      alreadyMapped += 1;
      continue;
    }

    await db.externalMapping.create({
      data: {
        connectionId: connection.id,
        objectType: "variant",
        externalId: String(variant.id),
        internalId: local.id,
        externalRef: sku,
      },
    });
    mapped += 1;
  }

  await writeAudit(db, {
    action: "SHOPIFY_VARIANTS_MAPPED",
    entityName: "IntegrationConnection",
    entityId: connection.id,
    ctx,
    after: { mapped, alreadyMapped, noMatch, noSku },
  });

  return { mapped, alreadyMapped, noMatch, noSku };
}
