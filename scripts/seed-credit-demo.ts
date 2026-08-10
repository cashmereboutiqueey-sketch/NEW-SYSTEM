/**
 * A part-paid sale on the real data, so the receivables screen has a customer
 * on it who genuinely owes money.
 *
 *   npx tsx --conditions=react-server scripts/seed-credit-demo.ts
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { createSale } from "../src/lib/sales";
import { collectPayment, customerBalances } from "../src/lib/receivables";

const owner = await db.user.findFirstOrThrow({ where: { role: "OWNER" } });
const ctx = { userId: owner.id, reason: null };

const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });
const alx = await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } });
const channel = await db.salesChannel.findFirstOrThrow();

const lot = await db.inventoryLot.findFirstOrThrow({
  where: { locationId: alx.id, remainingQty: { gt: 2 }, variantId: { not: null } },
});

const customer =
  (await db.customer.findFirst({ where: { code: "DEMO-CREDIT" } })) ??
  (await db.customer.create({
    data: {
      code: "DEMO-CREDIT",
      name: "منى فؤاد",
      phone: "01099887766",
      creditLimit: "5000",
      creditDays: 30,
    },
  }));

const sale = await createSale(
  {
    source: "MANUAL",
    channelId: channel.id,
    entityId: brand.id,
    locationId: alx.id,
    customerId: customer.id,
    orderDate: new Date(),
    lines: [{ variantId: lot.variantId!, quantity: 1, retailPrice: 1500, discountPct: 0 }],
    payments: [{ method: "CASH", amount: 1000, fee: 0, collected: true }],
  },
  ctx,
);
console.log(`sold ${sale.orderNumber} for ${Number(sale.netAmount).toFixed(2)}, took 1000`);

const before = (await customerBalances()).find((b) => b.customerId === customer.id);
console.log(
  `owes ${before?.outstanding}, room left ${before?.headroom}, due ${before?.oldestDue?.toISOString().slice(0, 10)}`,
);

const collected = await collectPayment(
  { salesOrderId: sale.salesOrderId, method: "CASH", amount: "300", collectedOn: new Date() },
  ctx,
);
console.log(`collected 300 — still owed ${collected.stillOwed}`);

console.log("Open /receivables to see it.");
await db.$disconnect();
