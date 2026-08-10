import "server-only";
import { db } from "./db";
import { hashPassword, verifyPassword } from "@/core/password";
import { writeAudit, type AuditContext } from "./audit";
import { ROLES, permissionsFor, type Role } from "@/core/permissions";

/**
 * Who may sign in, and as what.
 *
 * The whole authorisation model — twelve roles, fifty-odd permissions, the
 * segregation of duties — was unreachable without this: there was no way to
 * create the cashier the till was written for. A permission nobody can be
 * granted is a comment.
 *
 * Two rules shape everything here.
 *
 * Nobody is ever deleted. Every journal, sale and stock adjustment names the
 * person who made it, and removing the row would either break those links or
 * silently orphan them. An account that should not be used is deactivated,
 * which stops the sign-in and leaves the history readable.
 *
 * Nobody can lock the business out of its own system. The last active owner
 * cannot be deactivated or demoted, and nobody can switch off their own
 * account — mistakes there are unrecoverable without a database console.
 */

export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

/**
 * Short enough that people will not write it on the monitor, long enough to
 * be worth the twelve bcrypt rounds behind it.
 */
const MIN_PASSWORD = 10;

function checkPassword(password: string): void {
  if (password.length < MIN_PASSWORD) {
    throw new UserError(`A password needs at least ${MIN_PASSWORD} characters.`);
  }
  if (!/[^a-zA-Z]/.test(password)) {
    // Not a complexity ritual — just enough to stop a single dictionary word.
    throw new UserError("A password needs at least one number or symbol.");
  }
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export async function createUser(
  input: {
    name: string;
    email: string;
    role: string;
    /** A temporary one. They must replace it before they can do anything. */
    password: string;
    locale?: string;
  },
  ctx: AuditContext,
): Promise<{ id: string; email: string }> {
  const name = input.name.trim();
  const email = normaliseEmail(input.email);

  if (!name) throw new UserError("A person needs a name.");
  if (!email.includes("@")) throw new UserError("That is not an email address.");
  if (!isRole(input.role)) throw new UserError(`${input.role} is not a role.`);
  checkPassword(input.password);

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    throw new UserError(
      `${email} already has an account${existing.isActive ? "" : ", currently switched off"}.`,
    );
  }

  const passwordHash = await hashPassword(input.password);

  return db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        name,
        email,
        role: input.role as Role,
        passwordHash,
        locale: input.locale ?? "ar",
        isActive: true,
        // Somebody else chose this password, so it is not theirs yet.
        mustChangePassword: true,
      },
    });

    await writeAudit(tx, {
      action: "USER_CREATED",
      entityName: "User",
      entityId: user.id,
      after: { name, email, role: input.role },
      ctx,
    });

    return { id: user.id, email };
  });
}

/** The people who could still sign in as owner if this one went away. */
async function otherActiveOwners(exceptUserId: string): Promise<number> {
  return db.user.count({
    where: { role: "OWNER", isActive: true, id: { not: exceptUserId } },
  });
}

export async function setUserRole(
  input: { userId: string; role: string },
  ctx: AuditContext,
): Promise<void> {
  if (!isRole(input.role)) throw new UserError(`${input.role} is not a role.`);

  const user = await db.user.findUnique({ where: { id: input.userId } });
  if (!user) throw new UserError("That account does not exist.");
  if (user.role === input.role) return;

  if (user.id === ctx.userId) {
    // Changing your own role is how somebody accidentally locks themselves
    // out of the screen they are standing on.
    throw new UserError("You cannot change your own role. Ask another owner.");
  }

  if (user.role === "OWNER" && (await otherActiveOwners(user.id)) === 0) {
    throw new UserError(
      "This is the only owner. Make somebody else an owner first, or the business loses access to its own system.",
    );
  }

  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { role: input.role as Role } });
    await writeAudit(tx, {
      action: "USER_ROLE_CHANGED",
      entityName: "User",
      entityId: user.id,
      before: { role: user.role },
      after: { role: input.role, name: user.name },
      ctx,
    });
  });
}

