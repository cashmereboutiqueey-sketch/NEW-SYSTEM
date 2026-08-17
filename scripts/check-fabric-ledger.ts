/**
 * The fabric still in the factory store: bought, drawn, left.
 *
 *   npx tsx --conditions=react-server scripts/check-fabric-ledger.ts
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { fabricLedger, fabricTotals } from "../src/lib/fabric-ledger";

const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });
const rows = await fabricLedger(factory.id, { materialType: "ALL", includeFinished: true });
const totals = fabricTotals(rows);

const n = (v: unknown, dp = 2) => Number(v).toFixed(dp);

console.log(`── ${factory.nameAr}: ${totals.materials} خامة\n`);
console.log(
  "   code             bought    drawn     left    |  production  scrap  transfer  |     value  used%",
);
for (const r of rows) {
  console.log(
    `   ${r.code.padEnd(16)}${n(r.purchased).padStart(8)}${n(r.drawn).padStart(9)}${n(r.remaining).padStart(9)}` +
      `    |${n(r.movements.toProduction).padStart(11)}${n(r.movements.scrapped).padStart(7)}${n(r.movements.transferredOut).padStart(10)}` +
      `    |${n(r.value).padStart(10)}${r.usedPct ? (Number(r.usedPct) * 100).toFixed(0).padStart(6) + "%" : "      —"}`,
  );
}

console.log(
  `\n   totals: bought ${n(totals.purchased)}, drawn ${n(totals.drawn)}, left ${n(totals.remaining)}` +
    `  worth ${n(totals.value)}`,
);
console.log(
  `   ${totals.standing} material(s) with cloth standing over 90 days; ` +
    `${totals.stillOnShelf ? (Number(totals.stillOnShelf) * 100).toFixed(1) : "—"}% of everything bought is still on the shelf`,
);

// The identity that has to hold, or the ledger is telling a story the lots do
// not support: bought − left must equal everything the movements say left.
console.log("\n── does the split account for the whole drawdown?");
let broken = 0;
for (const r of rows) {
  const moved = r.movements.toProduction
    .plus(r.movements.scrapped)
    .plus(r.movements.transferredOut);
  const gap = r.drawn.minus(moved);
  if (gap.abs().greaterThan("0.0001")) {
    broken += 1;
    console.log(
      `   ${r.code}: drawn ${n(r.drawn, 4)} but movements only explain ${n(moved, 4)} (gap ${n(gap, 4)})`,
    );
  }
}
console.log(broken === 0 ? "   ✓ every metre that left is accounted for" : `   ✗ ${broken} unexplained`);

const first = rows.find((r) => r.lots.length > 1) ?? rows[0];
if (first) {
  console.log(`\n── ${first.code} — ${first.nameAr}, delivery by delivery`);
  for (const lot of first.lots) {
    console.log(
      `   ${lot.receivedDate.toISOString().slice(0, 10)}  ${lot.lotNumber.padEnd(20)}` +
        ` bought ${n(lot.originalQty).padStart(8)}  left ${n(lot.remainingQty).padStart(8)}` +
        `  @ ${n(lot.unitCost).padStart(8)}  = ${n(lot.value).padStart(9)}` +
        `  ${lot.ageDays}d  ${lot.supplierAr ?? "—"}`,
    );
  }
}

await db.$disconnect();
