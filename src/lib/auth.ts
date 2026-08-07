import "server-only";
import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import { db } from "./db";
import { getSession, type SessionPayload } from "./session";
import { can, type Permission } from "@/core/permissions";

const BCRYPT_ROUNDS = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

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
    await bcrypt.compare(password, "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva");
    return null;
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) return null;

  await db.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
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
