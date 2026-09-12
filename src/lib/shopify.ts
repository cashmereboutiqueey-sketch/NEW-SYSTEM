import "server-only";
import crypto from "node:crypto";
import { db, inTransaction } from "./db";
import { createSale, SalesError } from "./sales";
import { writeAudit, type AuditContext } from "./audit";
import { dec } from "./money";
import { postEntry } from "./ledger";
import { command } from "./command";
import { outstandingOnOrder } from "./receivables";
import { recordReturn, returnableLines, ReturnError } from "./returns";
import { isShopDomain, isApiVersion } from "@/core/shopify-domain";
import { openSecret } from "./secrets";

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

/**
 * The Admin API version asked for.
 *
 * Shopify supports each dated version for about a year and quietly serves the
 * oldest supported one to anybody asking for a version past its end — so a
 * stale constant does not fail, it just changes what the shop answers with.
 * 2024-10 went out of support in 2025; 2026-04 is supported into April 2027.
 * What Shopify actually served is recorded on the connection (see
 * `servedApiVersion`), so the next time this falls behind it shows.
 */
const API_VERSION = "2026-04";

/** Long enough for a busy shop; short enough not to hold a request hostage. */
const REQUEST_TIMEOUT_MS = 20_000;

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

type ShopifyConnection = {
  /** When known, the version Shopify answers with is recorded against it. */
  id?: string;
  externalRef: string;
  accessToken: string | null;
  apiVersion: string | null;
};

/**
 * The one door every request to Shopify goes through.
 *
 * It carries the access token, so it is also where the token's destination
 * is decided. The domain is checked here rather than trusted from the form
 * that saved it: a stored value from before the check existed, or one written
 * some other way, must not be able to send the token anywhere but a shop.
 *
 * Redirects are refused rather than followed. Fetch keeps custom headers
 * across a redirect, even to another host, so following one would hand the
 * token to wherever the redirect pointed.
 */