export async function setUserActive(
  input: { userId: string; isActive: boolean },
  ctx: AuditContext,
): Promise<void> {
  const user = await db.user.findUnique({ where: { id: input.userId } });
  if (!user) throw new UserError("That account does not exist.");
  if (user.isActive === input.isActive) return;

  if (!input.isActive) {
    if (user.id === ctx.userId) {
      throw new UserError("You cannot switch off your own account.");
    }
    if (user.role === "OWNER" && (await otherActiveOwners(user.id)) === 0) {
      throw new UserError("This is the only owner; switching it off locks everybody out.");
    }
  }

  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        isActive: input.isActive,
        // Coming back should not inherit a lockout from months ago.
        ...(input.isActive ? { failedLogins: 0, lockedUntil: null } : {}),
      },
    });

    await writeAudit(tx, {
      action: input.isActive ? "USER_REACTIVATED" : "USER_DEACTIVATED",
      entityName: "User",
      entityId: user.id,
      before: { isActive: user.isActive },
      after: { isActive: input.isActive, name: user.name, email: user.email },
      ctx,
    });
  });
}

/**
 * Give somebody a new password because they have forgotten theirs.
 *
 * It is temporary by construction: they cannot reach a screen until they
 * replace it. Whoever performs the reset therefore never holds a password
 * somebody else is still using.
 */
export async function resetPassword(
  input: { userId: string; password: string },
  ctx: AuditContext,
): Promise<void> {
  checkPassword(input.password);

  const user = await db.user.findUnique({ where: { id: input.userId } });
  if (!user) throw new UserError("That account does not exist.");

  const passwordHash = await hashPassword(input.password);

  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        mustChangePassword: true,
        // A reset is also how somebody gets back in after locking themselves
        // out, so it clears the lockout.
        failedLogins: 0,
        lockedUntil: null,
      },
    });

    await writeAudit(tx, {
      action: "USER_PASSWORD_RESET",
      entityName: "User",
      entityId: user.id,
      // Never the password, not even hashed: an audit log is read by people.
      after: { name: user.name, email: user.email },
      ctx,
    });
  });
}

/** Let somebody back in early after too many wrong guesses. */
export async function unlockUser(
  input: { userId: string },
  ctx: AuditContext,
): Promise<void> {
  const user = await db.user.findUnique({ where: { id: input.userId } });
  if (!user) throw new UserError("That account does not exist.");

  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { failedLogins: 0, lockedUntil: null },
    });
    await writeAudit(tx, {
      action: "USER_UNLOCKED",
      entityName: "User",
      entityId: user.id,
      after: { name: user.name, failedLogins: user.failedLogins },
      ctx,
    });
  });
}

/**
 * Somebody changing their own password.
 *
 * The current one is required even though they are already signed in: an
 * unattended screen is the most common way an account is taken over, and
 * asking costs one field.
 */
export async function changeOwnPassword(
  input: { userId: string; currentPassword: string; newPassword: string },
  ctx: AuditContext,
): Promise<void> {
  checkPassword(input.newPassword);

  const user = await db.user.findUnique({ where: { id: input.userId } });
  if (!user) throw new UserError("That account does not exist.");

  const ok = await verifyPassword(input.currentPassword, user.passwordHash);
  if (!ok) throw new UserError("The current password is not right.");

  if (await verifyPassword(input.newPassword, user.passwordHash)) {
    throw new UserError("The new password is the same as the old one.");
  }

  const passwordHash = await hashPassword(input.newPassword);

  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash, mustChangePassword: false },
    });
    await writeAudit(tx, {
      action: "USER_PASSWORD_CHANGED",
      entityName: "User",
      entityId: user.id,
      after: { name: user.name },
      ctx,
    });
  });
}

export async function listUsers() {
  const users = await db.user.findMany({
    orderBy: [{ isActive: "desc" }, { role: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      locale: true,
      lastLoginAt: true,
      failedLogins: true,
      lockedUntil: true,
      mustChangePassword: true,
      createdAt: true,
    },
  });

  const now = new Date();
  return users.map((u) => ({
    ...u,
    isLocked: !!u.lockedUntil && u.lockedUntil > now,
    /** How much this role can reach, so an owner can see what they are granting. */
    permissionCount: permissionsFor(u.role as Role).length,
  }));
}

/** The roles an owner may assign, with how much each one opens up. */
export function assignableRoles() {
  // Owner comes out on top with everything; the rest read as an increasingly
  // narrow set, which is the order somebody choosing a role thinks in.
  return ROLES.map((role) => ({
    role,
    permissionCount: permissionsFor(role).length,
  }));
}
