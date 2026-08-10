/**
 * Proves that a failure half-way through a business operation leaves nothing
 * behind.
 *
 * Each case drives a real service to a point where it must fail, then counts
 * the rows that would have been written by the successful path. A partial
 * write here is the worst kind of bug in an accounting system: the ledger and
 * the stock disagree, and nothing in the application will ever notice.
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { createSale } from "../src/lib/sales";
import { receiveFinishedGoods, issueMaterialToProduction } from "../src/lib/inventory";
import { despatchToBrand, receiveAtBrand } from "../src/lib/intercompany";
import { recordSettlement } from "../src/lib/reconciliation";
import { recordCount } from "../src/lib/stocktake";
import { completeProductionOrder } from "../src/lib/production";

const problems: string[] = [];
const ok = (m: string) => console.log(`   ✓ ${m}`);
const bad = (m: string) => { problems.push(m); console.log(`   ✗ ${m}`); };

const owner = await db.user.findFirstOrThrow({ where: { email: "owner@cashmere.eg" } });
const ctx = { userId: owner.id, reason: null };
const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });
const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });
const alx = await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } });
const fac = await db.location.findFirstOrThrow({ where: { code: "LOC-FAC" } });
const channel = await db.salesChannel.findFirstOrThrow();
const variant = await db.variant.findFirstOrThrow();
const material = await db.material.findFirstOrThrow({ where: { type: "FABRIC" } });

/** A snapshot of everything a partial write could leave behind. */
async function census() {
  const [entries, lines, lots, movements, orders, orderLines, payments, units, settlements] =
    await Promise.all([
      db.journalEntry.count(),
      db.journalLine.count(),
      db.inventoryLot.count(),
      db.inventoryMovement.count(),
      db.salesOrder.count(),
      db.salesOrderLine.count(),
      db.salesPayment.count(),
      db.garmentUnit.count(),
      db.settlement.count(),
    ]);
  return { entries, lines, lots, movements, orders, orderLines, payments, units, settlements };
}

function unchanged(before: Awaited<ReturnType<typeof census>>, after: Awaited<ReturnType<typeof census>>) {
  return Object.keys(before).filter(
    (k) => before[k as keyof typeof before] !== after[k as keyof typeof after],
  );
}

/** Runs an operation that must fail, and proves nothing was left behind. */
async function mustRollBack(name: string, run: () => Promise<unknown>) {
  const before = await census();
  let threw = false;
  try {
    await run();
  } catch {
    threw = true;
  }
  const after = await census();
  const drift = unchanged(before, after);

  if (!threw) {
    bad(`${name}: the operation succeeded when it should have failed`);
    return;
  }
  if (drift.length > 0) {
    bad(`${name}: left rows behind in ${drift.join(", ")}`);
    return;
  }
  ok(`${name}: failed cleanly, nothing written`);
}

console.log("\n── a sale for more stock than exists");
await mustRollBack("sale beyond stock", () =>
  createSale(
    {
      source: "MANUAL", channelId: channel.id, entityId: brand.id, locationId: alx.id,
      orderDate: new Date(),
      lines: [{ variantId: variant.id, quantity: 999_999, retailPrice: 1000, discountPct: 0 }],
      payments: [{ method: "CASH", amount: 999_999_000, fee: 0, collected: true }],
    },
    ctx,
  ),
);

console.log("\n── a sale whose payments do not add up");
await mustRollBack("sale with wrong payment total", () =>
  createSale(
    {
      source: "MANUAL", channelId: channel.id, entityId: brand.id, locationId: alx.id,
      orderDate: new Date(),
      lines: [{ variantId: variant.id, quantity: 1, retailPrice: 1000, discountPct: 0 }],
      payments: [{ method: "CASH", amount: 400, fee: 0, collected: true }],
    },
    ctx,
  ),
);

console.log("\n── issuing more material than the store holds");
await mustRollBack("over-issue of fabric", () =>
  issueMaterialToProduction(
    {
      materialId: material.id, locationId: fac.id, entityId: factory.id,
      quantity: "9999999", issueDate: new Date(),
    },
    ctx,
  ),
);