async function shopifyRequest(
  connection: ShopifyConnection,
  path: string,
  init?: { method: "POST"; body: unknown },
): Promise<Response> {
  // Stored sealed; opened only here, for the request that needs it.
  const accessToken = openSecret(connection.accessToken);
  if (!accessToken) {
    throw new ShopifyError("This shop has no access token configured.");
  }
  if (!isShopDomain(connection.externalRef)) {
    throw new ShopifyError(
      `${JSON.stringify(connection.externalRef)} is not a Shopify shop domain. ` +
        `Reconnect the shop with its .myshopify.com address.`,
    );
  }
  const version = connection.apiVersion ?? API_VERSION;
  if (!isApiVersion(version)) {
    throw new ShopifyError(`${JSON.stringify(version)} is not a Shopify API version.`);
  }

  const url = new URL(`https://${connection.externalRef}/admin/api/${version}/${path}`);
  if (url.hostname !== connection.externalRef) {
    // Unreachable while the domain check above holds. Kept because the cost
    // of being wrong about that is a leaked token.
    throw new ShopifyError(`Refusing to send the access token to ${url.hostname}.`);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: init?.method ?? "GET",
      redirect: "manual",
      // A shop that never answers must not hold a server worker for ever.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      ...(init ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (error) {
    if ((error as { name?: string })?.name === "TimeoutError") {
      throw new ShopifyError(
        `${connection.externalRef} did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds. Try again shortly.`,
      );
    }
    throw error;
  }

  // What Shopify actually served. Kept only when it differs from what was
  // asked for, which is the one case anybody needs to hear about.
  const served = response.headers.get("x-shopify-api-version");
  if (connection.id && served && served !== version) {
    await db.integrationConnection.updateMany({
      where: { id: connection.id, NOT: { servedApiVersion: served } },
      data: { servedApiVersion: served },
    });
  }

  if (response.status >= 300 && response.status < 400) {
    throw new ShopifyError(
      `${connection.externalRef} answered with a redirect${
        response.headers.get("location") ? ` to ${response.headers.get("location")}` : ""
      }. It was not followed, because the access token would have gone with it. ` +
        `If the shop's domain has changed, reconnect it with the new one.`,
    );
  }
  if (response.status === 429) {
    // Shopify's leaky bucket. Surfacing it plainly lets the caller back off
    // rather than hammering the shop and getting throttled harder.
    throw new ShopifyError("Shopify is rate limiting this shop. Try again shortly.");
  }
  // A 404 from the Admin API almost never means the path is wrong — those are
  // fixed strings in this file. It means no store answered at that domain, and
  // Shopify's DNS resolves every *.myshopify.com name whether a shop occupies
  // it or not, so a wrong domain fails here rather than at connect time.
  if (response.status === 404) {
    throw new ShopifyError(
      `No Shopify store answered at ${connection.externalRef}. ` +
        `That is the shop's internal domain, which is usually not the brand ` +
        `name — find it in Shopify under Settings → Domains.`,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new ShopifyError(
      `${connection.externalRef} rejected the access token. It may have been ` +
        `revoked, or it may lack the scopes this needs.`,
    );
  }
  if (!response.ok) {
    throw new ShopifyError(
      `Shopify returned ${response.status}: ${(await response.text()).slice(0, 200)}`,
    );
  }
  return response;
}

async function shopifyFetch<T>(
  connection: ShopifyConnection,
  path: string,
  init?: { method: "POST"; body: unknown },
): Promise<T> {
  const response = await shopifyRequest(connection, path, init);
  return response.json() as Promise<T>;
}

/**
 * Asks a shop who it is, to prove a domain and token work together.
 *
 * Called before a connection is saved. Storing credentials first and finding
 * out later is how a shop comes to be listed as connected while every sync
 * fails — the screen says one thing and the truth only appears at the moment
 * somebody needed it to work.
 */
export async function verifyShopConnection(input: {
  externalRef: string;
  accessToken: string | null;
  apiVersion: string | null;
}): Promise<{ name: string; domain: string; currency: string }> {
  const { shop } = await shopifyFetch<{
    shop: { name: string; domain: string; currency: string };
  }>(input, "shop.json");
  return shop;
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
  input: {
    connectionId: string;
    orders: ShopifyOrder[];
    /**
     * Throw on a failure that is not about the order itself — the database
     * unavailable, a conflict that ran out of retries — instead of filing it
     * as an exception. A webhook wants that: a thrown error answers Shopify
     * with a 500 and it delivers again, which a filed exception never gets.
     */
    throwUnexpected?: boolean;
  },
  ctx: AuditContext,
): Promise<{
  created: number;
  /** Already imported orders whose payment or cancellation was applied. */
  updated: number;
  duplicates: number;
  failed: number;
  exceptions: string[];
}> {
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
  let updated = 0;
  let duplicates = 0;
  let failed = 0;
  const exceptions: string[] = [];
  const errors: { externalId: string; reason: string }[] = [];

  for (const order of input.orders) {
    const externalId = String(order.id);

    try {
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
        // Already imported. That used to end it — so the "paid" that follows
        // a pending order, or a cancellation, never reached the books. The
        // order's news is applied instead; a plain repeat changes nothing.
        const outcome = await applyOrderUpdate(connection.id, order, mapped.internalId, ctx);
        if (outcome === "UNCHANGED") duplicates += 1;
        else updated += 1;
        continue;
      }

      if (order.cancelled_at) {
        // Cancelled before it ever reached us: recorded, not imported, since
        // importing then reversing would move stock that never left.
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

        // Shopify can list one garment on two lines. On the same terms they are
        // one line here: a sale line is identified by its garment, and two
        // lines for one garment would let each claim the other's FIFO cost.
        // On different terms they stay apart and the sale refuses them, which
        // raises an exception rather than guessing which price was meant.
        const same = lines.find(
          (l) =>
            l.variantId === variant.id &&
            l.retailPrice === Number(item.price) &&
            l.discountPct === Number(discountPct),
        );
        if (same) {
          same.quantity += item.quantity;
          continue;
        }

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
      const expected =
        error instanceof SalesError ||
        error instanceof ShopifyError ||
        error instanceof ReturnError;
      if (!expected && input.throwUnexpected) throw error;
      failed += 1;
      const reason = expected ? (error as Error).message : "Unexpected error while importing.";
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
      after: { processed: input.orders.length, created, updated, duplicates, failed },
      ctx,
    });
  });

  return { created, updated, duplicates, failed, exceptions };
}

