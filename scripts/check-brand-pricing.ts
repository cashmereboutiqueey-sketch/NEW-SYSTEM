/**
 * The brand's pricing engine against the live books.
 *
 * The factory prices its own cost and stops. The brand starts from the
 * transfer price and has to cover rent, salaries, marketing, packaging and
 * the garments that come back. Only what survives that is profit.
 *
 *   npx tsx --conditions=react-server scripts/check-brand-pricing.ts
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { brandPriceList, priceStyle, pricingGap } from "../src/lib/brand-pricing";

const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });
const { basis, styles } = await brandPriceList(brand.id);

const n = (v: unknown, dp = 2) => (v == null ? "—" : Number(v).toFixed(dp));
const pc = (v: unknown) => (v == null ? "—" : (Number(v) * 100).toFixed(1) + "%");

console.log(`── what the shop costs to run  (measured over ${basis.months} months)`);
console.log(`   monthly overhead      ${n(basis.monthlyOverhead).padStart(12)}  ${basis.overheadMeasured ? "(from the books)" : "(typed)"}`);
console.log(`   monthly units sold    ${n(basis.monthlyUnits, 1).padStart(12)}  ${basis.unitsBasis}`);
console.log(`   overhead per garment  ${n(basis.overheadPerUnit).padStart(12)}`);
console.log(`   marketing per garment ${n(basis.marketingPerUnit).padStart(12)}  ${basis.marketingMeasured ? "(allocated)" : "(typed)"}`);
console.log(`   packaging             ${n(basis.packagingPerUnit).padStart(12)}`);
console.log(`   shipping              ${n(basis.shippingPerUnit).padStart(12)}`);
console.log(`   return rate           ${pc(basis.returnRate).padStart(12)}`);
console.log(`   cost to sell one      ${n(basis.costToSellPerUnit).padStart(12)}`);
if (basis.overheadDominates) {
  console.log(
    "   ! absorbed overhead is bigger than the garment itself — the price is mostly " +
      "a statement about expected volume, not a costing.",
  );
}

console.log("\n── every style the brand sells");
console.log(
  "   style       transfer  +to sell  +returns   = true    priced   margin   should be   gap",
);
for (const s of styles) {
  console.log(
    `   ${s.code.padEnd(10)} ${n(s.transferPrice).padStart(9)} ${n(s.costToSell).padStart(9)}` +
      ` ${n(s.returnAllowance).padStart(9)} ${n(s.trueCost).padStart(9)}` +
      ` ${n(s.retailPrice).padStart(9)} ${pc(s.actualMargin).padStart(8)}` +
      ` ${n(s.suggestedPrice).padStart(11)} ${n(s.shortfall).padStart(8)}` +
      `${s.losesMoney ? "  ← LOSES MONEY" : ""}${s.stale ? "  (no costing)" : ""}`,
  );
}

console.log("\n── the flattering number against the honest one");
for (const s of styles.slice(0, 3)) {
  console.log(
    `   ${s.code.padEnd(10)} margin on transfer price alone ${pc(s.grossMargin).padStart(7)}` +
      `   margin after the shop ${pc(s.actualMargin).padStart(7)}`,
  );
}

const first = styles.find((s) => s.retailPrice && s.trueCost);
if (first) {
  const { style, ladder } = await priceStyle(brand.id, first.styleId);
  console.log(
    `\n── ${style.code}: what a discount really costs  (true cost ${n(style.trueCost)}, priced ${n(style.retailPrice)})`,
  );
  console.log("   discount     price     profit    margin   profit given up");
  for (const rung of ladder) {
    console.log(
      `   ${(Number(rung.discount) * 100).toFixed(0).padStart(6)}%  ${n(rung.price).padStart(9)}` +
        `  ${n(rung.profit).padStart(9)}  ${pc(rung.margin).padStart(8)}` +
        `   ${rung.profitGivenUp ? pc(rung.profitGivenUp).padStart(13) : ""}` +
        `${rung.belowCost ? "  ← at a loss" : ""}`,
    );
  }
  console.log(
    `\n   floor at ${pc(style.minimumMargin)} margin: ${n(style.floor)}` +
      `   most you can take off: ${pc(style.discountRoom)}` +
      `   wipes out at: ${pc(style.wipeoutDiscount)}`,
  );
}

const gap = await pricingGap(brand.id);
console.log("\n── the gap");
console.log(`   ${gap.total} styles, ${gap.belowTarget} below target, ${gap.losingMoney} losing money, ${gap.unpriceable} with no costing`);
console.log(`   average shortfall ${n(gap.averageShortfall)} a garment, ${n(gap.monthlyValue)} across a month's volume`);

// Typing over the measurement must actually change the answer.
console.log("\n── overriding the rent (he says it is not fixed)");
const doubled = await brandPriceList(brand.id, {
  overrides: { monthlyOverhead: Number(basis.monthlyOverhead) * 2 },
});
console.log(`   overhead per garment  ${n(basis.overheadPerUnit)} → ${n(doubled.basis.overheadPerUnit)}`);
console.log(`   measured?             ${basis.overheadMeasured} → ${doubled.basis.overheadMeasured}`);
const before = styles[0];
const after = doubled.styles.find((s) => s.styleId === before.styleId)!;
console.log(`   ${before.code} should be priced  ${n(before.suggestedPrice)} → ${n(after.suggestedPrice)}`);

await db.$disconnect();
