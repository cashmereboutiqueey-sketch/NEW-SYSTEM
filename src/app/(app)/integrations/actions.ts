"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { authorize, ForbiddenError } from "@/lib/auth";
import { pullOrders, publishInventory, verifyShopConnection, ShopifyError } from "@/lib/shopify";
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

    // Ask the shop who it is before storing anything. Checking that the domain
    // merely ends in .myshopify.com proves nothing: Shopify answers DNS for
    // every name under it, occupied or not, so a plausible wrong domain saved
    // cleanly, reported "connected", and then failed on every sync with a bare
    // 404 that named neither the cause nor the fix.
    //
    // An existing token is reused when the field is left blank, so re-saving
    // the form to correct a domain does not require pasting the token again —
    // and cannot verify against a token the operator did not supply.
    const existing = await db.integrationConnection.findUnique({
      where: { provider_externalRef: { provider: "SHOPIFY", externalRef: shopDomain } },
      select: { accessToken: true, apiVersion: true },
    });
    const tokenToCheck = accessToken || existing?.accessToken || null;
    if (!tokenToCheck) {
      return { error: "Enter an access token." };
    }

    let shop: { name: string; domain: string; currency: string };
    try {
      shop = await verifyShopConnection({
        externalRef: shopDomain,
        accessToken: tokenToCheck,
        apiVersion: existing?.apiVersion ?? null,
      });
    } catch (error) {
      // Nothing is written. A connection that does not work should not exist,
      // so there is nothing to clean up after a failed attempt.
      return { error: toMessage(error) };
    }

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
    // Named, because the point of verifying is being able to say which shop.
    return { success: `Connected to ${shop.name} (${shop.domain}).` };
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

export async function publishInventoryAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("settings:manage");

    // Checking first is the default. The first run against a live shop should
    // be read before it is believed, and a stock level written wrongly takes a
    // garment off sale as convincingly as a correct one.
    const dryRun = String(formData.get("mode") ?? "check") !== "publish";

    const result = await publishInventory(
      { connectionId: String(formData.get("connectionId") ?? ""), dryRun },
      { userId: session.userId },
    );

    revalidatePath("/integrations");

    if (dryRun) {
      if (result.changes.length === 0) {
        return { success: `Shopify already agrees on all ${result.checked} linked garments.` };
      }
      // The first few by name, because "37 differences" tells an operator
      // nothing about whether the answer is plausible.
      const sample = result.changes
        .slice(0, 5)
        .map((c) => `${c.sku}: ${c.from ?? "none"} → ${c.to}`)
        .join(", ");
      const more = result.changes.length > 5 ? `, and ${result.changes.length - 5} more` : "";
      return {
        success:
          `${result.changes.length} of ${result.checked} would change — ${sample}${more}. ` +
          `Nothing has been written yet.`,
      };
    }

    const parts = [`${result.pushed} updated on Shopify`];
    if (result.unchanged > 0) parts.push(`${result.unchanged} already correct`);
    if (result.unlinked > 0) parts.push(`${result.unlinked} not linked to a garment here`);
    if (result.failed > 0) parts.push(`${result.failed} failed`);
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
