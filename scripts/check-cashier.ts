/**
 * Create a real cashier and show what she can and cannot reach.
 *
 * The authorisation model was written long before anybody could be given a
 * login, so this walks the whole point of the users screen: make the account,
 * sign in as her, and confirm the till opens and the books do not.
 *
 *   npx tsx --conditions=react-server scripts/check-cashier.ts
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { createUser, changeOwnPassword } from "../src/lib/users";
import { verifyPassword } from "../src/core/password";
import { can, permissionsFor } from "../src/core/permissions";

const owner = await db.user.findFirstOrThrow({ where: { role: "OWNER" } });
const ctx = { userId: owner.id, reason: null };

await db.user.deleteMany({ where: { email: "heba@cashmere.eg" } });

console.log("── the owner creates a cashier");
const { id } = await createUser(
  {
    name: "هبة سالم",
    email: "heba@cashmere.eg",
    role: "POS_CASHIER",
    password: "temp-pass-2026",
  },
  ctx,
);
console.log("   heba@cashmere.eg, temporary password handed over");

console.log("\n── she signs in");
const row = await db.user.findUniqueOrThrow({ where: { id } });
console.log(`   password accepted: ${await verifyPassword("temp-pass-2026", row.passwordHash)}`);
console.log(`   role: ${row.role}`);

const before = await db.user.findUniqueOrThrow({ where: { id } });
console.log(`   must change password first: ${before.mustChangePassword}`);

console.log("\n── she makes the password her own");
await changeOwnPassword(
  { userId: id, currentPassword: "temp-pass-2026", newPassword: "heba-owns-this-1" },
  { userId: id, reason: null },
);
const after = await db.user.findUniqueOrThrow({ where: { id } });
console.log(`   must change password now: ${after.mustChangePassword}`);
console.log(`   old password still works: ${await verifyPassword("temp-pass-2026", after.passwordHash)}`);
console.log(`   new password works: ${await verifyPassword("heba-owns-this-1", after.passwordHash)}`);

console.log("\n── what she can reach");
const checks = [
  ["ring up a sale", "pos:operate"],
  ["close her own till", "pos:close_shift"],
  ["see customers", "customer:view"],
] as const;
for (const [what, permission] of checks) {
  console.log(`   ${can("POS_CASHIER", permission) ? "yes" : "NO "}  ${what}`);
}

console.log("\n── what she cannot");
const denied = [
  ["see salaries", "salary:view"],
  ["discount a garment", "sales_order:discount"],
  ["let somebody pay later", "sales_order:credit"],
  ["see the factory's minute rate", "minute_rate:view"],
  ["change settings", "settings:manage"],
  ["manage other people", "user:manage"],
] as const;
for (const [what, permission] of denied) {
  console.log(`   ${can("POS_CASHIER", permission) ? "LEAKS!" : "no   "}  ${what}`);
}

console.log(
  `\n   a cashier holds ${permissionsFor("POS_CASHIER").length} permissions; an owner holds ${permissionsFor("OWNER").length}.`,
);

await db.$disconnect();
