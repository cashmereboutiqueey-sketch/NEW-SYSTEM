/**
 * Tie each Shopify variant to the garment it is, so historical orders can
 * still be imported after their SKU snapshot came out empty.
 *
 *   SHOPIFY_SHOP=... npx tsx --conditions=react-server scripts/shopify-map-variants.ts
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { syncVariantMappings } from "../src/lib/shopify";

const shop = process.env.SHOPIFY_SHOP?.trim().toLowerCase();
const connection = shop
  ? await db.integrationConnection.findFirstOrThrow({
      where: { provider: "SHOPIFY", externalRef: shop },
    })
  : await db.integrationConnection.findFirstOrThrow({ where: { provider: "SHOPIFY" } });

const owner = await db.user.findFirstOrThrow({ where: { role: "OWNER" } });

const result = await syncVariantMappings(
  { connectionId: connection.id },
  { userId: owner.id, reason: null },
);

console.log(`── ${connection.externalRef}`);
console.log(`   ${result.mapped} newly mapped`);
console.log(`   ${result.alreadyMapped} already mapped`);
console.log(`   ${result.noMatch} have a SKU this system has never heard of`);
console.log(`   ${result.noSku} still have no SKU at all`);

if (result.noMatch > 0) {
  console.log(
    "\n   the unmatched ones are garments that exist in Shopify and not here —",
  );
  console.log("   they map as soon as the style is created in Cashmere OS");
}

await db.$disconnect();
