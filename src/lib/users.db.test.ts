import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import {
  createUser,
  setUserRole,
  setUserActive,
  resetPassword,
  unlockUser,
  changeOwnPassword,
  listUsers,
  assignableRoles,
  UserError,
} from "./users";
import { authenticate } from "./auth";

/**
 * Who may sign in.
 *
 * Two things are being protected. The first is the audit trail: every journal
 * line names a person, so accounts are switched off and never deleted, and a
 * password is never shared between two people who could both be that name.
 *
 * The second is access to the system itself. Deactivating the last owner or
 * your own account is unrecoverable without a database console, and a shop
 * locked out of its own books at nine on a Saturday has no recourse at all.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const GOOD = "a-fine-password-9";
const ctx = { userId: null as string | null, reason: null };

let ownerId: string;

beforeAll(async () => {
  ownerId = (await db.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
});

beforeEach(async () => {
  await db.user.deleteMany({ where: { email: { endsWith: "@usertest.eg" } } });
});

afterAll(async () => {
  await db.user.deleteMany({ where: { email: { endsWith: "@usertest.eg" } } });
  await db.$disconnect();
});

const asOwner = () => ({ userId: ownerId, reason: null });

function newUser(over: Partial<Parameters<typeof createUser>[0]> = {}) {
  return createUser(
    {
      name: "هبة سالم",
      email: "cashier@usertest.eg",
      role: "POS_CASHIER",
      password: GOOD,
      ...over,
    },
    asOwner(),
  );
}

describe("creating an account", () => {
  it("makes somebody who can actually sign in", async () => {
    const { id } = await newUser();

    // The point of the whole screen: a cashier exists for the till to be
    // handed to.
    const session = await authenticate("cashier@usertest.eg", GOOD);
    expect(session).not.toBeNull();
    expect(session!.role).toBe("POS_CASHIER");
    expect(session!.userId).toBe(id);
  });

  it("hands over a password that is not theirs yet", async () => {
    const { id } = await newUser();
    const row = await db.user.findUniqueOrThrow({ where: { id } });
    // Somebody else chose it, so it must be replaced before any screen opens.
    expect(row.mustChangePassword).toBe(true);
  });

  it("stores the address in one form, however it was typed", async () => {
    await newUser({ email: "  Cashier@UserTest.EG " });
    expect(await db.user.findUnique({ where: { email: "cashier@usertest.eg" } })).toBeTruthy();
  });

  it("refuses an address somebody already has", async () => {
    await newUser();
    await expect(newUser({ name: "حد تاني" })).rejects.toThrow(/already has an account/i);
  });

  it("says so when the address belongs to a switched-off account", async () => {
    const { id } = await newUser();
    await setUserActive({ userId: id, isActive: false }, asOwner());
    // Otherwise somebody spends ten minutes wondering why the address is taken.
    await expect(newUser()).rejects.toThrow(/currently switched off/i);
  });

  it("refuses a password short enough to guess", async () => {
    await expect(newUser({ password: "short1" })).rejects.toThrow(/at least 10/i);
  });

  it("refuses a password that is only letters", async () => {
    await expect(newUser({ password: "onlylettershere" })).rejects.toThrow(/number or symbol/i);
  });

  it("refuses a role that does not exist", async () => {
    await expect(newUser({ role: "SUPREME_LEADER" })).rejects.toThrow(/is not a role/i);
  });

  it("refuses somebody with no name", async () => {
    await expect(newUser({ name: "   " })).rejects.toThrow(UserError);
  });

  it("never writes the password anywhere readable", async () => {
    const { id } = await newUser();
    const row = await db.user.findUniqueOrThrow({ where: { id } });
    expect(row.passwordHash).not.toContain(GOOD);
    expect(row.passwordHash.startsWith("$2")).toBe(true);

    const entry = await db.auditLog.findFirst({
      where: { action: "USER_CREATED", entityId: id },
    });
    expect(JSON.stringify(entry?.after ?? {})).not.toContain(GOOD);
  });
});

describe("nobody can lock the business out", () => {
  it("will not switch off the only owner", async () => {
    const others = await db.user.count({
      where: { role: "OWNER", isActive: true, id: { not: ownerId } },
    });
    if (others > 0) return; // Another owner exists; the rule does not apply.

    await expect(
      setUserActive({ userId: ownerId, isActive: false }, { userId: "somebody-else", reason: null }),
    ).rejects.toThrow(/only owner/i);
  });

  it("will not demote the only owner", async () => {
    const others = await db.user.count({
      where: { role: "OWNER", isActive: true, id: { not: ownerId } },
    });
    if (others > 0) return;

    await expect(
      setUserRole({ userId: ownerId, role: "VIEWER" }, { userId: "somebody-else", reason: null }),
    ).rejects.toThrow(/only owner/i);
  });

  it("lets the owner go once there is a second one", async () => {
    const second = await newUser({ email: "owner2@usertest.eg", role: "OWNER" });

    // Now the rule lifts, because access survives.
    await setUserRole({ userId: second.id, role: "VIEWER" }, asOwner());
    const row = await db.user.findUniqueOrThrow({ where: { id: second.id } });
    expect(row.role).toBe("VIEWER");
  });

  it("will not let somebody switch off their own account", async () => {
    const { id } = await newUser();
    await expect(
      setUserActive({ userId: id, isActive: false }, { userId: id, reason: null }),
    ).rejects.toThrow(/your own account/i);
  });

  it("will not let somebody change their own role", async () => {
    const { id } = await newUser();
    await expect(
      setUserRole({ userId: id, role: "OWNER" }, { userId: id, reason: null }),
    ).rejects.toThrow(/your own role/i);
  });
});

describe("switching an account off", () => {
  it("stops the sign-in", async () => {
    const { id } = await newUser();
    await setUserActive({ userId: id, isActive: false }, asOwner());
    expect(await authenticate("cashier@usertest.eg", GOOD)).toBeNull();
  });

  it("keeps the person, because the history names them", async () => {
    const { id } = await newUser();
    await setUserActive({ userId: id, isActive: false }, asOwner());

    // Deleting the row would orphan every journal line and sale they made.
    const row = await db.user.findUnique({ where: { id } });
    expect(row).not.toBeNull();
    expect(row!.name).toBe("هبة سالم");
  });

  it("brings them back without an old lockout following them", async () => {
    const { id } = await newUser();
    for (let i = 0; i < 8; i++) await authenticate("cashier@usertest.eg", "wrong");
    await setUserActive({ userId: id, isActive: false }, asOwner());
    await setUserActive({ userId: id, isActive: true }, asOwner());

    const row = await db.user.findUniqueOrThrow({ where: { id } });
    expect(row.failedLogins).toBe(0);
    expect(row.lockedUntil).toBeNull();
  });
});

describe("passwords", () => {
  it("lets an owner reset one that was forgotten", async () => {
    const { id } = await newUser();
    await resetPassword({ userId: id, password: "brand-new-pass-4" }, asOwner());

    expect(await authenticate("cashier@usertest.eg", GOOD)).toBeNull();
    expect(await authenticate("cashier@usertest.eg", "brand-new-pass-4")).not.toBeNull();

    const row = await db.user.findUniqueOrThrow({ where: { id } });
    // The owner now knows it, so it is temporary by construction.
    expect(row.mustChangePassword).toBe(true);
  });

  it("uses a reset to free somebody who locked themselves out", async () => {
    const { id } = await newUser();
    for (let i = 0; i < 8; i++) await authenticate("cashier@usertest.eg", "wrong");
    expect(await authenticate("cashier@usertest.eg", GOOD)).toBeNull();

    await resetPassword({ userId: id, password: "let-me-back-in-7" }, asOwner());
    expect(await authenticate("cashier@usertest.eg", "let-me-back-in-7")).not.toBeNull();
  });

  it("unlocks without changing anything else", async () => {
    const { id } = await newUser();
    for (let i = 0; i < 8; i++) await authenticate("cashier@usertest.eg", "wrong");

    await unlockUser({ userId: id }, asOwner());
    // Their own password still works — nobody had to be told a new one.
    expect(await authenticate("cashier@usertest.eg", GOOD)).not.toBeNull();
  });

  it("lets a person make the password their own", async () => {
    const { id } = await newUser();
    await changeOwnPassword(
      { userId: id, currentPassword: GOOD, newPassword: "chosen-by-me-2" },
      { userId: id, reason: null },
    );

    const row = await db.user.findUniqueOrThrow({ where: { id } });
    expect(row.mustChangePassword).toBe(false);
    expect(await authenticate("cashier@usertest.eg", "chosen-by-me-2")).not.toBeNull();
  });

  it("asks for the current one, in case the screen was left unattended", async () => {
    const { id } = await newUser();
    await expect(
      changeOwnPassword(
        { userId: id, currentPassword: "not-it-at-all", newPassword: "something-else-3" },
        { userId: id, reason: null },
      ),
    ).rejects.toThrow(/current password is not right/i);
  });

  it("refuses the same password again", async () => {
    const { id } = await newUser();
    await expect(
      changeOwnPassword(
        { userId: id, currentPassword: GOOD, newPassword: GOOD },
        { userId: id, reason: null },
      ),
    ).rejects.toThrow(/same as the old one/i);
  });

  it("holds the new password to the same standard", async () => {
    const { id } = await newUser();
    await expect(
      changeOwnPassword(
        { userId: id, currentPassword: GOOD, newPassword: "abc" },
        { userId: id, reason: null },
      ),
    ).rejects.toThrow(/at least 10/i);
  });
});

describe("what the owner sees", () => {
  it("shows who is locked out right now", async () => {
    const { id } = await newUser();
    for (let i = 0; i < 8; i++) await authenticate("cashier@usertest.eg", "wrong");

    const row = (await listUsers()).find((u) => u.id === id)!;
    expect(row.isLocked).toBe(true);
    expect(row.failedLogins).toBe(8);
  });

  it("shows who has not made their password their own yet", async () => {
    const { id } = await newUser();
    expect((await listUsers()).find((u) => u.id === id)!.mustChangePassword).toBe(true);

    await changeOwnPassword(
      { userId: id, currentPassword: GOOD, newPassword: "now-its-mine-5" },
      { userId: id, reason: null },
    );
    expect((await listUsers()).find((u) => u.id === id)!.mustChangePassword).toBe(false);
  });

  it("says how much each role opens up", async () => {
    const roles = assignableRoles();
    const owner = roles.find((r) => r.role === "OWNER")!;
    const cashier = roles.find((r) => r.role === "POS_CASHIER")!;

    // An owner granting a role should be able to see what they are granting.
    expect(owner.permissionCount).toBeGreaterThan(cashier.permissionCount);
    expect(cashier.permissionCount).toBeGreaterThan(0);
  });

  it("offers every role the system defines", async () => {
    const roles = assignableRoles().map((r) => r.role);
    for (const expected of ["OWNER", "POS_CASHIER", "WAREHOUSE", "MODERATOR", "BRAND_MANAGER"]) {
      expect(roles).toContain(expected);
    }
  });
});
