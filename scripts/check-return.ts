/**
 * Take a real garment back on the real data, and show what moved.
 *
 *   npx tsx --conditions=react-server scripts/check-return.ts
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { recordReturn, returnableLines } from "../src/lib/returns";
import { dec } from "../src/lib/money";

const owner = await db.user.findFirstOrThrow({ where: { role: "OWNER" } });
const ctx = { userId: owner.id, reason: null };

const order = await db.salesOrder.findFirst({
  where: { status: { not: "CANCELLED" }, lines: { some: {} } },
  orderBy: { orderDate: "desc" },
  include: { lines: true },
});
if (!order) {
  console.log("No sales orders to return from.");
  await db.$disconnect();
  process.exit(0);
}

async function balance(code: string) {
  const account = await db.account.findUniqueOrThrow({ where: { code } });
  const rows = await db.journalLine.findMany({
    where: { accountId: account.id, journalEntry: { status: "POSTED" } },
    select: { debit: true, credit: true },
  });
  return rows.reduce((s, r) => s.plus(dec(r.debit)).minus(dec(r.credit)), dec(0));
}

async function onHand(variantId: string, locationId: string) {
  const agg = await db.inventoryLot.aggregate({
    where: { variantId, locationId, remainingQty: { gt: 0 } },
    _sum: { remainingQty: true },
  });
  return Number(agg._sum.remainingQty ?? 0);
}

if (!order.locationId) {
  console.log(`${order.orderNumber} has no location, so nothing can be restocked.`);
  await db.$disconnect();
  process.exit(0);
}
const locationId = order.locationId;

const picture = await returnableLines(order.id);
const line = picture.lines.find((l) => l.returnable > 0);
if (!line) {
  console.log(`${order.orderNumber} has nothing left to return.`);
  await db.$disconnect();
  process.exit(0);
}

console.log(`── ${order.orderNumber}, ${picture.order.daysOld} days old`);
console.log(`   ${line.styleName} ${line.colour} ${line.size}`);
console.log(`   sold ${line.sold}, returnable ${line.returnable}`);
console.log(`   they paid ${line.unitPrice} each; it cost the shop ${line.unitCost}`);

const before = {
  stock: await onHand(line.variantId, locationId),
  returns: await balance("4210"),
  cogs: await balance("5300"),
  drawer: await balance("1115"),
};

const result = await recordReturn(
  {
    salesOrderId: order.id,
    variantId: line.variantId,
    quantity: 1,
    disposition: "RESTOCK",
    refundMethod: "CASH",
    reason: "المقاس مش مظبوط",
    returnDate: new Date(),
  },
  ctx,
);

const after = {
  stock: await onHand(line.variantId, locationId),
  returns: await balance("4210"),
  cogs: await balance("5300"),
  drawer: await balance("1115"),
};

console.log(`\n── ${result.returnNumber}`);
console.log(`   refunded ${result.refunded}, restocked ${result.restocked}`);
console.log(`   on the shelf:     ${before.stock} → ${after.stock}`);
console.log(`   sales returns:    ${before.returns.toFixed(2)} → ${after.returns.toFixed(2)}`);
console.log(`   cost of sales:    ${before.cogs.toFixed(2)} → ${after.cogs.toFixed(2)}`);
console.log(`   till drawer:      ${before.drawer.toFixed(2)} → ${after.drawer.toFixed(2)}`);

const lot = await db.inventoryLot.findFirstOrThrow({
  where: { variantId: line.variantId, movements: { some: { referenceId: result.returnNumber } } },
});
console.log(
  `\n   back at cost ${Number(lot.unitCost).toFixed(2)} (left at ${Number(line.unitCost).toFixed(2)}),` +
    ` dated ${lot.receivedDate.toISOString().slice(0, 10)} — not today`,
);

await db.$disconnect();
