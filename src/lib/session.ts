import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import type { Locale } from "./i18n";
import { ROLES } from "@/core/permissions";

const SESSION_COOKIE = "cashmere_session";
const PREFS_COOKIE = "cashmere_prefs";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;

const sessionPayloadSchema = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.enum(ROLES),
});

export type SessionPayload = z.infer<typeof sessionPayloadSchema>;

function secretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "AUTH_SECRET must be set and at least 32 characters. See .env.example.",
    );
  }
  return new TextEncoder().encode(secret);
}

export async function createSession(payload: SessionPayload): Promise<void> {
  const token = await new SignJWT(payload)
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
  try {
    const { payload } = await jwtVerify(token, secretKey());
    const parsed = sessionPayloadSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
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
