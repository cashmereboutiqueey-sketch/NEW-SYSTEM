/**
 * Print the CMT rate card, for reading down the phone.
 *
 *   npx tsx --conditions=react-server scripts/rate-card.ts [smv] [margin]
 *
 * e.g. `scripts/rate-card.ts 25 0.15` for a 25-minute garment at fifteen per
 * cent over the floor.
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { rateCard } from "../src/lib/cmt";

const smv = process.argv[2] ?? "25";
const margin = process.argv[3] ?? "0.15";

const card = await rateCard({ smvPerUnit: smv, marginOverFloor: margin });

if (!card) {
  console.log("No minute rate has been calculated, so there is no floor to price above.");
  await db.$disconnect();
  process.exit(1);
}

console.log(`Period ${card.period}`);
console.log(
  `Minimum ${card.minimumQuantity} pieces · setup ${card.setupMinutes} min/run · ` +
    `floor ${card.floorMinuteRate} · quoted ${card.quotedMinuteRate} (+${card.marginOverFloorPct}%)`,
);
console.log(`Free minutes this month: ${card.freeMinutes}\n`);

console.log("  qty  setup/pc   min/pc    unit price        total   lead");
console.log("  ---  --------  -------  ------------  -----------  -----");
for (const t of card.tiers) {
  console.log(
    String(t.quantity).padStart(5),
    t.setupPerUnit.padStart(9),
    t.minutesPerUnit.padStart(8),
    t.unitPrice.padStart(13),
    t.total.padStart(12),
    (String(t.leadDays) + "d").padStart(6),
    t.capacityAvailable ? "" : "  over free capacity",
  );
}

console.log(
  "\nUnit price = (minutes per garment + setup ÷ quantity) × minute rate.",
);

await db.$disconnect();
