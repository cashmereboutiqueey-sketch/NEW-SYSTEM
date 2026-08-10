/**
 * Put one bazaar on the board, on whatever data is already there.
 *
 * `prisma/demo.ts` runs a whole business cycle and can only run once against a
 * clean database — it posts payroll, and payroll refuses to be posted twice.
 * This is the small version: it opens a bazaar and sends half the showroom's
 * tagged stock to it, so the screen has something real on it without anybody
 * having to reset the database.
 *
 *   npx tsx --conditions=react-server scripts/seed-bazaar.ts
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { openExhibition, sendToExhibition, sendableStock } from "../src/lib/exhibitions";

const owner = await db.user.findFirstOrThrow({ where: { role: "OWNER" } });
const ctx = { userId: owner.id, reason: null };

const source = await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } });

const already = await db.location.findFirst({
  where: { kind: "EXHIBITION", isActive: true },
});
if (already) {
  console.log(`${already.code} is already running — nothing to do.`);
  await db.$disconnect();
  process.exit(0);
}

const today = new Date();
const { id, code } = await openExhibition(
  {
    nameAr: "بازار الساحل الشمالي",
    nameEn: "North Coast Bazaar",
    city: "سيدي عبد الرحمن",
    opensAt: today,
    closesAt: new Date(today.getTime() + 3 * 86_400_000),
    parentLocationId: source.id,
  },
  ctx,
);
console.log(`opened ${code} from ${source.nameAr}`);

const canGo = (await sendableStock(source.id)).filter((s) => Number(s.available) > 0);
if (canGo.length === 0) {
  console.log("The showroom holds no tagged stock, so nothing can go out.");
} else {
  // Half of what is there: a bazaar should not empty the shop.
  const result = await sendToExhibition(
    {
      exhibitionId: id,
      lines: canGo.slice(0, 4).map((s) => ({
        variantId: s.variantId,
        quantity: String(Math.max(1, Math.floor(Number(s.available) / 2))),
      })),
      sendDate: today,
    },
    ctx,
  );
  console.log(
    `sent ${result.totalQty} pieces worth ${Number(result.totalCost).toFixed(2)} (${result.despatchNumber})`,
  );
}

console.log("Open /exhibitions to see it.");
await db.$disconnect();
