"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { createCampaign, recordSpend, importMetaCsv, MarketingError } from "@/lib/marketing";
import { ExpenseError } from "@/lib/expenses";
import type { FormState } from "@/components/entity-form";

function toMessage(error: unknown): string {
  if (error instanceof MarketingError || error instanceof ExpenseError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  if (error && typeof error === "object" && "issues" in error) {
    return (error as { issues: { message: string }[] }).issues
      .map((i) => i.message)
      .join(" ");
  }
  console.error("Unhandled marketing error:", error);
  return "Something went wrong. Nothing was saved.";
}

export async function createCampaignAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("campaign:manage");

    const campaign = await createCampaign(
      {
        code: String(formData.get("code") ?? ""),
        nameEn: String(formData.get("nameEn") ?? ""),
        nameAr: String(formData.get("nameAr") ?? ""),
        platform: String(formData.get("platform") ?? "META") as never,
        objective: (formData.get("objective") as string) || null,
        audience: (formData.get("audience") as string) || null,
        collectionId: (formData.get("collectionId") as string) || null,
        styleId: (formData.get("styleId") as string) || null,
        startDate: String(formData.get("startDate") ?? ""),
        endDate: String(formData.get("endDate") ?? "") || null,
        budget: Number(formData.get("budget") ?? 0),
        couponCode: (formData.get("couponCode") as string) || null,
        creatorName: (formData.get("creatorName") as string) || null,
        creatorFee: Number(formData.get("creatorFee") ?? 0),
      },
      { userId: session.userId },
    );

    revalidatePath("/marketing");
    return { success: `${campaign.nameEn} created as ${campaign.code}.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function recordSpendAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("campaign:manage");

    await recordSpend(
      {
        campaignId: String(formData.get("campaignId") ?? ""),
        spendDate: new Date(String(formData.get("spendDate") ?? "")),
        amount: Number(formData.get("amount") ?? 0),
        impressions: Number(formData.get("impressions") ?? 0),
        clicks: Number(formData.get("clicks") ?? 0),
        reportedConversions: Number(formData.get("reportedConversions") ?? 0),
      },
      { userId: session.userId },
    );

    revalidatePath("/marketing");
    revalidatePath("/expenses");
    return { success: "Spend recorded and booked as an expense." };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function importMetaCsvAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("campaign:manage");

    const file = formData.get("file") as File | null;
    const pasted = String(formData.get("csv") ?? "").trim();
    const csv = file && file.size > 0 ? await file.text() : pasted;

    if (!csv) {
      return { error: "Choose an exported file, or paste the report text." };
    }

    const result = await importMetaCsv({ csv }, { userId: session.userId });

    revalidatePath("/marketing");
    revalidatePath("/expenses");

    if (result.imported === 0 && result.updated === 0) {
      const why = result.unmatched.length > 0
        ? `No campaign matches: ${result.unmatched.join(", ")}. Create it with exactly that name first.`
        : result.errors.map((e) => `line ${e.line}: ${e.reason}`).join("; ");
      return { error: `Nothing was imported. ${why}` };
    }

    const parts = [`${result.imported} day(s) imported`];
    if (result.updated > 0) parts.push(`${result.updated} updated`);
    if (result.unmatched.length > 0) {
      parts.push(`no campaign matches ${result.unmatched.join(", ")}`);
    }
    if (result.errors.length > 0) parts.push(`${result.errors.length} row(s) unreadable`);

    return { success: parts.join(", ") + "." };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
