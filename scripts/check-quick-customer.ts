/**
 * Walk the till's add-a-customer path against the real database.
 *
 *   npx tsx --conditions=react-server scripts/check-quick-customer.ts
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { createCustomer } from "../src/lib/master-data";
import { normalisePhone } from "../src/core/crm";

const ctx = { userId: null, reason: null };

async function lookup(phone: string) {
  const normalised = normalisePhone(phone);
  if (!normalised) return null;
  return db.customer.findFirst({
    where: { phoneNormalised: normalised, mergedIntoId: null, isActive: true },
    select: { id: true, name: true, code: true },
    orderBy: { createdAt: "asc" },
  });
}

await db.customer.deleteMany({ where: { name: { startsWith: "TillCheck" } } });

console.log("── a stranger at the counter");
const first = await lookup("01234567890");
console.log(`   looked up 01234567890 → ${first ? first.name : "nobody, so create"}`);

const { customer } = await createCustomer(
  { name: "TillCheck منى", phone: "01234567890", acquiredVia: "POS" } as never,
  ctx,
);
console.log(`   created ${customer.code} — ${customer.name} (${customer.phoneNormalised})`);

console.log("\n── she comes back next week, cashier types it differently");
for (const typed of ["+201234567890", "0123 456 7890", "00201234567890"]) {
  const found = await lookup(typed);
  console.log(
    `   "${typed}" → ${found ? `${found.name} (${found.code})` : "NOT FOUND — would duplicate"}`,
  );
}

console.log("\n── her sister, same family phone");
const clash = await createCustomer(
  { name: "TillCheck سارة", phone: "01234567890", acquiredVia: "POS" } as never,
  ctx,
);
console.log(
  `   created ${clash.customer.code}, flagged against ${clash.possibleDuplicate?.name ?? "nobody"}`,
);
console.log(`   lookup still offers the first: ${(await lookup("01234567890"))?.name}`);

await db.customer.deleteMany({ where: { name: { startsWith: "TillCheck" } } });
console.log("\ncleaned up");
await db.$disconnect();
