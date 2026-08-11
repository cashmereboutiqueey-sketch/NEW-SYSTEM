/**
 * Raise a purchase order and show where it does — and does not — appear.
 *
 * Ordering is not owing: nothing posts and payables do not move, because a
 * supplier is owed when their goods arrive. What must never happen is the
 * order vanishing, which is what an approval step quietly caused.
 *
 *   npx tsx --conditions=react-server scripts/check-purchase-visibility.ts
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { createPurchaseOrder } from "../src/lib/purchasing";
import { cashForecast } from "../src/lib/cash-flow";
import { dec } from "../src/lib/money";

const owner = await db.user.findFirstOrThrow({ where: { role: "OWNER" } });
const ctx = { userId: owner.id, reason: null };

const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });
const supplier = await db.supplier.findFirstOrThrow();
const material = await db.material.findFirstOrThrow();
const period = await db.fiscalPeriod.findFirstOrThrow({
  where: { status: "OPEN" },
  orderBy: { startDate: "asc" },
});
const day = new Date(period.startDate);

async function payables() {
  const account = await db.account.findUniqueOrThrow({ where: { code: "2110" } });
  const rows = await db.journalLine.findMany({
    where: { accountId: account.id, journalEntry: { status: "POSTED" } },
    select: { debit: true, credit: true },
  });
  return rows.reduce((s, r) => s.plus(dec(r.credit)).minus(dec(r.debit)), dec(0));
}

async function forecast(kind: string) {
  const f = await cashForecast(factory.id);
  return f.weeks
    .flatMap((w) => w.lines)
    .filter((l) => l.kind === kind)
    .reduce((s, l) => s.plus(dec(l.amount)), dec(0));
}

const before = {
  journals: await db.journalEntry.count(),
  payable: await payables(),
};

const created = await createPurchaseOrder(
  {
    supplierId: supplier.id,
    orderDate: day,
    expectedDate: day,
    lines: [{ materialId: material.id, quantity: 500, unitPrice: 168 }],
  },
  ctx,
);

const order = await db.purchaseOrder.findUniqueOrThrow({
  where: { id: created.purchaseOrderId },
  include: { lines: true },
});
const value = order.lines.reduce(
  (s, l) => s.plus(dec(l.effectiveCost).times(dec(l.quantity))),
  dec(0),
);

console.log(`── raised ${order.poNumber} — ${supplier.nameAr} — ${value.toFixed(2)}`);
console.log(`   status: ${order.status}`);

console.log("\n── what it did to the books");
console.log(`   journal entries   ${before.journals} → ${await db.journalEntry.count()}   (nothing posts)`);
console.log(`   payables          ${before.payable.toFixed(2)} → ${(await payables()).toFixed(2)}   (nothing owed yet)`);

console.log("\n── where it does show");
console.log(`   awaiting approval ${(await forecast("AWAITING_APPROVAL")).toFixed(2)}`);
console.log(`   committed         ${(await forecast("PURCHASE_COMMITMENT")).toFixed(2)}`);

console.log(
  "\n   A supplier is owed when the goods arrive. Until then it is a promise" +
    "\n   to buy — visible in the forecast, absent from the ledger.",
);

await db.$disconnect();
