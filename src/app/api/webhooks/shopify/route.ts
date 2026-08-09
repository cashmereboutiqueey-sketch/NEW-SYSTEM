import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyWebhookSignature, importOrders, type ShopifyOrder } from "@/lib/shopify";

/**
 * Shopify webhook receiver.
 *
 * Two rules govern this endpoint. Nothing unsigned is ever processed — a
 * forged payload would inject orders straight into the ledger. And Shopify
 * retries anything it does not get a 200 for within five seconds, so a
 * duplicate delivery must be harmless; it is, because the import is
 * idempotent on the external order id.
 */
export async function POST(request: NextRequest) {
  const shopDomain = request.headers.get("x-shopify-shop-domain");
  const hmac = request.headers.get("x-shopify-hmac-sha256");
  const topic = request.headers.get("x-shopify-topic");

  if (!shopDomain || !hmac) {
    return NextResponse.json({ error: "Missing Shopify headers." }, { status: 401 });
  }

  const connection = await db.integrationConnection.findFirst({
    where: { provider: "SHOPIFY", externalRef: shopDomain, isActive: true },
  });
  if (!connection?.webhookSecret) {
    // Deliberately the same response as a bad signature, so this endpoint
    // cannot be used to discover which shops are connected.
    return NextResponse.json({ error: "Unauthorised." }, { status: 401 });
  }

  // The raw body, byte for byte — re-serialising parsed JSON changes the
  // bytes and the signature would never match.
  const rawBody = await request.text();
  if (!verifyWebhookSignature(rawBody, hmac, connection.webhookSecret)) {
    return NextResponse.json({ error: "Unauthorised." }, { status: 401 });
  }

  let payload: ShopifyOrder;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Malformed payload." }, { status: 400 });
  }

  try {
    if (topic === "orders/create" || topic === "orders/updated" || topic === "orders/paid") {
      const result = await importOrders(
        { connectionId: connection.id, orders: [payload] },
        // No human triggered this, so the audit trail records the system.
        { userId: null, reason: `Shopify webhook: ${topic}` },
      );
      return NextResponse.json({ ok: true, ...result });
    }

    // An unhandled topic is acknowledged rather than retried forever.
    return NextResponse.json({ ok: true, ignored: topic });
  } catch (error) {
    console.error("Shopify webhook failed:", error);
    // A 500 tells Shopify to retry, which is what we want for a transient
    // failure — the import is idempotent, so a repeat is safe.
    return NextResponse.json({ error: "Processing failed." }, { status: 500 });
  }
}
