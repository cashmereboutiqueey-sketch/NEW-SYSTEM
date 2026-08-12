/**
 * Dead stock on both sides of the business.
 *
 * The Factory's dead stock is cloth, and it is usually the larger problem:
 * fabric ties up more cash for longer than finished garments do. It was
 * unreachable from the Factory side entirely — the report handled it, the
 * navigation never offered it.
 *
 *   npx tsx --conditions=react-server scripts/check-dead-stock.ts
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { deadStock } from "../src/lib/analytics";

for (const kind of ["FACTORY", "BRAND"] as const) {
  const entity = await db.entity.findFirstOrThrow({ where: { kind } });
  const report = await deadStock(entity.id);

  console.log(`\n── ${entity.nameAr} (${kind})`);
  console.log(
    `   ${report.rows.length} lots, ${report.total.toFixed(2)} at cost, ` +
      `${report.stale.toFixed(2)} standing over 90 days`,
  );

  const byState = new Map<string, { lots: number; value: number }>();
  for (const row of report.rows) {
    const at = byState.get(row.state) ?? { lots: 0, value: 0 };
    at.lots += 1;
    at.value += Number(row.value);
    byState.set(row.state, at);
  }

  for (const [state, at] of byState) {
    console.log(`   ${state.padEnd(16)} ${at.lots} lots   ${at.value.toFixed(2)}`);
  }

  const oldest = report.rows[0];
  if (oldest) {
    console.log(
      `   oldest: ${oldest.nameAr} (${oldest.code}) — received ` +
        `${oldest.receivedDate.toISOString().slice(0, 10)}, ${Number(oldest.value).toFixed(2)}`,
    );
  }
}

await db.$disconnect();
