"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { createClient, createQuote, setQuoteStatus, CMTError } from "@/lib/cmt";
import type { FormState } from "@/components/entity-form";

function toMessage(error: unknown): string {
  if (error instanceof CMTError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  console.error("Unhandled CMT error:", error);
  return "Something went wrong. Nothing was saved.";
}

export async function createClientAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("cmt_quote:create");

    const result = await createClient(
      {
        code: String(formData.get("code") ?? ""),
        name: String(formData.get("name") ?? ""),
        contactPerson: (formData.get("contactPerson") as string) || null,
        phone: (formData.get("phone") as string) || null,
        email: (formData.get("email") as string) || null,
        creditDays: Number(formData.get("creditDays") ?? 0),
        notes: (formData.get("notes") as string) || null,
      },
      { userId: session.userId },
    );

    revalidatePath("/cmt/clients");
    revalidatePath("/cmt/quotes");
    return { success: `${result.code} added.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function createQuoteAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("cmt_quote:create");

    const result = await createQuote(
      {
        clientId: String(formData.get("clientId") ?? ""),
        styleDescription: String(formData.get("styleDescription") ?? ""),
        quantity: Number(formData.get("quantity") ?? 0),
        smvPerUnit: String(formData.get("smvPerUnit") ?? ""),
        quotedMinuteRate: String(formData.get("quotedMinuteRate") ?? ""),
        quoteDate: new Date(String(formData.get("quoteDate") ?? "")),
        validUntil: formData.get("validUntil")
          ? new Date(String(formData.get("validUntil")))
          : null,
        notes: (formData.get("notes") as string) || null,
      },
      { userId: session.userId },
    );

    revalidatePath("/cmt/quotes");
    revalidatePath("/capacity/planning");

    return {
      success:
        `${result.quoteNumber} priced at ${Number(result.quotedTotal).toFixed(2)}, ` +
        `${(Number(result.marginOverFloorPct) * 100).toFixed(1)}% above the full-capacity floor.` +
        (result.exceedsFreeCapacity
          ? " It needs more minutes than the month has free — either hire, or push the dates out."
          : ""),
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function setQuoteStatusAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("cmt_quote:create");

    const status = String(formData.get("status") ?? "") as
      | "SENT" | "ACCEPTED" | "REJECTED" | "EXPIRED";

    await setQuoteStatus(
      { quoteId: String(formData.get("quoteId") ?? ""), status },
      { userId: session.userId },
    );

    revalidatePath("/cmt/quotes");
    revalidatePath("/cmt/clients");
    return { success: `Marked ${status.toLowerCase()}.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
