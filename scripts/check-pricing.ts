/**
 * Markup against margin, on the real transfer prices.
 *
 * The factory's rate is added to cost, so it is a markup. Reporting it as a
 * margin overstates the profit on every garment — by more the fatter the rate.
 * This prints both against what is actually stored, so the difference is a
 * number rather than an argument.
 *
 *   npx tsx --conditions=react-server scripts/check-pricing.ts
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { markupToMargin, marginOf, discountLadder } from "../src/core/pricing";
import { dec } from "../src/lib/money";

const settings = await db.setting.findMany({
  where: { key: { startsWith: "factory.mark" } },
});
console.log("── settings");
for (const s of settings) console.log(`   ${s.key.padEnd(40)} ${s.value}`);
if (settings.length === 0) console.log("   NONE FOUND — the rename lost them");

const snapshots = await db.costSnapshot.findMany({
  include: { style: true },
  orderBy: { createdAt: "desc" },
  take: 5,
});

console.log("\n── what the factory actually earns");
console.log(
  "   style            cost      price    markup    margin   difference",
);
for (const s of snapshots) {
  const cost = dec(s.factoryTotalCost);
  const price = dec(s.transferPrice);
  const markup = dec(s.factoryMarkupPct);
  const margin = markupToMargin(markup);
  const observed = marginOf(price, cost);

  // The stored markup and the price must agree, or the snapshot is lying
  // about how it was arrived at.
  const agrees = observed && observed.minus(margin).abs().lessThan("0.0001");

  console.log(
    `   ${s.style.code.padEnd(10)} ${cost.toFixed(2).padStart(10)} ${price.toFixed(2).padStart(10)}` +
      `   ${(Number(markup) * 100).toFixed(1).padStart(5)}%   ${(Number(margin) * 100).toFixed(1).padStart(5)}%` +
      `   ${((Number(markup) - Number(margin)) * 100).toFixed(1).padStart(5)} pts  ${agrees ? "" : "MISMATCH"}`,
  );
}

// What a discount does, on a real garment rather than an invented one.
const anySnapshot = snapshots[0];
if (anySnapshot) {
  const brandCost = dec(anySnapshot.transferPrice);
  const retail = dec(anySnapshot.style.retailPrice ?? brandCost.times(2));

  console.log(
    `\n── what a discount costs the brand on ${anySnapshot.style.code}` +
      `  (bought ${brandCost.toFixed(2)}, priced ${retail.toFixed(2)})`,
  );
  console.log("   discount     price     profit    margin   profit given up");
  for (const rung of discountLadder(retail, brandCost)) {
    console.log(
      `   ${(Number(rung.discount) * 100).toFixed(0).padStart(6)}%  ${Number(rung.price).toFixed(2).padStart(9)}` +
        `  ${Number(rung.profit).toFixed(2).padStart(9)}  ${rung.margin ? (Number(rung.margin) * 100).toFixed(1).padStart(7) + "%" : "       —"}` +
        `   ${rung.profitGivenUp ? (Number(rung.profitGivenUp) * 100).toFixed(0).padStart(13) + "%" : ""}` +
        `${rung.belowCost ? "  ← at a loss" : ""}`,
    );
  }
}

await db.$disconnect();
