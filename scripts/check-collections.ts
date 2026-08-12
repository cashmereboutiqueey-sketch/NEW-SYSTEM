/**
 * The same collection through each side's eyes.
 *
 * The Factory's revenue on a collection is what it invoiced the Brand at
 * transfer price; the Brand's cost is that same figure. If the two sides ever
 * report the same margin, something is reporting the other one's numbers.
 *
 *   npx tsx --conditions=react-server scripts/check-collections.ts
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { collectionPerformance } from "../src/lib/analytics";

const money = (d: { toFixed(n: number): string }) => d.toFixed(2).padStart(12);

for (const kind of ["FACTORY", "BRAND"] as const) {
  const entity = await db.entity.findFirstOrThrow({ where: { kind } });
  const report = await collectionPerformance(entity.id, kind);

  console.log(`\n══ ${entity.nameAr} (${kind}) — ${report.length} collection(s)`);

  for (const c of report) {
    console.log(
      `\n  ${c.code} ${c.nameAr} (${c.season} ${c.year}) — ${c.styleCount} styles`,
    );
    console.log(
      `    revenue ${money(c.revenue)}   cost ${money(c.cost)}   margin ${money(c.grossMargin)}` +
        `  (${(Number(c.marginPct) * 100).toFixed(1)}%)`,
    );
    console.log(
      `    produced ${String(c.produced).padStart(5)}   ${kind === "FACTORY" ? "transferred" : "sold      "} ` +
        `${String(c.units).padStart(5)}   on hand ${Number(c.onHand).toFixed(0).padStart(5)} ` +
        `worth ${money(c.onHandValue)}`,
    );
    console.log(
      `    sell-through ${c.sellThrough ? (Number(c.sellThrough) * 100).toFixed(1) + "%" : "—"}`,
    );
    if (c.best) {
      console.log(
        `    best      ${c.best.code} ${c.best.nameAr} — margin ${Number(c.best.grossMargin).toFixed(2)} on ${c.best.units} units`,
      );
    }
    if (c.mostProduced) {
      console.log(
        `    most made ${c.mostProduced.code} ${c.mostProduced.nameAr} — ${c.mostProduced.produced} pieces` +
          (c.mostProduced.costPerPiece
            ? ` at ${Number(c.mostProduced.costPerPiece).toFixed(2)} each`
            : ""),
      );
    }
    if (c.worst) {
      console.log(
        `    slowest   ${c.worst.code} ${c.worst.nameAr} — ${c.worst.sellThrough ? (Number(c.worst.sellThrough) * 100).toFixed(1) + "%" : "—"} sold through`,
      );
    }
  }
}

// The one thing that must never be true.
const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });
const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });
const f = await collectionPerformance(factory.id, "FACTORY");
const b = await collectionPerformance(brand.id, "BRAND");

console.log("\n── the two sides must not agree");
for (const fc of f) {
  const bc = b.find((x) => x.id === fc.id);
  if (!bc) continue;
  const same = fc.grossMargin.equals(bc.grossMargin) && fc.revenue.equals(bc.revenue);
  console.log(
    `  ${fc.code}: factory margin ${Number(fc.grossMargin).toFixed(2)}, ` +
      `brand margin ${Number(bc.grossMargin).toFixed(2)} — ${same ? "IDENTICAL (wrong)" : "different, good"}`,
  );
  // The join between the two sides. Everything the Factory invoiced is either
  // sitting in the Brand's stockroom or has gone through its till — so the
  // Factory's revenue must equal the Brand's cost of sales plus the transfer
  // value of what it still holds. If those drift apart, a garment crossed the
  // house without being paid for on one side or the other.
  const accountedFor = bc.cost.plus(bc.onHandValue);
  const gap = fc.revenue.minus(accountedFor);
  console.log(
    `      factory invoiced ${Number(fc.revenue).toFixed(2)} = brand sold ` +
      `${Number(bc.cost).toFixed(2)} + brand still holds ${Number(bc.onHandValue).toFixed(2)} ` +
      `→ ${Number(accountedFor).toFixed(2)} (${gap.abs().lessThan("0.01") ? "reconciles" : `OFF BY ${Number(gap).toFixed(2)}`})`,
  );
}

await db.$disconnect();
