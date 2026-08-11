/**
 * One consignor with goods on the rail and one sale, on the real data.
 *
 *   npx tsx --conditions=react-server scripts/seed-consignment.ts
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import {
  createConsignor,
  receiveConsignment,
  sellConsignedItem,
  totalOwedToConsignors,
} from "../src/lib/consignment";
import { dec } from "../src/lib/money";

const owner = await db.user.findFirstOrThrow({ where: { role: "OWNER" } });
const ctx = { userId: owner.id, reason: null };
const alx = await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } });

const existing = await db.consignor.findFirst({ where: { code: "MAISON" } });
if (existing) {
  console.log(`${existing.name} is already set up.`);
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

const { id: consignorId } = await createConsignor(
  {
    code: "MAISON",
    name: "ميزون نور",
    commissionRate: "0.25",
    settlementDays: 14,
    phone: "01234567891",
  },
  ctx,
);
console.log("consignor: ميزون نور at 25%");

const lotsBefore = await db.inventoryLot.count();

const item = await receiveConsignment(
  {
    consignorId,
    description: "فستان سواريه مطرز",
    size: "M",
    colour: "أحمر",
    quantity: 4,
    retailPrice: "3200",
    locationId: alx.id,
    receivedDate: new Date(),
    expiresAt: new Date(Date.now() + 60 * 86_400_000),
  },
  ctx,
);
console.log(`took in ${item.itemCode}: 4 dresses at 3,200`);
console.log(`inventory lots before ${lotsBefore}, after ${await db.inventoryLot.count()} — unchanged`);

const before = {
  drawer: await balance("1115"),
  commission: await balance("4160"),
  owed: await balance("2500"),
  ownSales: await balance("4130"),
};

const sale = await sellConsignedItem(
  { itemId: item.id, quantity: 1, paymentMethod: "CASH", saleDate: new Date() },
  ctx,
);

const after = {
  drawer: await balance("1115"),
  commission: await balance("4160"),
  owed: await balance("2500"),
  ownSales: await balance("4130"),
};

console.log(`\nsold ${sale.saleNumber} for ${sale.total}`);
console.log(`   your commission     ${sale.commission}`);
console.log(`   owed to the owner   ${sale.owedToOwner}`);
console.log(`\n   drawer        ${before.drawer.toFixed(2)} → ${after.drawer.toFixed(2)}`);
console.log(`   commission    ${before.commission.negated().toFixed(2)} → ${after.commission.negated().toFixed(2)}`);
console.log(`   owed to them  ${before.owed.negated().toFixed(2)} → ${after.owed.negated().toFixed(2)}`);
console.log(`   your own sales ${before.ownSales.negated().toFixed(2)} → ${after.ownSales.negated().toFixed(2)} — untouched`);

console.log(`\nholding ${(await totalOwedToConsignors()).toFixed(2)} that is not yours.`);
await db.$disconnect();