const ORDER_TOPICS = new Set(["orders/create", "orders/updated", "orders/paid", "orders/cancelled"]);

/**
 * Takes a signed delivery in: records it, then acts on it.
 *
 * The record comes first and is keyed by Shopify's own delivery id, so the
 * same delivery arriving again is recognised and answered without doing
 * anything twice. A delivery that fails is left FAILED with its reason and
 * payload, and the error is thrown so Shopify is told to deliver again —
 * and if its retries run out, it is still here to replay.
 */
export async function receiveWebhook(input: {
  connectionId: string;
  webhookId: string;
  topic: string;
  payload: unknown;
}): Promise<{ duplicate: boolean; ignored?: boolean }> {
  const existing = await db.shopifyWebhookEvent.findUnique({ where: { webhookId: input.webhookId } });
  if (existing?.status === "PROCESSED") return { duplicate: true };

  const event =
    existing ??
    (await db.shopifyWebhookEvent.create({
      data: {
        connectionId: input.connectionId,
        webhookId: input.webhookId,
        topic: input.topic,
        payload: JSON.parse(JSON.stringify(input.payload ?? null)),
      },
    }));

  await processWebhookEvent(event.id);
  return { duplicate: false, ignored: !ORDER_TOPICS.has(input.topic) };
}

/** Acts on one recorded delivery, marking how it went. Throws if it failed. */
async function processWebhookEvent(eventId: string): Promise<void> {
  const event = await db.shopifyWebhookEvent.update({
    where: { id: eventId },
    data: { attempts: { increment: 1 } },
  });
  try {
    if (ORDER_TOPICS.has(event.topic)) {
      await importOrders(
        {
          connectionId: event.connectionId,
          orders: [event.payload as unknown as ShopifyOrder],
          throwUnexpected: true,
        },
        // No human triggered this, so the audit trail records the system.
        { userId: null, reason: `Shopify webhook: ${event.topic}` },
      );
    }
    await db.shopifyWebhookEvent.update({
      where: { id: event.id },
      data: { status: "PROCESSED", processedAt: new Date(), lastError: null },
    });
  } catch (error) {
    await db.shopifyWebhookEvent.update({
      where: { id: event.id },
      data: { status: "FAILED", lastError: String((error as Error)?.message ?? error).slice(0, 1000) },
    });
    throw error;
  }
}

/**
 * How many times a delivery is retried before it waits for a person.
 *
 * Most failures are transient — the database was busy, the till was mid-sale.
 * A few are not: a garment whose SKU nothing here recognises will fail every
 * time, and retrying it for ever hides it among the noise instead of putting
 * it in front of somebody.
 */
const MAX_WEBHOOK_ATTEMPTS = 6;

/**
 * Tries the failed deliveries again, unattended.
 *
 * Without this, an order that arrived while the database was restarting sat
 * in the inbox until somebody happened to open the integrations screen and
 * press replay — which is to say, until somebody noticed a sale was missing.
 */
export async function retryFailedWebhooks(limit = 20): Promise<{
  tried: number;
  recovered: number;
}> {
  const due = await db.shopifyWebhookEvent.findMany({
    where: { status: "FAILED", attempts: { lt: MAX_WEBHOOK_ATTEMPTS } },
    orderBy: { receivedAt: "asc" },
    take: limit,
    select: { id: true },
  });

  let recovered = 0;
  for (const event of due) {
    try {
      await processWebhookEvent(event.id);
      recovered += 1;
    } catch {
      // processWebhookEvent has already recorded why on the event itself.
      // One delivery that will not go through must not stop the others.
    }
  }
  return { tried: due.length, recovered };
}

