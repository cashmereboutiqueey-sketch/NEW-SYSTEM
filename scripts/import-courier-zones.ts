/**
 * Loads confirmed Flextock delivery areas and prices into the database.
 *
 * The prices are what the shop negotiated with the courier, and this remote is
 * public, so they live in a file that is never committed:
 *
 *   data/private/flextock-zones.json
 *     { "zones": [{ "governorate", "region", "price" }] }
 *
 * Refresh that file from Flextock's confirmed area list whenever prices change, then
 * run this again. Areas no longer listed are deactivated, not deleted: orders
 * already sent there keep pointing at them.
 *
 *   npx tsx --conditions=react-server scripts/import-courier-zones.ts [file]
 *
 * This delivery-only flow uses one DIRECT branch until Flextock supplies an
 * area or branch mapping in its API contract.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { db } from "../src/lib/db";
import { importCourierZones } from "../src/lib/shipping";

const file = process.argv[2] ?? "data/private/flextock-zones.json";

let parsed: { zones?: { governorate: string; region: string; price: number | string }[] };
try {
  parsed = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  console.error(`Could not read ${file}: ${(error as Error).message}`);
  process.exit(1);
}

const zones = parsed.zones ?? [];
if (zones.length === 0) {
  console.error(`${file} lists no zones.`);
  process.exit(1);
}

const result = await importCourierZones(
  {
    zones,
  },
  { userId: null, reason: `Courier price list from ${file}` },
);

console.log(
  `${zones.length} areas read: ${result.created} added, ${result.updated} updated, ${result.deactivated} no longer served.`,
);
await db.$disconnect();
