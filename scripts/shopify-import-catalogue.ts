/**
 * Create the shop's real styles and variants from the Shopify catalogue.
 *
 * Everything needed to *sell* a garment is in Shopify — its name, colours,
 * sizes and price — so all of that comes across. Everything needed to *cost*
 * one is not: the bill of materials, the operations and the standard minutes
 * exist nowhere but in the factory's head, and no import can invent them.
 *
 * So a style arrives here sellable and uncosted, deliberately. It will appear
 * on the till, take orders and relieve stock; it will not have a transfer
 * price until somebody enters what it is made of. The costing screen already
 * refuses a style with no bill of materials, and that refusal is the thing
 * that keeps a made-up cost out of the books.
 *
 * Idempotent. A style already here is left exactly as it is — including its
 * name, because somebody may have corrected it since.
 *
 *   SHOPIFY_SHOP=... SHOPIFY_TOKEN=... \
 *     npx tsx --conditions=react-server scripts/shopify-import-catalogue.ts [--confirm]
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { createStyle, addVariants } from "../src/lib/products";
import { parseSku } from "../src/core/sku";

const shop = process.env.SHOPIFY_SHOP?.trim().toLowerCase();
const token = process.env.SHOPIFY_TOKEN?.trim();
if (!shop || !token) {
  console.error("Set SHOPIFY_SHOP and SHOPIFY_TOKEN.");
  process.exit(1);
}

type Variant = { id: number; sku: string | null; price: string };
type Product = { id: number; title: string; variants: Variant[] };

async function activeProducts(): Promise<Product[]> {
  const out: Product[] = [];
  let url = `https://${shop}/admin/api/2024-10/products.json?status=active&limit=250&fields=id,title,variants`;
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

const products = await activeProducts();

/**
 * Group by style code rather than by product.
 *
 * One Shopify product can be several styles — a set whose vest and pants are
 * different garments — and the SKU already says which is which.
 */
type StylePlan = {
  code: string;
  nameEn: string;
  price: number | null;
  pairs: { colourCode: string; sizeCode: string }[];
};

const plans = new Map<string, StylePlan>();
let unparseable = 0;

for (const product of products) {
  for (const variant of product.variants) {
    const parsed = parseSku((variant.sku ?? "").trim());
    if (!parsed) {
      unparseable += 1;
      continue;
    }

    const plan = plans.get(parsed.styleCode) ?? {
      code: parsed.styleCode,
      // The product's own title, which is what a person recognises. A set's
      // components share it, and whoever renames one can rename the others.
      nameEn: product.title.replace(/\s+/g, " ").trim(),
      price: null,
      pairs: [],
    };

    // The dearest variant, because a set's full price belongs to the set and
    // its parts are cheaper — taking the first would understate it.
    const price = Number(variant.price);
    if (Number.isFinite(price) && (plan.price === null || price > plan.price)) {
      plan.price = price;
    }

    plan.pairs.push({ colourCode: parsed.colorCode, sizeCode: parsed.sizeCode });
    plans.set(parsed.styleCode, plan);
  }
}

console.log(`── ${products.length} active products → ${plans.size} styles\n`);

const existing = new Set(
  (await db.style.findMany({ select: { code: true } })).map((s) => s.code.toUpperCase()),
);

for (const plan of [...plans.values()].sort((a, b) => a.code.localeCompare(b.code))) {
  const here = existing.has(plan.code) ? "exists" : "new";
  console.log(
    `   ${plan.code.padEnd(18)} ${String(plan.pairs.length).padStart(3)} variants  ` +
      `${plan.price === null ? "no price" : plan.price.toFixed(2).padStart(9)}  ${here}  ${plan.nameEn}`,
  );
}

if (unparseable > 0) {
  console.log(`\n   ${unparseable} variant(s) have no readable SKU and are skipped`);
}

if (!process.argv.includes("--confirm")) {
  console.log("\n   nothing written. Re-run with --confirm to create them.");
  await db.$disconnect();
  process.exit(0);
}

/* ─────────────────────────────── writing ────────────────────────────────── */

const owner = await db.user.findFirstOrThrow({ where: { role: "OWNER" } });
const ctx = { userId: owner.id, reason: null };

/**
 * Where imported styles land.
 *
 * Their own collection rather than a guess at which season each belongs to:
 * the shop can move them afterwards, and a wrong season is harder to notice
 * than an obviously temporary one.
 */
const collection = await db.collection.upsert({
  where: { code: "SHOPIFY" },
  update: {},
  create: {
    code: "SHOPIFY",
    nameEn: "Imported from Shopify",
    nameAr: "مستوردة من شوبيفاي",
    season: "Imported",
    year: new Date().getFullYear(),
  },
});

let stylesMade = 0;
let stylesKept = 0;
let variantsMade = 0;
let variantsKept = 0;
const problems: string[] = [];

console.log("\n── creating");

for (const plan of [...plans.values()].sort((a, b) => a.code.localeCompare(b.code))) {
  let style = await db.style.findUnique({ where: { code: plan.code } });

  if (style) {
    /**
     * A code that is already taken by a different garment.
     *
     * The demo ships a DALIA that is a tunic; this shop's DALIA is trousers.
     * Adopting the existing style would attach real variants to the wrong
     * garment and then map Shopify's trousers onto it — wrong in a way that
     * looks completely normal on every screen afterwards.
     *
     * Compared loosely, because "Dalia-Trousers" and "Dalia Trousers" are the
     * same garment and a punctuation difference is not a conflict.
     */
    const simplify = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
    const sameGarment =
      simplify(style.nameEn).includes(simplify(plan.nameEn)) ||
      simplify(plan.nameEn).includes(simplify(style.nameEn));

    if (!sameGarment) {
      problems.push(
        `${plan.code} is already "${style.nameEn}" here but "${plan.nameEn}" in Shopify — ` +
          "left alone rather than attaching one garment's variants to another",
      );
      continue;
    }
    stylesKept += 1;
  } else {
    try {
      style = await createStyle(
        {
          code: plan.code,
          nameEn: plan.nameEn,
          // The Arabic name is the one thing Shopify cannot give. Seeded with
          // the English so nothing is blank, and obvious enough to be fixed.
          nameAr: plan.nameEn,
          collectionId: collection.id,
          plannedWasteRate: 0,
          retailPrice: plan.price,
        },
        ctx,
      );
      stylesMade += 1;
    } catch (error) {
      problems.push(`${plan.code}: ${(error as Error).message}`);
      continue;
    }
  }

  const result = await addVariants({ styleId: style.id, pairs: plan.pairs }, ctx);
  variantsMade += result.created;
  variantsKept += result.existed;
  for (const u of result.unknown) problems.push(`${plan.code}: ${u}`);

  console.log(
    `   ${plan.code.padEnd(18)} ${String(result.created).padStart(3)} new, ` +
      `${String(result.existed).padStart(3)} already there`,
  );
}

console.log(
  `\n   ${stylesMade} style(s) created, ${stylesKept} already here\n` +
    `   ${variantsMade} variant(s) created, ${variantsKept} already here`,
);

if (problems.length > 0) {
  console.log(`\n   ${problems.length} thing(s) to look at:`);
  for (const p of problems.slice(0, 15)) console.log(`     ${p}`);
}

console.log(
  "\n   these styles can be sold and cannot yet be costed — they have no bill\n" +
    "   of materials and no operations, which is the part Shopify never had",
);

await db.$disconnect();
