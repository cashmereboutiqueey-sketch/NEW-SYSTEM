"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { authorize, ForbiddenError } from "@/lib/auth";
import { pullOrders, ShopifyError } from "@/lib/shopify";
import { writeAudit } from "@/lib/audit";
import type { FormState } from "@/components/entity-form";

function toMessage(error: unknown): string {
  if (error instanceof ShopifyError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  console.error("Unhandled integration error:", error);
  return "Something went wrong.";
}

export async function connectShopifyAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("settings:manage");

    const shopDomain = String(formData.get("shopDomain") ?? "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "");

    if (!shopDomain.endsWith(".myshopify.com")) {
      return { error: "Enter the shop's .myshopify.com domain, not its public address." };
    }

    const accessToken = String(formData.get("accessToken") ?? "").trim();
    const webhookSecret = String(formData.get("webhookSecret") ?? "").trim();

    const connection = await db.integrationConnection.upsert({
      where: { provider_externalRef: { provider: "SHOPIFY", externalRef: shopDomain } },
      update: {
        displayName: String(formData.get("displayName") ?? shopDomain),
        // Blank means "leave the stored one alone", so re-saving the form does
        // not wipe a working token.
        ...(accessToken ? { accessToken } : {}),
        ...(webhookSecret ? { webhookSecret } : {}),
        isActive: true,
      },
      create: {
        provider: "SHOPIFY",
        externalRef: shopDomain,
        displayName: String(formData.get("displayName") ?? shopDomain),
        accessToken: accessToken || null,
        webhookSecret: webhookSecret || null,
      },
    });

    await db.$transaction(async (tx) => {
      await writeAudit(tx, {
        action: "SHOPIFY_CONNECTED",
        entityName: "IntegrationConnection",
        entityId: connection.id,
        // The token itself is never audited — the trail records that one was
        // set, not what it is.
        after: { shopDomain, hasToken: Boolean(connection.accessToken) },
        ctx: { userId: session.userId },
      });
    });

    revalidatePath("/integrations");
    return { success: `${shopDomain} connected.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function pullOrdersAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("settings:manage");

    const result = await pullOrders(
      {
        connectionId: String(formData.get("connectionId") ?? ""),
        sinceDays: Number(formData.get("sinceDays") ?? 7),
      },
      { userId: session.userId },
    );

    revalidatePath("/integrations");
    revalidatePath("/sales");

    const parts = [`${result.created} imported`];
    if (result.duplicates > 0) parts.push(`${result.duplicates} already had been`);
    if (result.failed > 0) parts.push(`${result.failed} need attention`);
    return { success: parts.join(", ") + "." };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function resolveExceptionAction(formData: FormData): Promise<void> {
  const session = await authorize("settings:manage");
  const id = String(formData.get("id") ?? "");

  await db.$transaction(async (tx) => {
    const exception = await tx.integrationException.update({
      where: { id },
      data: {
        status: String(formData.get("status") ?? "RESOLVED") as never,
        resolvedAt: new Date(),
        resolvedNote: (formData.get("note") as string) || null,
      },
    });
    await writeAudit(tx, {
      action: "INTEGRATION_EXCEPTION_CLOSED",
      entityName: "IntegrationException",
      entityId: exception.id,
      after: { status: exception.status, reason: exception.reason },
      ctx: { userId: session.userId },
    });
  });

  revalidatePath("/integrations");
}
