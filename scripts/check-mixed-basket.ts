/**
 * Ring up one basket holding both kinds of garment, on the real data.
 *
 * The customer pays once. Underneath, two documents: a sales order for the
 * shop's own goods and a consignment sale for the other label's. What this
 * prints is the split — takings against earnings — because they are different
 * numbers and only one of them is the shop's.
 *
 *   npx tsx --conditions=react-server scripts/check-mixed-basket.ts
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { createSale } from "../src/lib/sales";
import { sellConsignedItem, sellableConsignedStock, totalOwedToConsignors } from "../src/lib/consignment";
import { dec } from "../src/lib/money";

const owner = await db.user.findFirstOrThrow({ where: { role: "OWNER" } });
const ctx = { userId: owner.id, reason: null };

const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });
const alx = await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } });
const channel = await db.salesChannel.findFirstOrThrow();

const till = await db.posSession.findFirst({
  where: { locationId: alx.id, closedAt: null },
});
if (!till) {
  console.log("No till is open. Run scripts/open-till.ts first.");
  await db.$disconnect();
  process.exit(1);
}

const own = await db.inventoryLot.findFirst({
  where: { locationId: alx.id, remainingQty: { gt: 1 }, variantId: { not: null } },
  include: { variant: { include: { style: true } } },
});
const consigned = (await sellableConsignedStock(alx.id))[0];

if (!own || !consigned) {
  console.log("Need both own stock and a consigned item on the rail.");
  await db.$disconnect();
  process.exit(1);
}

async function balance(code: string) {
  const account = await db.account.findUniqueOrThrow({ where: { code } });
  const rows = await db.journalLine.findMany({
    where: { accountId: account.id, journalEntry: { status: "POSTED" } },
    select: { debit: true, credit: true },
  });
  return rows.reduce((s, r) => s.plus(dec(r.debit)).minus(dec(r.credit)), dec(0));
}

const OWN_PRICE = 1500;
const before = {
  drawer: await balance("1115"),
  ownSales: await balance("4130"),
  commission: await balance("4160"),
  owed: await balance("2500"),
  cogs: await balance("5300"),
};

console.log("── the basket");
console.log(`   1 × ${own.variant!.style.nameAr} (yours) at ${OWN_PRICE}`);
console.log(
  `   1 × ${consigned.description} (${consigned.consignorName}) at ${consigned.retailPrice}`,
);
const basketTotal = OWN_PRICE + Number(consigned.retailPrice);
console.log(`   customer pays ${basketTotal.toFixed(2)}`);

// The shop's own goods first: if the consigned half then failed, no money
// would have been misrecorded.
const order = await createSale(
  {
    source: "POS",
    channelId: channel.id,
    entityId: brand.id,
    locationId: alx.id,
    posSessionId: till.id,
    orderDate: new Date(),
    lines: [{ variantId: own.variantId!, quantity: 1, retailPrice: OWN_PRICE, discountPct: 0 }],
    payments: [{ method: "CASH", amount: OWN_PRICE, fee: 0, collected: true }],
  },
  ctx,
);

const sale = await sellConsignedItem(
  {
    itemId: consigned.itemId,
    quantity: 1,
    soldPrice: consigned.retailPrice,
    paymentMethod: "CASH",
    posSessionId: till.id,
    saleDate: new Date(),
  },
  ctx,
);

const after = {
  drawer: await balance("1115"),
  ownSales: await balance("4130"),
  commission: await balance("4160"),
  owed: await balance("2500"),
  cogs: await balance("5300"),
};

const moved = (k: keyof typeof before, negate = false) => {
  const d = after[k].minus(before[k]);
  return (negate ? d.negated() : d).toFixed(2);
};

console.log(`\n── two documents: ${order.orderNumber} and ${sale.saleNumber}`);
console.log(`   into the drawer      ${moved("drawer")}   ← the whole basket`);
console.log(`   your own sales       ${moved("ownSales", true)}`);
console.log(`   your commission      ${moved("commission", true)}`);
console.log(`   owed to the owner    ${moved("owed", true)}   ← not yours`);
console.log(`   cost of sales        ${moved("cogs")}   ← only your own garment`);

const earned =
  Number(moved("ownSales", true)) + Number(moved("commission", true));
console.log(
  `\n   took ${moved("drawer")}, earned ${earned.toFixed(2)}. The difference is somebody else's money.`,
);
console.log(`   holding ${(await totalOwedToConsignors()).toFixed(2)} in total.`);

await db.$disconnect();