/** Deliveries that could not be processed, for a person to replay. */
export async function failedWebhookEvents(limit = 50) {
  return db.shopifyWebhookEvent.findMany({
    where: { status: "FAILED" },
    orderBy: { receivedAt: "asc" },
    take: limit,
    select: { id: true, topic: true, attempts: true, lastError: true, receivedAt: true },
  });
}

/** Tries a failed delivery again, exactly as it arrived. */
export async function replayWebhookEvent(eventId: string): Promise<void> {
  const event = await db.shopifyWebhookEvent.findUnique({ where: { id: eventId } });
  if (!event) throw new ShopifyError("That delivery is no longer recorded.");
  if (event.status === "PROCESSED") return;
  await processWebhookEvent(event.id);
}

/**
 * Applies what Shopify now says about an order already imported.
 *
 *   paid       the money this order was waiting on is recorded as collected:
 *              DR bank, CR the receivable the unpaid import left behind.
 *   cancelled  every garment still on the order comes back as a return, so
 *              stock, revenue and cost of sales all reverse through the one
 *              path that already knows how — refunded to the card if it was
 *              paid for, set against the open balance if it was not.
 *   refunded   raised for a person, not applied: Shopify says money went back
 *              but not which garments, if any, came back, and guessing would
 *              restock the wrong thing.
 *
 * Each is idempotent — an order already settled, already reversed or already
 * raised is left alone — because Shopify delivers more than once and in any
 * order.
 */
async function applyOrderUpdate(
  connectionId: string,
  order: ShopifyOrder,
  salesOrderId: string,
  ctx: AuditContext,
): Promise<"UPDATED" | "UNCHANGED"> {
  const externalId = String(order.id);

  if (order.cancelled_at) {
    return command<"UPDATED" | "UNCHANGED">("shopify.cancelOrder", { salesOrderId, cancelledAt: order.cancelled_at }, ctx, async () => {
      let changed = false;
      for (const line of (await returnableLines(salesOrderId)).lines) {
        if (line.returnable <= 0) continue;
        // Re-read each time: the first line's credit changes what is owed.
        const picture = await returnableLines(salesOrderId);
        const owed = dec(picture.order.outstanding);
        const value = dec(line.unitPrice).times(line.returnable);
        await recordReturn(
          {
            salesOrderId,
            variantId: line.variantId,
            quantity: line.returnable,
            disposition: "RESTOCK",
            refundMethod: owed.greaterThanOrEqualTo(value) ? "AGAINST_BALANCE" : "CARD",
            reason: `Cancelled on Shopify (${order.name})`,
            returnDate: new Date(order.cancelled_at!),
          },
          ctx,
        );
        changed = true;
      }
      return changed ? ("UPDATED" as const) : ("UNCHANGED" as const);
    });
  }

  if (order.financial_status === "paid") {
    return command("shopify.markPaid", { salesOrderId }, ctx, async (): Promise<"UPDATED" | "UNCHANGED"> => {
      const sale = await db.salesOrder.findUniqueOrThrow({
        where: { id: salesOrderId },
        include: { payments: { select: { amount: true } } },
      });
      const owed = outstandingOnOrder(sale);
      if (owed.lessThanOrEqualTo(0)) return "UNCHANGED";
      if (!sale.entityId) throw new ShopifyError(`${sale.orderNumber} is not attached to a company.`);
      const entityId = sale.entityId;

      return db.$transaction(async (tx): Promise<"UPDATED"> => {
        await tx.salesPayment.create({
          data: {
            salesOrderId,
            method: "CARD",
            amount: owed.toString(),
            fee: "0",
            status: "COLLECTED",
            collectedAt: new Date(),
            reference: `Shopify ${order.name} paid`,
          },
        });
        const account = async (code: string) =>
          (await tx.account.findUniqueOrThrow({ where: { code }, select: { id: true } })).id;
        await postEntry(tx, {
          entityId,
          postingDate: new Date(),
          sourceType: "PAYMENT",
          sourceId: salesOrderId,
          memo: `Shopify payment for ${sale.orderNumber} (${order.name})`,
          ctx,
          lines: [
            { accountId: await account("1120"), debit: owed, entityId, customerId: sale.customerId, description: `Paid on Shopify ${order.name}` },
            { accountId: await account("1210"), credit: owed, entityId, customerId: sale.customerId, description: `Settles ${sale.orderNumber}` },
          ],
        });
        await tx.salesOrder.update({
          where: { id: salesOrderId },
          data: { collectedDate: new Date(), dueDate: null },
        });
        await writeAudit(tx, {
          action: "SHOPIFY_ORDER_PAID",
          entityName: "SalesOrder",
          entityId: salesOrderId,
          after: { externalId, amount: owed.toString() },
          ctx,
        });
        return "UPDATED";
      });
    });
  }

  if (order.financial_status === "refunded" || order.financial_status === "partially_refunded") {
    const reason = `Refunded on Shopify (${order.financial_status.replace("_", " ")}). Record the return here so stock and money follow it.`;
    const raised = await db.integrationException.findFirst({
      where: { connectionId, objectType: "order", externalId, reason },
    });
    if (raised) return "UNCHANGED";
    await raiseException({ connectionId, objectType: "order", externalId, reason, payload: order });
    return "UPDATED";
  }

  return "UNCHANGED";
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
  // Every page, not the first 250: a recovery pull after an outage is exactly
  // when there are more than 250, and the rest used to be silently left out.
  const orders = await shopifyFetchAll<ShopifyOrder>(
    connection,
    `orders.json?status=any&updated_at_min=${since.toISOString()}&limit=250`,
    "orders",
  );

  return importOrders({ connectionId: connection.id, orders }, ctx);
}

