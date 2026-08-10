import "server-only";
import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import { db } from "./db";
import { hashPassword, verifyPassword, IMPOSSIBLE_HASH } from "@/core/password";
import { getSession, type SessionPayload } from "./session";
import { can, type Permission } from "@/core/permissions";

// Re-exported so existing callers and tests keep one import, while the
// hashing itself lives somewhere a command line tool can reach.
export { hashPassword, verifyPassword };

/**
 * How many wrong passwords before an account stops answering, and for how
 * long.
 *
 * Hashing at twelve rounds already costs an attacker about a quarter of a
 * second per guess, which is a brake but not a stop: left alone that is still
 * hundreds of thousands of attempts a week. The lockout is deliberately short
 * — long enough to make guessing hopeless, short enough that locking a
 * colleague out by accident is a nuisance rather than a phone call.
 */
const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MINUTES = 15;

export async function authenticate(
  email: string,
  password: string,
): Promise<SessionPayload | null> {
  const user = await db.user.findUnique({
    where: { email: email.trim().toLowerCase() },
  });
  if (!user || !user.isActive) {
    // Spend the same time as a real comparison so a missing account and a
    // wrong password are indistinguishable from the outside.
    await bcrypt.compare(password, IMPOSSIBLE_HASH);
    return null;
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    // Deliberately the same silence as a wrong password: saying "locked"
    // confirms the address exists and tells an attacker their guessing landed.
    await bcrypt.compare(password, user.passwordHash);
    return null;
  }

  const ok = await verifyPassword(password, user.passwordHash);

  if (!ok) {
    const failed = user.failedLogins + 1;
    await db.user.update({
      where: { id: user.id },
      data: {
        failedLogins: failed,
        lockedUntil:
          failed >= MAX_FAILED_LOGINS
            ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
            : user.lockedUntil,
      },
    });
    return null;
  }

  await db.user.update({
    where: { id: user.id },
    // A successful sign-in clears the count: the run of failures was somebody
    // mistyping, not an attack.
    data: { lastLoginAt: new Date(), failedLogins: 0, lockedUntil: null },
  });

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  };
}

/** Server-component guard. Redirects to the login page when unauthenticated. */
export async function requireUser(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

/**
 * Server-component guard for a page. Sends an unauthorised user home rather
 * than showing an empty screen.
 */
export async function requirePermission(
  permission: Permission,
): Promise<SessionPayload> {
  const session = await requireUser();
  if (!can(session.role, permission)) redirect("/");
  return session;
}

export class ForbiddenError extends Error {
  constructor(permission: Permission, role: string) {
    super(`Role ${role} does not have permission ${permission}.`);
    this.name = "ForbiddenError";
  }
}

/**
 * Guard for a server action. Throws instead of redirecting, because an action
 * must fail loudly — a redirect would let the caller believe the mutation
 * succeeded.
 */
export async function authorize(permission: Permission): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) throw new ForbiddenError(permission, "anonymous");
  if (!can(session.role, permission)) throw new ForbiddenError(permission, session.role);
  return session;
}
