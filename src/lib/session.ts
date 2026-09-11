import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import type { Locale } from "./i18n";
import { db } from "./db";
import type { Role } from "@/core/permissions";

const SESSION_COOKIE = "cashmere_session";
const PREFS_COOKIE = "cashmere_prefs";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;

/**
 * What the cookie carries: who, and which generation of their sign-ins.
 *
 * Deliberately not the role. A role in the cookie is the role on the day the
 * person signed in, and it went on being honoured for twelve hours after an
 * owner demoted or switched them off. The role, and whether the account may
 * still be used at all, are read from the account on every request instead.
 */
const tokenSchema = z.object({
  userId: z.string(),
  sv: z.number().int(),
});

export type SessionPayload = {
  userId: string;
  email: string;
  name: string;
  role: Role;
  /** Somebody else chose their password; nothing works until they replace it. */
  mustChangePassword: boolean;
};

function secretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "AUTH_SECRET must be set and at least 32 characters. See .env.example.",
    );
  }
  return new TextEncoder().encode(secret);
}

export async function createSession(user: {
  userId: string;
  sessionVersion: number;
}): Promise<void> {
  const token = await new SignJWT({ userId: user.userId, sv: user.sessionVersion })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(secretKey());

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  let claims: z.infer<typeof tokenSchema>;
  try {
    const { payload } = await jwtVerify(token, secretKey());
    const parsed = tokenSchema.safeParse(payload);
    if (!parsed.success) return null;
    claims = parsed.data;
  } catch {
    return null;
  }

  // The signature proves who the cookie was issued to. Only the account can
  // say whether that person may still act, and as what.
  //
  // Not memoised across the request on purpose: changing a password reads the
  // session, changes the account and then renders, and a remembered answer
  // would send them straight back to the change-password screen.
  const user = await db.user.findUnique({
    where: { id: claims.userId },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      sessionVersion: true,
      mustChangePassword: true,
    },
  });
  if (!user || !user.isActive || user.sessionVersion !== claims.sv) return null;

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
  };
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

// --- UI preferences (entity lens + locale) ---------------------------------

export const ENTITY_SCOPES = ["FACTORY", "BRAND", "GROUP"] as const;
export type EntityScope = (typeof ENTITY_SCOPES)[number];

const prefsSchema = z.object({
  scope: z.enum(ENTITY_SCOPES).default("GROUP"),
  locale: z.enum(["ar", "en"]).default("ar"),
});

export type Prefs = z.infer<typeof prefsSchema>;

export async function getPrefs(): Promise<Prefs> {
  const store = await cookies();
  const raw = store.get(PREFS_COOKIE)?.value;
  const fallback: Prefs = {
    scope: "GROUP",
    locale: (process.env.DEFAULT_LOCALE as Locale) ?? "ar",
  };
  if (!raw) return fallback;
  try {
    const parsed = prefsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

export async function setPrefs(next: Partial<Prefs>): Promise<Prefs> {
  const current = await getPrefs();
  const merged = prefsSchema.parse({ ...current, ...next });
  const store = await cookies();
  store.set(PREFS_COOKIE, JSON.stringify(merged), {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return merged;
}
