/**
 * Work out what SKU every active variant should have, and write the plan out
 * for a person to read before anything touches Shopify.
 *
 * Nothing here writes. It produces a file you can open, sort, and argue with,
 * because a thousand SKUs generated straight onto a live catalogue is not a
 * thing anybody should be asked to trust sight unseen.
 *
 * The rules, in the order they matter:
 *
 *   A SKU that already exists is never touched. Some of the catalogue is
 *   already correct and some carries an older numeric code that may be printed
 *   on a label or sitting in a supplier's file. Overwriting either would break
 *   something invisible.
 *
 *   Only active products. Drafts and archived ones are somebody's decision to
 *   revisit later, not stock being sold today.
 *
 *   The code must be what this system would have built: STYLE-COLOUR-SIZE,
 *   with the colour a three-letter code from the colour table — because the
 *   whole point is that the importer recognises it afterwards.
 *
 *   Two products that would produce the same style code is a collision, and a
 *   collision is reported rather than resolved by adding a number. Two garments
 *   whose SKUs differ by a digit nobody can explain is worse than a gap.
 *
 *   SHOPIFY_SHOP=... SHOPIFY_TOKEN=... \
 *     npx tsx --conditions=react-server scripts/shopify-sku-plan.ts
 */
import "dotenv/config";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { db } from "../src/lib/db";

/**
 * The two judgement calls this cannot make on its own, kept in a file rather
 * than in code: which Shopify colour name means which three-letter code, and
 * what to call a product whose first word is not unique. Both are decisions
 * about the business own naming and should be readable by whoever lives
 * with them.
 */
type Mapping = {
  colours?: Record<string, string>;
  newColourNames?: Record<string, { en: string; ar: string }>;
  styleCodes?: Record<string, string>;
};

const MAPPING_FILE = "shopify-sku-mapping.json";
const mapping: Mapping = existsSync(MAPPING_FILE)
  ? JSON.parse(readFileSync(MAPPING_FILE, "utf8"))
  : {};

const overrideColour = new Map(
  Object.entries(mapping.colours ?? {}).map(([name, code]) => [name.trim().toLowerCase(), code]),
);
const overrideStyle = new Map(
  Object.entries(mapping.styleCodes ?? {}).map(([title, code]) => [title.trim().toLowerCase(), code]),
);

const shop = process.env.SHOPIFY_SHOP?.trim().toLowerCase();
const token = process.env.SHOPIFY_TOKEN?.trim();
if (!shop || !token) {
  console.error("Set SHOPIFY_SHOP and SHOPIFY_TOKEN.");
  process.exit(1);
}

type Variant = {
  id: number;
  sku: string | null;
  title: string;
  option1: string | null;
  option2: string | null;
  option3: string | null;
};
type Product = {
  id: number;
  title: string;
  status: string;
  options: { name: string; position: number }[];
  variants: Variant[];
};

async function activeProducts(): Promise<Product[]> {
  const out: Product[] = [];
  let url =
    `https://${shop}/admin/api/2024-10/products.json` +
    `?status=active&limit=250&fields=id,title,status,options,variants`;

  for (;;) {
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": token! } });
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { products: Product[] };
    out.push(...body.products);

    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "");
    if (!next) break;
    url = next[1];
  }
  return out;
}

/**
 * The style code for a product.
 *
 * Titles here take a few shapes — "Dalia-Trousers", "Banfseg – Linen Shirt",
 * "Basic T-Shirt". The first word is what the business already uses: the
 * variants that carry a correct SKU today spell "Dalia-Trousers" as DALIA.
 * Anything that is not a letter or digit goes, and the result is capped at the
 * twenty characters the schema allows.
 */
