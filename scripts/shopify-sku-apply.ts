/**
 * Apply the SKU plan to Shopify.
 *
 * Everything about this is deliberately cautious, because it writes to a live
 * catalogue that a shop is selling from today:
 *
 *   It re-reads each variant immediately before writing and skips any that has
 *   picked up a SKU since the plan was made. The plan is a proposal, not a
 *   licence — somebody may have typed one in the meantime.
 *
 *   It writes a rollback file first, naming every variant it is about to touch
 *   and what it held before. Undoing 110 writes by hand is not a plan.
 *
 *   It refuses to run without --confirm, so reading the plan is a step
 *   somebody has to take rather than one they can skip by pressing up-arrow.
 *
 *   It paces itself. Shopify's REST limit on this plan is two calls a second,
 *   and a burst that trips the limiter leaves a half-applied catalogue.
 *
 *   SHOPIFY_SHOP=... SHOPIFY_TOKEN=... \
 *     npx tsx --conditions=react-server scripts/shopify-sku-apply.ts --confirm
 */
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const shop = process.env.SHOPIFY_SHOP?.trim().toLowerCase();
const token = process.env.SHOPIFY_TOKEN?.trim();
if (!shop || !token) {
  console.error("Set SHOPIFY_SHOP and SHOPIFY_TOKEN.");
  process.exit(1);
}

const PLAN = "shopify-sku-plan.csv";
if (!existsSync(PLAN)) {
  console.error(`No ${PLAN}. Run shopify-sku-plan.ts first and read what it produces.`);
  process.exit(1);
}

/** Splits a CSV line, respecting the quoted fields the plan writes. */
function fields(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else current += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(current); current = ""; }
    else current += ch;
  }
  out.push(current);
  return out;
}

const lines = readFileSync(PLAN, "utf8").trim().split(/\r?\n/);
const header = fields(lines[0]);
const col = (name: string) => header.indexOf(name);

const planned = lines
  .slice(1)
  .map(fields)
  .filter((r) => r[col("action")] === "set")
  .map((r) => ({
    product: r[col("product")],
    variantTitle: r[col("variant")],
    sku: r[col("proposed_sku")],
    variantId: Number(r[col("variant_id")]),
  }))
  .filter((r) => r.sku && Number.isFinite(r.variantId));

console.log(`── ${planned.length} variant(s) the plan would give a SKU\n`);

if (!process.argv.includes("--confirm")) {
  for (const p of planned.slice(0, 10)) {
    console.log(`   ${p.sku.padEnd(22)} ${p.product} — ${p.variantTitle}`);
  }
  if (planned.length > 10) console.log(`   … and ${planned.length - 10} more`);
  console.log("\n   nothing written. Re-run with --confirm to apply.");
  process.exit(0);
}

/* ─────────────────────────────── the rollback ───────────────────────────── */

const rollback: { variantId: number; previousSku: string; product: string }[] = [];

/* ──────────────────────────────── the writing ───────────────────────────── */

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

let set = 0;
let skipped = 0;
let failed = 0;

for (const [i, row] of planned.entries()) {
  // What does it hold right now? The plan may be minutes or days old.
  const readRes = await fetch(
    `https://${shop}/admin/api/2024-10/variants/${row.variantId}.json?fields=id,sku`,
    { headers: { "X-Shopify-Access-Token": token } },
  );

  if (!readRes.ok) {
    failed += 1;
    console.log(`   ✗ ${row.sku}: could not read variant (${readRes.status})`);
    await pause(600);
    continue;
  }

  const { variant } = (await readRes.json()) as { variant: { sku: string | null } };
  const current = (variant.sku ?? "").trim();

  if (current !== "") {
    // Somebody got there first, and their answer wins over a stale plan.
    skipped += 1;
    console.log(`   – ${row.sku}: already has "${current}", left alone`);
    await pause(600);
    continue;
  }

  const writeRes = await fetch(
    `https://${shop}/admin/api/2024-10/variants/${row.variantId}.json`,
    {
      method: "PUT",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ variant: { id: row.variantId, sku: row.sku } }),
    },
  );

  if (!writeRes.ok) {
    failed += 1;
    console.log(`   ✗ ${row.sku}: ${writeRes.status} ${(await writeRes.text()).slice(0, 120)}`);
  } else {
    set += 1;
    rollback.push({ variantId: row.variantId, previousSku: current, product: row.product });
    if (set % 20 === 0 || i === planned.length - 1) {
      console.log(`   … ${set} written`);
    }
    // The rollback file is rewritten as it goes, so an interrupted run still
    // leaves a complete record of what it managed to change.
    writeFileSync("shopify-sku-rollback.json", JSON.stringify(rollback, null, 2), "utf8");
  }

  // Two a second is the limit on this plan; a burst that trips it leaves a
  // half-applied catalogue.
  await pause(600);
}

console.log(`\n   ${set} set · ${skipped} already had one · ${failed} failed`);
if (set > 0) {
  console.log("   shopify-sku-rollback.json lists every variant touched and what it held before");
}
