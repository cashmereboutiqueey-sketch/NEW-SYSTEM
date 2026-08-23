/**
 * A personal account for the owner, made before any seeded password changes.
 *
 * The order matters. Changing the seeded owner's password first would leave
 * nobody able to sign in if anything about the new one went wrong — a locked
 * door with the key on the inside. This creates a second way in, proves it
 * works, and only then is the old one safe to touch.
 *
 * The temporary password is generated here and printed once. It is not stored
 * anywhere, not written to a file, and not put in the audit trail — the trail
 * records that an account was made, never what it opens with. The account
 * cannot do anything until that password is replaced.
 *
 *   OWNER_EMAIL=you@example.com OWNER_NAME="Your Name" \
 *     npx tsx --conditions=react-server scripts/create-owner-account.ts
 */
import "dotenv/config";
import { randomInt } from "node:crypto";
import { db } from "../src/lib/db";
import { createUser } from "../src/lib/users";

const email = (process.env.OWNER_EMAIL ?? "").trim();
const name = (process.env.OWNER_NAME ?? "").trim();

if (!email || !name) {
  console.error("Set OWNER_EMAIL and OWNER_NAME.");
  process.exit(1);
}

/**
 * Readable on a keyboard and still hard to guess.
 *
 * No l, I, 1, O or 0: this gets typed once from a screen, and a password
 * somebody mistypes three times is a password they write on a note.
 */
function temporaryPassword(): string {
  const letters = "abcdefghjkmnpqrstuvwxyz";
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const symbols = "!@#$%&*";
  const all = letters + upper + digits + symbols;

  // One of each kind first, so it cannot come out as eighteen lower-case
  // letters by chance.
  const required = [
    letters[randomInt(letters.length)],
    upper[randomInt(upper.length)],
    digits[randomInt(digits.length)],
    symbols[randomInt(symbols.length)],
  ];
  const rest = Array.from({ length: 14 }, () => all[randomInt(all.length)]);

  const chars = [...required, ...rest];
  // Fisher–Yates, so the required four are not always at the front.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

const existing = await db.user.findUnique({ where: { email: email.toLowerCase() } });
if (existing) {
  console.log(`   ${email} already exists as ${existing.role}.`);
  console.log("   Use the password reset on /users rather than making a second one.");
  await db.$disconnect();
  process.exit(0);
}

const password = temporaryPassword();

// Made by the seeded owner, because somebody has to be the actor and the
// trail should say which account was used to create this one.
const actor = await db.user.findFirstOrThrow({ where: { role: "OWNER" } });

const created = await createUser(
  { name, email, role: "OWNER", password, locale: "ar" },
  { userId: actor.id, reason: "Personal owner account, created before rotating the seeded ones." },
);

console.log("\n   account created\n");
console.log(`     email     ${created.email}`);
console.log(`     password  ${password}`);
console.log(`     role      OWNER`);
console.log("\n   It must be changed at first sign-in — the account can do nothing until it is.");
console.log("   This is the only time it is shown. Nothing wrote it down.\n");

await db.$disconnect();