/**
 * Every page of a list, following Shopify's cursor links.
 *
 * The next page's address comes back in the Link header. Only its path is
 * used; the host is always the connection's own, so a link cannot send the
 * token anywhere else.
 */
async function shopifyFetchAll<T>(
  connection: ShopifyConnection,
  firstPath: string,
  key: string,
  maxPages = 200,
): Promise<T[]> {
  const all: T[] = [];
  let path: string | null = firstPath;
  for (let page = 0; path && page < maxPages; page++) {
    const res = await shopifyRequest(connection, path);
    const body = (await res.json()) as Record<string, T[] | undefined>;
    all.push(...(body[key] ?? []));
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "");
    path = next ? next[1].split("/admin/api/")[1].split("/").slice(1).join("/") : null;
  }
  if (path) {
    throw new ShopifyError(
      `Stopped after ${maxPages} pages of ${key}. Pull a shorter period so nothing is left out unnoticed.`,
    );
  }
  return all;
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
  const checkouts = await shopifyFetchAll<ShopifyCheckout>(
    connection,
    `checkouts.json?created_at_min=${since.toISOString()}&limit=250`,
    "checkouts",
  );

  return saveAbandonedCheckouts(
    { connectionId: connection.id, checkouts },
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

  // Whether a garment is tied to the website is recorded in externalMapping,
  // which is what the order importer and the inventory publisher both read.
  // This used to ask variant.shopifyVariantId, a column nothing has ever
  // written, so every garment reported itself unlinked and the count of
  // unlinked SKUs was simply the total.
  const connection = await db.integrationConnection.findFirst({
    where: { provider: "SHOPIFY", isActive: true },
    select: { id: true },
  });
  const linkedLocalIds = new Set(
    connection
      ? (
          await db.externalMapping.findMany({
            where: { connectionId: connection.id, objectType: "variant" },
            select: { internalId: true },
          })
        ).map((m) => m.internalId)
      : [],
  );

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
      linked: linkedLocalIds.has(v.id),
    });
  }

  return [...byVariant.values()].sort((a, b) => a.sku.localeCompare(b.sku));
}

