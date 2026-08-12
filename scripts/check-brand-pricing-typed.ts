/**
 * The same engine with the volume typed in, which is how it is meant to be used.
 *
 * Overhead absorbed over three garments a month is arithmetic, not pricing.
 * Absorption asks for the volume you expect to do.
 *
 *   npx tsx --conditions=react-server scripts/check-brand-pricing-typed.ts
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { brandPriceList, priceStyle } from "../src/lib/brand-pricing";

const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });
const overrides = { monthlyUnits: 120 };

const { basis, styles } = await brandPriceList(brand.id, { overrides });
const n = (v: unknown, dp = 2) => (v == null ? "—" : Number(v).toFixed(dp));
const pc = (v: unknown) => (v == null ? "—" : (Number(v) * 100).toFixed(1) + "%");

console.log(`── expecting ${n(basis.monthlyUnits, 0)} garments a month (${basis.unitsBasis})`);
console.log(`   overhead ${n(basis.monthlyOverhead)} a month ÷ ${n(basis.monthlyUnits, 0)} = ${n(basis.overheadPerUnit)} a garment`);
console.log(`   + marketing ${n(basis.marketingPerUnit)} + packaging ${n(basis.packagingPerUnit)} + shipping ${n(basis.shippingPerUnit)}`);
console.log(`   = ${n(basis.costToSellPerUnit)} to sell one garment`);
console.log(`   overhead bigger than the garment? ${basis.overheadDominates}`);

const priced = styles.filter((s) => s.trueCost);
console.log("\n── from the factory's price to the shop's");
for (const s of priced) {
  console.log(
    `   ${s.code}: pay factory ${n(s.transferPrice)} + shop ${n(s.costToSell)} + returns ${n(s.returnAllowance)} = ${n(s.trueCost)}`,
  );
  console.log(
    `      charging ${n(s.retailPrice)} → margin ${pc(s.actualMargin)}` +
      `   (on the transfer price alone it looks like ${pc(s.grossMargin)})`,
  );
  console.log(
    `      for a ${pc(s.targetMargin)} margin it should be ${n(s.suggestedPrice)}  (${Number(s.shortfall) > 0 ? "short by " + n(s.shortfall) : "already there"})`,
  );
  console.log(
    `      floor ${n(s.floor)} at ${pc(s.minimumMargin)} · room to discount ${pc(s.discountRoom)} · wipes out at ${pc(s.wipeoutDiscount)}`,
  );
}

const one = priced[0];
if (one) {
  const { ladder } = await priceStyle(brand.id, one.styleId, { overrides });
  console.log(`\n── ${one.code}: the ladder at ${n(one.retailPrice)}`);
  console.log("   off      price     profit    margin   of the profit, gone");
  for (const r of ladder) {
    console.log(
      `   ${(Number(r.discount) * 100).toFixed(0).padStart(3)}%  ${n(r.price).padStart(9)}  ${n(r.profit).padStart(9)}` +
        `  ${pc(r.margin).padStart(8)}   ${r.profitGivenUp ? pc(r.profitGivenUp).padStart(8) : "       —"}` +
        `${r.belowCost ? "  ← loss" : ""}`,
    );
  }
}

await db.$disconnect();
