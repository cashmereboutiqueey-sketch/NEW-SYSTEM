/**
 * Loads MG Express's delivery areas and prices into the database.
 *
 * The prices are what the shop negotiated with the courier, and this remote is
 * public, so they live in a file that is never committed:
 *
 *   data/private/mg-express-zones.json
 *     { "courier": "MG_EXPRESS", "zones": [{ "governorate", "region", "price" }] }
 *
 * Refresh that file from MG's «قائمة الأسعار» whenever the prices change, then
 * run this again. Areas no longer listed are deactivated, not deleted: orders
 * already sent there keep pointing at them.
 *
 *   npx tsx --conditions=react-server scripts/import-courier-zones.ts [file]
 *
 * Which branch serves a governorate decides which sheet a parcel goes on — the
 * courier's import takes one branch per file. Change CAIRO_BRANCH below if the
 * split changes.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { db } from "../src/lib/db";
import { importCourierZones } from "../src/lib/shipping";

/** Served by MG Cairo (branch 5). Everything else goes through MG Express (branch 1). */
const CAIRO_BRANCH = new Set(["القاهرة", "الجيزة", "القليوبية"]);

const file = process.argv[2] ?? "data/private/mg-express-zones.json";

let parsed: { courier?: string; zones?: { governorate: string; region: string; price: number | string }[] };
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
    courier: parsed.courier ?? "MG_EXPRESS",
    zones,
    branchFor: (governorate) => (CAIRO_BRANCH.has(governorate.trim()) ? "5" : "1"),
  },
  { userId: null, reason: `Courier price list from ${file}` },
);

console.log(
  `${zones.length} areas read: ${result.created} added, ${result.updated} updated, ${result.deactivated} no longer served.`,
);
await db.$disconnect();
