import "server-only";
import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import { db } from "./db";
import { getSession, type SessionPayload } from "./session";

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

const ROLE_RANK: Record<SessionPayload["role"], number> = {
  VIEWER: 0,
  PRODUCTION: 1,
  ACCOUNTANT: 2,
  OWNER: 3,
};

export function hasAtLeast(
  role: SessionPayload["role"],
  minimum: SessionPayload["role"],
): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export async function requireRole(
  minimum: SessionPayload["role"],
): Promise<SessionPayload> {
  const session = await requireUser();
  if (!hasAtLeast(session.role, minimum)) redirect("/");
  return session;
}