/**
 * Writes what the factory actually holds onto the website.
 *
 * Stock moves in both systems and, until this existed, only one direction was
 * ever reported. A website order reached the ledger through the webhook, but a
 * sale over the counter, at an exhibition, or a production run finishing fifty
 * pieces changed the ERP and told Shopify nothing. So the website went on
 * selling garments that had already left the building, and went on hiding
 * garments that had just been made. The second is the quieter loss: an
 * oversell produces a complaint, and an invisible garment produces silence.
 *
 * This reconciles rather than reacting to events. It reads what is really on
 * the shelf, reads what Shopify believes, and writes only where they differ.
 *
 * Deliberately not called from inside the sale or production transactions. A
 * write to Shopify inside a database transaction couples the ledger to
 * somebody else's uptime: a slow reply holds a row lock, and a failed one
 * would either roll back a sale that genuinely happened or leave the two
 * disagreed with no record of which way. Reconciling afterwards cannot lose a
 * movement, because it never asks what changed. It asks what is true now, and
 * is therefore safe to run at any time, twice, or after a crash.
 *
 * Zero is pushed like any other number. A garment with none left must be
 * written down to nothing, or it stays for sale for ever, which is the exact
 * failure this exists to prevent.
 */
export async function publishInventory(
  input: { connectionId: string; locationCode?: string; dryRun?: boolean },
  ctx: AuditContext,
): Promise<{
  checked: number;
  pushed: number;
  unchanged: number;
  unlinked: number;
  failed: number;
  changes: { sku: string; from: number | null; to: number }[];
}> {
  const connection = await db.integrationConnection.findUniqueOrThrow({
    where: { id: input.connectionId },
  });

  // ---- where Shopify keeps its stock -------------------------------------
  // Resolved rather than configured. A shop with one active location has only
  // one possible answer, and asking an operator to paste an id they cannot
  // check by eye is how a wrong domain goes unnoticed.
  const { locations } = await shopifyFetch<{
    locations: { id: number; name: string; active: boolean }[];
  }>(connection, "locations.json");

  const active = locations.filter((l) => l.active);
  if (active.length === 0) {
    throw new ShopifyError("This Shopify store has no active location to stock.");
  }
  if (active.length > 1) {
    throw new ShopifyError(
      `This Shopify store has ${active.length} active locations (` +
        `${active.map((l) => l.name).join(", ")}). Publishing would have to ` +
        `choose one, and choosing wrongly would empty the other.`,
    );
  }
  const shopLocationId = active[0].id;

  // ---- what the factory actually holds -----------------------------------
  const location = await db.location.findUniqueOrThrow({
    where: { code: input.locationCode ?? "LOC-ALX" },
  });
  const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });

  const lots = await db.inventoryLot.findMany({
    where: {
      locationId: location.id,
      entityId: brand.id,
      state: "FINISHED_GOODS",
      variantId: { not: null },
    },
    select: { variantId: true, remainingQty: true },
  });

  const onHand = new Map<string, number>();
  for (const lot of lots) {
    onHand.set(lot.variantId!, (onHand.get(lot.variantId!) ?? 0) + Number(lot.remainingQty));
  }

  // ---- which Shopify variant is which garment ----------------------------
  const links = await db.externalMapping.findMany({
    where: { connectionId: connection.id, objectType: "variant" },
    select: { externalId: true, internalId: true },
  });
  const localByShopifyVariant = new Map(links.map((l) => [l.externalId, l.internalId]));

  // The catalogue, for inventory_item_id — Shopify's own handle for a thing
  // Shopify owns. Fetched rather than stored, because a copy kept here would
  // be one more field that can quietly stop being true.
  type ShopVariant = { id: number; sku: string | null; inventory_item_id: number };
  const shopVariants: ShopVariant[] = [];
  let path = "products.json?status=active&limit=250&fields=id,variants";

  for (;;) {
    const res = await shopifyRequest(connection, path);
    const body = (await res.json()) as { products: { variants: ShopVariant[] }[] };
    for (const product of body.products) shopVariants.push(...product.variants);

    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "");
    if (!next) break;
    path = next[1].split("/admin/api/")[1].split("/").slice(1).join("/");
  }

  const targets: { sku: string; inventoryItemId: number; want: number }[] = [];
  let unlinked = 0;

  for (const sv of shopVariants) {
    const localId = localByShopifyVariant.get(String(sv.id));
    if (!localId) {
      // Not mapped to a garment here, so left entirely alone. Writing a level
      // for something this system does not know about would be an invention,
      // and zero is the most damaging invention available.
      unlinked += 1;
      continue;
    }
    targets.push({
      sku: sv.sku?.trim() || String(sv.id),
      inventoryItemId: sv.inventory_item_id,
      want: onHand.get(localId) ?? 0,
    });
  }

  // ---- what Shopify believes today ---------------------------------------
  const believed = new Map<number, number>();
  for (let i = 0; i < targets.length; i += 50) {
    const batch = targets.slice(i, i + 50);
    const { inventory_levels } = await shopifyFetch<{
      inventory_levels: { inventory_item_id: number; available: number | null }[];
    }>(
      connection,
      `inventory_levels.json?location_ids=${shopLocationId}` +
        `&inventory_item_ids=${batch.map((t) => t.inventoryItemId).join(",")}&limit=250`,
    );
    for (const level of inventory_levels) {
      believed.set(level.inventory_item_id, level.available ?? 0);
    }
  }

  // ---- write only the differences ----------------------------------------
  const log = await db.syncLog.create({
    data: {
      connectionId: connection.id,
      objectType: "inventory",
      direction: "OUTBOUND",
      status: "SUCCESS",
      processed: targets.length,
    },
  });

  const changes: { sku: string; from: number | null; to: number }[] = [];
  const errors: { externalId: string; reason: string }[] = [];
  let pushed = 0;
  let unchanged = 0;
  let failed = 0;

  for (const target of targets) {
    const now = believed.has(target.inventoryItemId)
      ? believed.get(target.inventoryItemId)!
      : null;

    if (now === target.want) {
      unchanged += 1;
      continue;
    }

    changes.push({ sku: target.sku, from: now, to: target.want });
    // A dry run reports every difference and writes none, so the first run
    // against a live shop can be read before it is trusted.
    if (input.dryRun) continue;

    try {
      await shopifyFetch(connection, "inventory_levels/set.json", {
        method: "POST",
        body: {
          location_id: shopLocationId,
          inventory_item_id: target.inventoryItemId,
          available: target.want,
        },
      });
      pushed += 1;
    } catch (error) {
      // One garment failing must not abandon the rest: the others are still
      // wrong, and leaving them wrong to preserve a tidy error is worse.
      failed += 1;
      errors.push({
        externalId: target.sku,
        reason:
          error instanceof ShopifyError
            ? error.message
            : "Unexpected error while publishing.",
      });
    }
  }

  // What the run did is recorded with the audit of it, in one transaction: the
  // pushing itself happened over the network above and cannot be in one.
  await inTransaction(async () => {
    await db.syncLog.update({
      where: { id: log.id },
      data: {
        created: pushed,
        duplicates: unchanged,
        failed,
        status: failed === 0 ? "SUCCESS" : pushed > 0 ? "PARTIAL" : "FAILED",
        errors: errors.length > 0 ? JSON.parse(JSON.stringify(errors)) : undefined,
        finishedAt: new Date(),
      },
    });

    await writeAudit(db, {
      action: "SHOPIFY_INVENTORY_PUBLISHED",
      entityName: "IntegrationConnection",
      entityId: connection.id,
      ctx,
      after: {
        checked: targets.length,
        pushed,
        unchanged,
        unlinked,
        failed,
        dryRun: Boolean(input.dryRun),
      },
    });
  });

  return { checked: targets.length, pushed, unchanged, unlinked, failed, changes };
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
    const res = await shopifyRequest(connection, path);
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

  // The mappings and the audit of them commit together, after the fetching:
  // a half-written mapping table points some garments at the wrong variant.
  await inTransaction(async () => {
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
  });

  return { mapped, alreadyMapped, noMatch, noSku };
}
