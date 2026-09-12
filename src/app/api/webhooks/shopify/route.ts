import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyWebhookSignature, receiveWebhook } from "@/lib/shopify";
import { openSecret } from "@/lib/secrets";

/**
 * Shopify webhook receiver.
 *
 * Nothing unsigned is ever processed — a forged payload would inject orders
 * straight into the ledger. Every signed delivery is recorded under its own
 * delivery id before anything is done with it (see `receiveWebhook`), so a
 * repeat is answered without effect, an order's later news — paid, cancelled
 * — is applied rather than skipped, and a delivery that fails is kept to be
 * replayed instead of being lost when the request ends.
 */
export async function POST(request: NextRequest) {
  const shopDomain = request.headers.get("x-shopify-shop-domain");
  const hmac = request.headers.get("x-shopify-hmac-sha256");
  const topic = request.headers.get("x-shopify-topic") ?? "unknown";

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
  if (!verifyWebhookSignature(rawBody, hmac, openSecret(connection.webhookSecret) ?? "")) {
    return NextResponse.json({ error: "Unauthorised." }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Malformed payload." }, { status: 400 });
  }

  // Shopify's id for this delivery, the same on every retry of it. A signed
  // body without one is keyed by its own contents, which is what makes a
  // repeat recognisable.
  const webhookId =
    request.headers.get("x-shopify-webhook-id") ??
    `sha256:${crypto.createHash("sha256").update(`${topic}\n${rawBody}`).digest("hex")}`;

  try {
    const result = await receiveWebhook({ connectionId: connection.id, webhookId, topic, payload });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("Shopify webhook failed:", error);
    // A 500 tells Shopify to deliver again. The delivery is recorded as
    // failed either way, so it can be replayed if the retries run out.
    return NextResponse.json({ error: "Processing failed." }, { status: 500 });
  }
}
