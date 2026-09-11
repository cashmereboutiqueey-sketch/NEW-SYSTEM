/**
 * Session cookies for the scripts that exercise the running application.
 *
 * The session cookie names an account and a sign-in generation, nothing more.
 * The role is read from the account on every request, so a script can no
 * longer write "role: HR" into a cookie and be treated as HR. It has to be
 * somebody who actually holds the role.
 *
 * Hence one QA account per role, kept for the purpose. Each is given a
 * password hash no password matches, so nobody can sign in as one through the
 * login form. A cookie is minted directly, which needs AUTH_SECRET, and whoever
 * holds that can already sign as anybody. `retireQaUsers` switches them off
 * again once a run ends, so between runs they show on the users screen as
 * switched off rather than as live accounts nobody recognises.
 */
import { SignJWT } from "jose";
import { db } from "../src/lib/db";
import { IMPOSSIBLE_HASH } from "../src/core/password";
import type { Role } from "../src/core/permissions";

const QA_DOMAIN = "qa.invalid";

function secret(): Uint8Array {
  return new TextEncoder().encode(process.env.AUTH_SECRET!);
}

/** A cookie value for this account, as the login form would have issued it. */
export function sessionToken(user: { id: string; sessionVersion: number }): Promise<string> {
  return new SignJWT({ userId: user.id, sv: user.sessionVersion })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret());
}

/** The QA account holding this role, switched on and ready to use. */
export async function qaUserFor(role: Role) {
  const email = `qa-${role.toLowerCase().replace(/_/g, "-")}@${QA_DOMAIN}`;
  return db.user.upsert({
    where: { email },
    update: { role, isActive: true, mustChangePassword: false },
    create: {
      email,
      name: `QA ${role}`,
      role,
      passwordHash: IMPOSSIBLE_HASH,
      isActive: true,
      mustChangePassword: false,
    },
  });
}

/** A cookie value for somebody who holds exactly this role. */
export async function sessionFor(role: Role): Promise<string> {
  return sessionToken(await qaUserFor(role));
}

/** Switch every QA account off again. Call once at the end of a run. */
export async function retireQaUsers(): Promise<void> {
  await db.user.updateMany({
    where: { email: { endsWith: `@${QA_DOMAIN}` } },
    data: { isActive: false },
  });
}