console.log("\n── finished goods whose material cost exceeds the total");
await mustRollBack("impossible cost split", () =>
  receiveFinishedGoods(
    {
      variantId: variant.id, locationId: fac.id, entityId: factory.id,
      quantity: "5", unitCost: "100", materialUnitCost: "500",
      receivedDate: new Date(),
    },
    ctx,
  ),
);

console.log("\n── despatching more than the factory holds");
await mustRollBack("over-despatch", async () => {
  const snapshot = await db.costSnapshot.findFirstOrThrow();
  return despatchToBrand(
    {
      variantId: variant.id, quantity: "9999999", fromLocationId: fac.id,
      despatchDate: new Date(), costSnapshotId: snapshot.id,
    },
    ctx,
  );
});

console.log("\n── counting in more than was ever sent");
await mustRollBack("intake over the despatch note", async () => {
  const movement = await db.inventoryMovement.findFirst({
    where: { referenceType: "DESPATCH_NOTE" },
    include: { lot: true },
  });
  if (!movement) throw new Error("no despatch to test against");
  return receiveAtBrand(
    {
      despatchNumber: movement.referenceId!, variantId: movement.lot.variantId!,
      countedQty: "9999999", toLocationId: alx.id,
      receivedDate: new Date(), labelsPrinted: true,
    },
    ctx,
  );
});

console.log("\n── a remittance with an unexplained shortfall");
await mustRollBack("unexplained settlement gap", async () => {
  const pending = await db.salesPayment.findFirst({
    where: { status: "PENDING", method: "COD", settlementLine: null },
  });
  if (!pending) throw new Error("nothing outstanding to test against");
  return recordSettlement(
    {
      provider: "COURIER", entityId: brand.id, settlementDate: new Date(),
      netReceived: "1", paymentIds: [pending.id],
    },
    ctx,
  );
});

console.log("\n── a stock count over the approval limit with nobody approving");
await mustRollBack("unapproved large adjustment", async () => {
  const lot = await db.inventoryLot.findFirstOrThrow({
    where: { entityId: brand.id, remainingQty: { gt: 10 } },
  });
  return recordCount(
    { lotId: lot.id, countedQty: "0", reason: "audit test", countDate: new Date() },
    ctx,
  );
});

console.log("\n── closing a run against a SKU from another style");
await mustRollBack("output SKU from the wrong style", async () => {
  const order = await db.productionOrder.findFirst({
    where: { status: { in: ["CONFIRMED", "IN_PRODUCTION"] } },
  });
  if (!order) throw new Error("no open production order");
  const stranger = await db.variant.findFirstOrThrow({
    where: { styleId: { not: order.styleId } },
  });
  return completeProductionOrder(
    {
      productionOrderId: order.id,
      outputs: [{ variantId: stranger.id, goodQty: 5 }],
      locationId: fac.id, entityId: factory.id, completedDate: new Date(),
    },
    ctx,
  );
});

console.log("\n── the books after all of that");
const [row] = await db.$queryRaw<{ d: string; c: string }[]>`
  SELECT COALESCE(SUM(l."debit"),0)::text AS d, COALESCE(SUM(l."credit"),0)::text AS c
  FROM "journal_lines" l JOIN "journal_entries" e ON e."id" = l."journalEntryId"
  WHERE e."status" = 'POSTED'`;
if (row.d !== row.c) bad(`ledger out of balance: ${row.d} vs ${row.c}`);
else ok(`ledger still balances at ${Number(row.d).toFixed(2)}`);

console.log("\n" + "═".repeat(58));
if (problems.length === 0) console.log("Every failed operation rolled back completely.");
else {
  console.log(`${problems.length} atomicity problem(s):\n`);
  problems.forEach((p, i) => console.log(`${i + 1}. ${p}`));
}

await db.$disconnect();
process.exit(problems.length === 0 ? 0 : 1);
