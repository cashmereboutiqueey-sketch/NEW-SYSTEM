"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { addTaxRate, setVatRegistered, TaxError } from "@/lib/tax";
import type { FormState } from "@/components/entity-form";

function toMessage(error: unknown): string {
  if (error instanceof TaxError) return error.message;
  if (error instanceof ForbiddenError) {
    return "You do not have permission to change the tax settings.";
  }
  if (error && typeof error === "object" && "issues" in error) {
    return (error as { issues: { message: string }[] }).issues.map((i) => i.message).join(" ");
  }
  console.error("Unhandled tax error:", error);
  return "Something went wrong. Nothing was changed.";
}

export async function addTaxRateAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("settings:manage");

    const result = await addTaxRate(
      {
        code: String(formData.get("code") ?? ""),
        nameAr: String(formData.get("nameAr") ?? ""),
        nameEn: String(formData.get("nameEn") ?? "") || String(formData.get("nameAr") ?? ""),
        rate: Number(formData.get("rate") ?? 0),
        effectiveFrom: new Date(String(formData.get("effectiveFrom") ?? "")),
      },
      { userId: session.userId, reason: null },
    );

    revalidatePath("/tax");

    return {
      success:
        `اتسجلت نسبة جديدة لـ ${result.code}.` +
        (result.supersededPrevious
          ? " النسبة القديمة اتقفلت اليوم اللي قبلها — والقيود القديمة فضلت بنسبتها."
          : ""),
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

/**
 * Switching VAT on or off.
 *
 * The day this flips is the day the business's obligations change, so it is
 * audited with both sides recorded rather than treated as an ordinary setting.
 */
export async function setRegistrationAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("settings:manage");

    const registered = String(formData.get("registered") ?? "") === "true";
    await setVatRegistered(registered, {
      userId: session.userId,
      reason: String(formData.get("reason") ?? "").trim() || null,
    });

    revalidatePath("/tax");
    revalidatePath("/settings");

    return {
      success: registered
        ? "اتفعّلت. المبيعات الجديدة هتتحسب عليها ضريبة بالنسبة المحددة."
        : "اتقفلت. المبيعات الجديدة مش هيتحسب عليها ضريبة.",
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
