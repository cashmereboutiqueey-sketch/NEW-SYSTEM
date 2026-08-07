"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authenticate } from "@/lib/auth";
import {
  createSession,
  destroySession,
  setPrefs,
  ENTITY_SCOPES,
} from "@/lib/session";

/**
 * Server actions are the data layer for the whole system (chosen over tRPC,
 * and used consistently). Every action validates its input with Zod at the
 * boundary — nothing trusts a form payload.
 */

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export type LoginState = { error?: string };

export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: "invalid" };
  }

  const session = await authenticate(parsed.data.email, parsed.data.password);
  if (!session) {
    return { error: "invalid" };
  }

  await createSession(session);
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect("/login");
}

const scopeSchema = z.enum(ENTITY_SCOPES);

export async function setEntityScopeAction(formData: FormData): Promise<void> {
  const parsed = scopeSchema.safeParse(formData.get("scope"));
  if (!parsed.success) return;
  await setPrefs({ scope: parsed.data });
  revalidatePath("/", "layout");
}

const localeSchema = z.enum(["ar", "en"]);

export async function setLocaleAction(formData: FormData): Promise<void> {
  const parsed = localeSchema.safeParse(formData.get("locale"));
  if (!parsed.success) return;
  await setPrefs({ locale: parsed.data });
  revalidatePath("/", "layout");
}
