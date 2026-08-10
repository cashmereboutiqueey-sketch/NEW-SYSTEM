/**
 * Mark an account as still carrying a password somebody else chose.
 *
 * Useful for checking that the forced-change gate actually holds, and for
 * pushing an existing account through it — which is how the seeded default
 * passwords get retired.
 *
 *   npx tsx --conditions=react-server scripts/flag-temp-password.ts <email>
 */
import "dotenv/config";
import { db } from "../src/lib/db";

const email = (process.argv[2] ?? "").trim().toLowerCase();
if (!email) {
  console.error("Give an email address.");
  process.exit(1);
}

const user = await db.user.findUnique({ where: { email } });
if (!user) {
  console.error(`No account for ${email}.`);
  await db.$disconnect();
  process.exit(1);
}

await db.user.update({
  where: { id: user.id },
  data: { mustChangePassword: true },
});

console.log(`${email} must now change their password before reaching any screen.`);
await db.$disconnect();
