/**
 * Connect a Shopify store and prove the connection works.
 *
 * The token is read from the environment and never written to a file, an
 * argument, or the audit trail — the trail records that a token was set, not
 * what it is. It lands in `integration_connections.accessToken` because that
 * is where the application looks for it.
 *
 *   SHOPIFY_SHOP=xxx.myshopify.com SHOPIFY_TOKEN=shpat_... \
 *     npx tsx --conditions=react-server scripts/connect-shopify.ts
 *
 * Add --pull to import the orders it finds after connecting.
 */
import "dotenv/config";
import { db } from "../src/lib/db";

const shop = process.env.SHOPIFY_SHOP?.trim().toLowerCase();
const token = process.env.SHOPIFY_TOKEN?.trim();
const shouldPull = process.argv.includes("--pull");

if (!shop || !token) {
  console.error("Set SHOPIFY_SHOP and SHOPIFY_TOKEN in the environment.");
  process.exit(1);
}
if (!shop.endsWith(".myshopify.com")) {
  console.error("SHOPIFY_SHOP must be the .myshopify.com domain, not the public one.");
  process.exit(1);
}

const API = "2024-10";

async function admin<T>(path: string): Promise<T> {
  const res = await fetch(`https://${shop}/admin/api/${API}/${path}`, {
    headers: { "X-Shopify-Access-Token": token!, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

/* ─────────────────────────── 1. does the token work ─────────────────────── */

console.log(`── ${shop}`);

const { shop: info } = await admin<{ shop: Record<string, unknown> }>("shop.json");
console.log(`   ✓ reachable: ${info.name}, ${info.currency}, ${info.country_name}`);

if (info.currency !== "EGP") {
  console.log(
    `   ! the store trades in ${info.currency} and this system's books are in EGP — ` +
      "imported orders would carry a number that means something different",
  );
}

/* ───────────────────────────── 2. what it can see ───────────────────────── */

const scopes = await admin<{ access_scopes: { handle: string }[] }>(
  "../oauth/access_scopes.json",
).catch(() => null);

/** What the importer actually calls. Anything beyond this is unnecessary risk. */
const NEEDED = ["read_orders", "read_customers", "read_products", "read_inventory"];

if (scopes) {
  const held = new Set(scopes.access_scopes.map((s) => s.handle));
  const missing = NEEDED.filter((s) => !held.has(s));
  const writes = [...held].filter((s) => s.startsWith("write_"));

  if (missing.length === 0) console.log(`   ✓ has all ${NEEDED.length} scopes the importer needs`);
  else console.log(`   ✗ missing: ${missing.join(", ")}`);

  console.log(`   • holds ${held.size} scopes in total, ${writes.length} of them write access`);
  if (writes.length > 0) {
    // A token that can do more than the job is a token whose leak costs more
    // than it had to.
    console.log(
      "     this integration only reads. A token that can also write is a larger blast radius",
    );
  }
}

/* ─────────────────────────── 3. is there anything there ─────────────────── */

const counts = await admin<{ count: number }>("orders/count.json?status=any").catch(() => null);
const products = await admin<{ count: number }>("products/count.json").catch(() => null);
const customers = await admin<{ count: number }>("customers/count.json").catch(() => null);

console.log(
  `   • ${counts?.count ?? "?"} order(s), ${products?.count ?? "?"} product(s), ` +
    `${customers?.count ?? "?"} customer(s) in the store`,
);

/* ──────────────────────────── 4. record the connection ──────────────────── */

const owner = await db.user.findFirstOrThrow({ where: { role: "OWNER" } });

const connection = await db.integrationConnection.upsert({
  where: { provider_externalRef: { provider: "SHOPIFY", externalRef: shop } },
  update: { accessToken: token, apiVersion: API, isActive: true, lastError: null },
  create: {
    provider: "SHOPIFY",
    externalRef: shop,
    displayName: String(info.name ?? shop),
    accessToken: token,
    apiVersion: API,
  },
});

// Recorded without the token, deliberately: the trail says a token was set,
// never what it was.
await db.auditLog.create({
  data: {
    userId: owner.id,
    action: "SHOPIFY_CONNECTED",
    entityName: "IntegrationConnection",
    entityId: connection.id,
    after: { shop, hasToken: true, apiVersion: API },
  },
});

console.log(`   ✓ connection saved (${connection.id})`);

/* ───────────────────────────── 5. optionally import ─────────────────────── */

if (shouldPull) {
  const { pullOrders } = await import("../src/lib/shopify");
  console.log("\n── importing orders");
  const result = await pullOrders(
    { connectionId: connection.id },
    { userId: owner.id, reason: null },
  );
  console.log(
    `   ${result.created} created, ${result.duplicates} already had, ${result.failed} failed`,
  );
  if (result.exceptions.length) {
    console.log("   things a person has to look at:");
    for (const e of result.exceptions.slice(0, 10)) console.log(`     ${e}`);
  }
} else {
  console.log("\n   run again with --pull to import the orders");
}

await db.$disconnect();
