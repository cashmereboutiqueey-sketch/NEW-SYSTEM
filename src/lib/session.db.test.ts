import "dotenv/config";
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { SignJWT } from "jose";
import { db } from "./db";
import { authorize, hashPassword } from "./auth";
import { createSession, destroySession, getSession } from "./session";
import { changeOwnPassword, resetPassword, setUserActive, setUserRole } from "./users";

// Only the Next request cookie adapter is replaced. JWT signing, authorization,
// user-management services and the isolated PostgreSQL database are real.
const { jar } = vi.hoisted(() => ({ jar: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => jar.has(name) ? { value: jar.get(name)! } : undefined,
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (name: string) => { jar.delete(name); },
  }),
}));

const EMAIL = "session-regression@qa.invalid";
const PASSWORD = "isolated-session-fixture-9";
const SECRET = "isolated-session-signing-fixture-32-characters";
const COOKIE = "cashmere_session";
let ownerId: string;
let userId: string;
let passwordHash: string;
const actor = () => ({ userId: ownerId, reason: "session regression" });

beforeAll(async () => {
  vi.stubEnv("AUTH_SECRET", SECRET);
  ownerId = (await db.user.findFirstOrThrow({ where: { email: "owner@cashmere.eg" } })).id;
  passwordHash = await hashPassword(PASSWORD);
});

beforeEach(async () => {
  jar.clear();
  const state = { passwordHash, role: "OWNER" as const, isActive: true,
    mustChangePassword: false, sessionVersion: 0, failedLogins: 0, lockedUntil: null };
  const user = await db.user.upsert({
    where: { email: EMAIL },
    create: { email: EMAIL, name: "Isolated session regression", ...state },
    update: state,
  });
  userId = user.id;
  await createSession({ userId, sessionVersion: user.sessionVersion });
});

afterAll(async () => {
  jar.clear();
  await db.user.deleteMany({ where: { email: EMAIL } });
  vi.unstubAllEnvs();
  await db.$disconnect();
});

describe("existing session authority against current database state", () => {
  it("reads the current role rather than retaining the role at login", async () => {
    await expect(authorize("settings:manage")).resolves.toMatchObject({ role: "OWNER" });
    await setUserRole({ userId, role: "VIEWER" }, actor());
    await expect(getSession()).resolves.toMatchObject({ role: "VIEWER" });
    await expect(authorize("settings:manage")).rejects.toThrow();
  });

  it("rejects a disabled account and keeps the old cookie revoked after reactivation", async () => {
    await setUserActive({ userId, isActive: false }, actor());
    await expect(getSession()).resolves.toBeNull();
    await setUserActive({ userId, isActive: true }, actor());
    await expect(getSession()).resolves.toBeNull();
  });

  it("rejects the old cookie after reset and blocks actions under the temporary password", async () => {
    await resetPassword({ userId, password: "isolated-reset-fixture-8" }, actor());
    await expect(getSession()).resolves.toBeNull();
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    await createSession({ userId, sessionVersion: user.sessionVersion });
    await expect(getSession()).resolves.toMatchObject({ mustChangePassword: true });
    await expect(authorize("settings:manage")).rejects.toThrow(/temporary password/);
  });

  it("keeps a replacement cookie after self-change while rejecting another device's cookie", async () => {
    const otherDeviceCookie = jar.get(COOKIE)!;
    const { sessionVersion } = await changeOwnPassword(
      { userId, currentPassword: PASSWORD, newPassword: "isolated-chosen-fixture-7" },
      { userId, reason: "session regression" },
    );
    await expect(getSession()).resolves.toBeNull();
    await createSession({ userId, sessionVersion });
    const replacementCookie = jar.get(COOKIE)!;
    await expect(authorize("settings:manage")).resolves.toMatchObject({ userId });
    jar.set(COOKIE, otherDeviceCookie);
    await expect(getSession()).resolves.toBeNull();
    jar.set(COOKIE, replacementCookie);
    await expect(getSession()).resolves.toMatchObject({ userId, mustChangePassword: false });
  });

  it("requires password replacement at the action boundary without rendering a page", async () => {
    await db.user.update({ where: { id: userId }, data: { mustChangePassword: true } });
    await expect(authorize("settings:manage")).rejects.toThrow(/temporary password/);
  });

  it("rejects legacy role-bearing cookies without a session version", async () => {
    const token = await new SignJWT({ userId, role: "OWNER", email: EMAIL, name: "Legacy fixture" })
      .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));
    jar.set(COOKIE, token);
    await expect(getSession()).resolves.toBeNull();
  });

  it("removes this browser's cookie on logout", async () => {
    await expect(getSession()).resolves.toMatchObject({ userId });
    await destroySession();
    expect(jar.has(COOKIE)).toBe(false);
    await expect(getSession()).resolves.toBeNull();
  });
});
