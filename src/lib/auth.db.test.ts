import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { authenticate, hashPassword, verifyPassword } from "./auth";

/**
 * Whether a person can actually sign in.
 *
 * There was no test for this at all, which is how a broken login reached the
 * running application: the audit had checked that /login returns 200, and a
 * page that renders is a different claim from an authentication path that
 * works. The failure was a Prisma client that did not yet know about the
 * lockout columns — invisible to typechecking, invisible to the build,
 * invisible to every other test, and fatal to the one thing every user does
 * first.
 *
 * These run against the real database because the lockout is state on a row,
 * and a lockout that only exists in memory is not a lockout.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const EMAIL = "auth-test@cashmere.eg";
const PASSWORD = "a-genuinely-fine-password";

let userId: string;

beforeAll(async () => {
  const user = await db.user.upsert({
    where: { email: EMAIL },
    update: { passwordHash: await hashPassword(PASSWORD), isActive: true },
    create: {
      email: EMAIL,
      name: "Auth Test",
      passwordHash: await hashPassword(PASSWORD),
      role: "VIEWER",
      isActive: true,
    },
  });
  userId = user.id;
});

beforeEach(async () => {
  await db.user.update({
    where: { id: userId },
    data: { failedLogins: 0, lockedUntil: null, isActive: true },
  });
});

afterAll(async () => {
  await db.user.deleteMany({ where: { email: EMAIL } });
  await db.$disconnect();
});

describe("hashing", () => {
  it("does not store the password itself", async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash).not.toContain(PASSWORD);
    expect(hash.startsWith("$2")).toBe(true);
  });

  it("salts, so the same password hashes differently every time", async () => {
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
  });

  it("still recognises the password afterwards", async () => {
    const hash = await hashPassword(PASSWORD);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword("something else", hash)).toBe(false);
  });
});

describe("signing in", () => {
  it("lets the right password through", async () => {
    const session = await authenticate(EMAIL, PASSWORD);
    expect(session).not.toBeNull();
    expect(session!.email).toBe(EMAIL);
    expect(session!.role).toBe("VIEWER");
    expect(session!.userId).toBe(userId);
  });

  it("refuses the wrong password", async () => {
    expect(await authenticate(EMAIL, "not it")).toBeNull();
  });

  it("refuses an address nobody has", async () => {
    expect(await authenticate("ghost@cashmere.eg", PASSWORD)).toBeNull();
  });

  it("accepts the address as people actually type it", async () => {
    // Somebody's phone capitalises the first letter and the keyboard adds a
    // trailing space. Neither is a different account.
    expect(await authenticate(`  ${EMAIL.toUpperCase()} `, PASSWORD)).not.toBeNull();
  });

  it("refuses an account that has been switched off", async () => {
    await db.user.update({ where: { id: userId }, data: { isActive: false } });
    expect(await authenticate(EMAIL, PASSWORD)).toBeNull();
  });

  it("records when the person last signed in", async () => {
    const before = new Date();
    await authenticate(EMAIL, PASSWORD);
    const row = await db.user.findUniqueOrThrow({ where: { id: userId } });
    expect(row.lastLoginAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });

  it("hands the browser nothing it could attack offline", async () => {
    const session = await authenticate(EMAIL, PASSWORD);
    // A bcrypt hash in the session would expose every account at once.
    expect(JSON.stringify(session)).not.toMatch(/\$2[aby]\$/);
    expect(session).not.toHaveProperty("passwordHash");
  });
});

describe("the lockout", () => {
  it("counts consecutive failures on the row, not in memory", async () => {
    await authenticate(EMAIL, "wrong");
    await authenticate(EMAIL, "wrong");
    const row = await db.user.findUniqueOrThrow({ where: { id: userId } });
    expect(row.failedLogins).toBe(2);
  });

  it("forgets the run once the person gets in", async () => {
    await authenticate(EMAIL, "wrong");
    await authenticate(EMAIL, "wrong");
    await authenticate(EMAIL, PASSWORD);
    const row = await db.user.findUniqueOrThrow({ where: { id: userId } });
    expect(row.failedLogins).toBe(0);
    expect(row.lockedUntil).toBeNull();
  });

  it("locks the account after eight wrong guesses", async () => {
    for (let i = 0; i < 8; i++) await authenticate(EMAIL, "wrong");
    const row = await db.user.findUniqueOrThrow({ where: { id: userId } });
    expect(row.failedLogins).toBe(8);
    expect(row.lockedUntil).not.toBeNull();
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it("does not lock on the seventh, so a forgetful person is not punished", async () => {
    for (let i = 0; i < 7; i++) await authenticate(EMAIL, "wrong");
    const row = await db.user.findUniqueOrThrow({ where: { id: userId } });
    expect(row.lockedUntil).toBeNull();
    expect(await authenticate(EMAIL, PASSWORD)).not.toBeNull();
  });

  it("refuses even the correct password while locked", async () => {
    for (let i = 0; i < 8; i++) await authenticate(EMAIL, "wrong");
    // This is the whole point. A lockout that yields to the right password
    // stops nobody, because the attacker is trying to find the right password.
    expect(await authenticate(EMAIL, PASSWORD)).toBeNull();
  });

  it("opens again once the lockout has expired", async () => {
    for (let i = 0; i < 8; i++) await authenticate(EMAIL, "wrong");
    await db.user.update({
      where: { id: userId },
      data: { lockedUntil: new Date(Date.now() - 60_000) },
    });
    expect(await authenticate(EMAIL, PASSWORD)).not.toBeNull();

    const row = await db.user.findUniqueOrThrow({ where: { id: userId } });
    expect(row.failedLogins).toBe(0);
    expect(row.lockedUntil).toBeNull();
  });

  it("survives a restart, because the count is on the row", async () => {
    for (let i = 0; i < 8; i++) await authenticate(EMAIL, "wrong");

    // A second client is as close to a restarted server as a test can get:
    // nothing is shared but the database.
    const fresh = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
    });
    const row = await fresh.user.findUniqueOrThrow({ where: { id: userId } });
    await fresh.$disconnect();

    expect(row.lockedUntil).not.toBeNull();
    expect(await authenticate(EMAIL, PASSWORD)).toBeNull();
  });
});

describe("what an attacker learns", () => {
  it("takes a comparable time for an unknown address as a wrong password", async () => {
    // If a missing account answers instantly and a real one takes a quarter of
    // a second, the login page becomes a way to enumerate staff addresses.
    const time = async (fn: () => Promise<unknown>) => {
      const at = performance.now();
      await fn();
      return performance.now() - at;
    };

    const unknown = await time(() => authenticate("nobody@cashmere.eg", PASSWORD));
    const wrong = await time(() => authenticate(EMAIL, "wrong"));

    // Generous, because CI machines are noisy. It is the order of magnitude
    // that matters: what must not happen is one returning in ~0ms.
    expect(unknown).toBeGreaterThan(20);
    expect(wrong).toBeGreaterThan(20);
  });

  it("gives a locked account the same silence as a wrong password", async () => {
    for (let i = 0; i < 8; i++) await authenticate(EMAIL, "wrong");
    // Both are null. Saying "this account is locked" would confirm the address
    // exists and tell the attacker their guessing had an effect.
    expect(await authenticate(EMAIL, PASSWORD)).toBeNull();
    expect(await authenticate(EMAIL, "wrong")).toBeNull();
  });
});