function styleCodeFor(title: string): string {
  const override = overrideStyle.get(title.trim().toLowerCase());
  if (override) return override.toUpperCase();

  const firstWord = title
    .split(/[-–—/|,(]/)[0] // stop at any separator, including the en dash
    .trim()
    .split(/\s+/)[0]; // and then at the first space

  return firstWord
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .slice(0, 20);
}

/** Which option is the colour, and which the size — by name, not by position. */
function optionIndex(product: Product, name: RegExp): 1 | 2 | 3 | null {
  const found = product.options.find((o) => name.test(o.name));
  if (!found) return null;
  return (found.position as 1 | 2 | 3) ?? null;
}

function optionValue(variant: Variant, index: 1 | 2 | 3 | null): string | null {
  if (index === null) return null;
  return index === 1 ? variant.option1 : index === 2 ? variant.option2 : variant.option3;
}

/** The size, uppercased and stripped to what the schema accepts. */
function sizeCodeFor(value: string): string | null {
  const code = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^[A-Z0-9]{1,4}$/.test(code) ? code : null;
}

const products = await activeProducts();
const variants = products.flatMap((p) => p.variants.map((v) => ({ product: p, variant: v })));

console.log(`── ${products.length} active products, ${variants.length} variants\n`);

/* ───────────────────────── the colour codes we have ─────────────────────── */

const colours = await db.colorCode.findMany({
  select: { code: true, nameEn: true, nameAr: true },
});

/** Match a Shopify colour name to a code already in the colour table. */
const byName = new Map<string, string>();
for (const c of colours) {
  byName.set(c.nameEn.trim().toLowerCase(), c.code);
  byName.set(c.nameAr.trim().toLowerCase(), c.code);
  byName.set(c.code.toLowerCase(), c.code);
}

const shopifyColours = new Map<string, number>();
for (const { product, variant } of variants) {
  const idx = optionIndex(product, /colou?r|لون/i);
  const value = optionValue(variant, idx);
  if (value) shopifyColours.set(value.trim(), (shopifyColours.get(value.trim()) ?? 0) + 1);
}

const resolved = (c: string) =>
  byName.has(c.toLowerCase()) || overrideColour.has(c.toLowerCase());
const known = [...shopifyColours.keys()].filter(resolved);
const unknown = [...shopifyColours.keys()].filter((c) => !resolved(c));

console.log(`   colours in the shop: ${shopifyColours.size}`);
console.log(`     ${known.length} already have a code here`);
console.log(`     ${unknown.length} do not and need one before their SKUs can be built`);

if (unknown.length > 0) {
  console.log("\n── colours with no code yet, commonest first");
  for (const name of unknown.sort(
    (a, b) => (shopifyColours.get(b) ?? 0) - (shopifyColours.get(a) ?? 0),
  )) {
    console.log(`   ${String(shopifyColours.get(name)).padStart(4)} variants   ${name}`);
  }
}

/* ─────────────────────────── style code collisions ──────────────────────── */

const styleToProducts = new Map<string, string[]>();
for (const p of products) {
  const code = styleCodeFor(p.title);
  styleToProducts.set(code, [...(styleToProducts.get(code) ?? []), p.title]);
}

const collisions = [...styleToProducts.entries()].filter(([, titles]) => titles.length > 1);

if (collisions.length > 0) {
  console.log(`\n── ${collisions.length} style code(s) two products would share`);
  for (const [code, titles] of collisions) {
    console.log(`   ${code.padEnd(14)} ${titles.join("  ·  ")}`);
  }
  console.log("   these need a decision; nothing is generated for them");
}

/* ───────────────────────────────── the plan ─────────────────────────────── */

type Row = {
  productId: number;
  variantId: number;
  product: string;
  variantTitle: string;
  currentSku: string;
  proposedSku: string;
  action: "keep" | "set" | "blocked";
  why: string;
};

const rows: Row[] = [];

for (const { product, variant } of variants) {
  const current = (variant.sku ?? "").trim();
  const base = {
    productId: product.id,
    variantId: variant.id,
    product: product.title,
    variantTitle: variant.title,
    currentSku: current,
  };

  if (current !== "") {
    rows.push({ ...base, proposedSku: "", action: "keep", why: "already has one" });
    continue;
  }

  const styleCode = styleCodeFor(product.title);
  const colourValue = optionValue(variant, optionIndex(product, /colou?r|لون/i));
  const sizeValue = optionValue(variant, optionIndex(product, /size|مقاس/i));

  const blocked = (why: string) =>
    rows.push({ ...base, proposedSku: "", action: "blocked", why });

  if (
    (styleToProducts.get(styleCode)?.length ?? 0) > 1 &&
    !overrideStyle.has(product.title.trim().toLowerCase())
  ) {
    blocked(`style code ${styleCode} is shared with another product`);
    continue;
  }
  if (!/^[A-Z0-9]{2,20}$/.test(styleCode)) {
    blocked(`no usable style code from "${product.title}"`);
    continue;
  }
  if (!colourValue) {
    blocked("no colour option on this product");
    continue;
  }

  const colourCode =
    overrideColour.get(colourValue.trim().toLowerCase()) ??
    byName.get(colourValue.trim().toLowerCase());
  if (!colourCode) {
    blocked(`no colour code for "${colourValue}"`);
    continue;
  }

  if (!sizeValue) {
    blocked("no size option on this product");
    continue;
  }
  const sizeCode = sizeCodeFor(sizeValue);
  if (!sizeCode) {
    blocked(`size "${sizeValue}" does not fit the 1–4 character rule`);
    continue;
  }

  rows.push({
    ...base,
    proposedSku: `${styleCode}-${colourCode}-${sizeCode}`,
    action: "set",
    why: "",
  });
}

/* ───────────────── a proposed SKU must not collide with anything ────────── */

const taken = new Set(
  variants.map(({ variant }) => (variant.sku ?? "").trim().toUpperCase()).filter(Boolean),
);
const seen = new Set<string>();

for (const row of rows) {
  if (row.action !== "set") continue;
  const sku = row.proposedSku.toUpperCase();
  if (taken.has(sku) || seen.has(sku)) {
    row.action = "blocked";
    row.why = `${row.proposedSku} is already used by another variant`;
    row.proposedSku = "";
  } else {
    seen.add(sku);
  }
}

const toSet = rows.filter((r) => r.action === "set");
const keep = rows.filter((r) => r.action === "keep");
const blocked = rows.filter((r) => r.action === "blocked");

console.log("\n── the plan");
console.log(`   ${keep.length} keep the SKU they already have, untouched`);
console.log(`   ${toSet.length} would get one`);
console.log(`   ${blocked.length} cannot be worked out yet`);

if (blocked.length > 0) {
  const byReason = new Map<string, number>();
  for (const b of blocked) {
    const key = b.why.replace(/"[^"]*"/g, '"…"');
    byReason.set(key, (byReason.get(key) ?? 0) + 1);
  }
  console.log("\n   why not:");
  for (const [why, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${String(n).padStart(4)}  ${why}`);
  }
}

const csv = [
  "action,product,variant,current_sku,proposed_sku,why,product_id,variant_id",
  ...rows.map((r) =>
    [
      r.action,
      `"${r.product.replace(/"/g, '""')}"`,
      `"${r.variantTitle.replace(/"/g, '""')}"`,
      r.currentSku,
      r.proposedSku,
      `"${r.why.replace(/"/g, '""')}"`,
      r.productId,
      r.variantId,
    ].join(","),
  ),
].join("\n");

writeFileSync("shopify-sku-plan.csv", csv, "utf8");
console.log("\n   written to shopify-sku-plan.csv — read it before anything is applied");

await db.$disconnect();
