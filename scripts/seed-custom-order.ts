/**
 * One custom order in progress, so the screen has something real on it.
 *
 *   npx tsx --conditions=react-server scripts/seed-custom-order.ts
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { takeCustomOrder, depositsHeld, customOrderList } from "../src/lib/custom-orders";

const owner = await db.user.findFirstOrThrow({ where: { role: "OWNER" } });
const ctx = { userId: owner.id, reason: null };

const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });
const alx = await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } });
const variant = await db.variant.findFirstOrThrow({
  include: { style: true, colorCode: true, sizeCode: true },
});

const existing = await db.customOrder.findFirst({ where: { status: "PENDING" } });
if (existing) {
  console.log(`${existing.orderNumber} is already open — nothing to do.`);
  await db.$disconnect();
  process.exit(0);
}

const customer =
  (await db.customer.findFirst({ where: { code: "DEMO-CUSTOM" } })) ??
  (await db.customer.create({
    data: {
      code: "DEMO-CUSTOM",
      name: "ياسمين الشريف",
      phone: "01055443322",
      creditLimit: "3000",
      creditDays: 14,
    },
  }));

const today = new Date();
const taken = await takeCustomOrder(
  {
    customerId: customer.id,
    variantId: variant.id,
    quantity: 1,
    agreedUnitPrice: "4200",
    deposit: { amount: "1500", method: "CASH" },
    entityId: brand.id,
    locationId: alx.id,
    orderDate: today,
    promisedDate: new Date(today.getTime() + 14 * 86_400_000),
    notes: "طول إضافي 5 سم، وبطانة حرير",
  },
  ctx,
);

console.log(
  `${taken.orderNumber}: ${variant.style.nameAr} ${variant.colorCode.nameAr} ${variant.sizeCode.code}`,
);
console.log(`agreed ${taken.agreedTotal}, deposit ${taken.deposit}`);

const row = (await customOrderList()).find((o) => o.orderNumber === taken.orderNumber)!;
console.log(`uncovered if she never collects: ${row.atRisk}`);
console.log(`deposits held across all open orders: ${(await depositsHeld()).toString()}`);

await db.$disconnect();
