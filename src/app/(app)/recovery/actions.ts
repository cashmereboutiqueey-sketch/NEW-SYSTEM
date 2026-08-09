"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { authorize, ForbiddenError } from "@/lib/auth";
import { pullAbandonedCheckouts, markContacted, ShopifyError } from "@/lib/shopify";
import type { FormState } from "@/components/entity-form";

function toMessage(error: unknown): string {
  if (error instanceof ShopifyError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  console.error("Unhandled recovery error:", error);
  return "Something went wrong.";
}

export async function pullCheckoutsAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("campaign:manage");

    const connection = await db.integrationConnection.findFirst({
      where: { provider: "SHOPIFY", isActive: true },
    });
    if (!connection) {
      return { error: "No Shopify shop is connected. Connect one on the integrations screen." };
    }

    const result = await pullAbandonedCheckouts(
      { connectionId: connection.id, sinceDays: Number(formData.get("sinceDays") ?? 30) },
      { userId: session.userId },
    );

    revalidatePath("/recovery");

    const parts = [`${result.imported} new`];
    if (result.updated > 0) parts.push(`${result.updated} refreshed`);
    if (result.recovered > 0) parts.push(`${result.recovered} already bought since`);
    return { success: parts.join(", ") + "." };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function markContactedAction(formData: FormData): Promise<void> {
  const session = await authorize("campaign:manage");
  await markContacted(
    {
      id: String(formData.get("id") ?? ""),
      via: String(formData.get("via") ?? "WHATSAPP"),
      note: (formData.get("note") as string) || null,
    },
    { userId: session.userId },
  );
  revalidatePath("/recovery");
}
