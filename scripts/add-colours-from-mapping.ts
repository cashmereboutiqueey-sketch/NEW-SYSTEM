/**
 * Create the colour codes the SKU mapping refers to.
 *
 * The SKUs about to be written to Shopify name codes like MNT and BRG, and the
 * importer matches an order line by looking a SKU up here — so a code that
 * exists in Shopify and not in the colour table is a SKU that will never
 * match. This closes that gap before it is opened.
 *
 * Idempotent: a code already on file is left exactly as it is, because the
 * name somebody typed beats a name from a mapping file.
 *
 *   npx tsx --conditions=react-server scripts/add-colours-from-mapping.ts
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { db } from "../src/lib/db";
import { createColour } from "../src/lib/master-data";

const mapping = JSON.parse(readFileSync("shopify-sku-mapping.json", "utf8")) as {
  newColourNames?: Record<string, { en: string; ar: string }>;
};

const owner = await db.user.findFirstOrThrow({ where: { role: "OWNER" } });
const ctx = { userId: owner.id, reason: null };

const wanted = Object.entries(mapping.newColourNames ?? {});
console.log(`── ${wanted.length} colour code(s) the mapping needs\n`);

let created = 0;
let already = 0;

for (const [code, names] of wanted) {
  const existing = await db.colorCode.findUnique({ where: { code } });
  if (existing) {
    already += 1;
    console.log(`   – ${code}  already "${existing.nameAr}", left alone`);
    continue;
  }

  await createColour({ code, nameAr: names.ar, nameEn: names.en }, ctx);
  created += 1;
  console.log(`   ✓ ${code}  ${names.ar} / ${names.en}`);
}

console.log(`\n   ${created} created, ${already} already there`);

const total = await db.colorCode.count();
console.log(`   ${total} colour codes on file now`);

await db.$disconnect();
