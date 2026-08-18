/**
 * Can Shopify's catalogue actually be imported?
 *
 * The importer matches an order line to a garment by SKU and refuses the whole
 * order when it cannot — deliberately, because guessing which dress was sold
 * is worse than not importing it. So the integration works exactly as well as
 * the SKUs do, and nothing else about it matters until they line up.
 *
 * This reports three things a person can act on: variants with no SKU at all,
 * SKUs that do not follow the STYLE-COLOUR-SIZE convention this system builds,
 * and SKUs that do follow it but name a garment the system has never heard of.
 *
 *   SHOPIFY_SHOP=xxx.myshopify.com SHOPIFY_TOKEN=shpat_... \
 *     npx tsx --conditions=react-server scripts/shopify-sku-audit.ts
 */
import "dotenv/config";
import { db } from "../src/lib/db";

const shop = process.env.SHOPIFY_SHOP?.trim().toLowerCase();
const token = process.env.SHOPIFY_TOKEN?.trim();
if (!shop || !token) {
  console.error("Set SHOPIFY_SHOP and SHOPIFY_TOKEN.");
  process.exit(1);
}

type Variant = { sku: string | null; title: string; product_id: number };
type Product = { id: number; title: string; variants: Variant[] };

/** Every product, following Shopify's cursor pagination to the end. */
async function allProducts(): Promise<Product[]> {
  const out: Product[] = [];
  let url = `https://${shop}/admin/api/2024-10/products.json?limit=250`;

  for (;;) {
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": token! } });
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);

    const body = (await res.json()) as { products: Product[] };
    out.push(...body.products);

    // Shopify pages through a Link header rather than a cursor in the body.
    const link = res.headers.get("link") ?? "";
    const next = /<([^>]+)>;\s*rel="next"/.exec(link);
    if (!next) break;
    url = next[1];
  }
  return out;
}

const products = await allProducts();
const variants = products.flatMap((p) =>
  p.variants.map((v) => ({ ...v, productTitle: p.title })),
);

console.log(`── ${products.length} products, ${variants.length} variants\n`);

const blank = variants.filter((v) => !v.sku || v.sku.trim() === "");
const withSku = variants.filter((v) => v.sku && v.sku.trim() !== "");

/** What this system builds: STYLE-COLOUR-SIZE, uppercase, dash separated. */
const CONVENTION = /^[A-Z0-9]+-[A-Z]{2,4}-[A-Z0-9]{1,4}$/;
const conventional = withSku.filter((v) => CONVENTION.test(v.sku!.trim().toUpperCase()));
const otherFormat = withSku.filter((v) => !CONVENTION.test(v.sku!.trim().toUpperCase()));

console.log(`   no SKU at all        ${String(blank.length).padStart(4)}  cannot be imported, ever`);
console.log(`   STYLE-COLOUR-SIZE    ${String(conventional.length).padStart(4)}  the shape this system uses`);
console.log(`   some other shape     ${String(otherFormat.length).padStart(4)}  needs deciding about`);

/* ─────────────── which of the good ones does the system know? ───────────── */

const known = new Set(
  (await db.variant.findMany({ select: { sku: true } })).map((v) => v.sku.toUpperCase()),
);

const matched = conventional.filter((v) => known.has(v.sku!.trim().toUpperCase()));
const unmatched = conventional.filter((v) => !known.has(v.sku!.trim().toUpperCase()));

console.log(
  `\n   of the ${conventional.length} well-formed: ${matched.length} exist in Cashmere OS, ` +
    `${unmatched.length} do not`,
);

if (blank.length > 0) {
  console.log(`\n── the ${blank.length} with no SKU (first 15)`);
  for (const v of blank.slice(0, 15)) {
    console.log(`   ${v.productTitle} — ${v.title}`);
  }
  if (blank.length > 15) console.log(`   … and ${blank.length - 15} more`);
}

if (otherFormat.length > 0) {
  console.log(`\n── the ${otherFormat.length} in another shape (first 15)`);
  for (const v of otherFormat.slice(0, 15)) {
    console.log(`   ${v.sku!.padEnd(18)} ${v.productTitle} — ${v.title}`);
  }
  if (otherFormat.length > 15) console.log(`   … and ${otherFormat.length - 15} more`);
}

if (unmatched.length > 0) {
  console.log(`\n── well-formed but unknown here (first 15)`);
  for (const v of unmatched.slice(0, 15)) {
    console.log(`   ${v.sku!.padEnd(18)} ${v.productTitle} — ${v.title}`);
  }
  if (unmatched.length > 15) console.log(`   … and ${unmatched.length - 15} more`);
}

const importable = matched.length;
console.log(
  `\n   ${importable} of ${variants.length} variants could be imported today ` +
    `(${((importable / Math.max(variants.length, 1)) * 100).toFixed(1)}%)`,
);

await db.$disconnect();
