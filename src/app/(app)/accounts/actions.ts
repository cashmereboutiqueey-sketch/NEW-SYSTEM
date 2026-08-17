"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { createAccount, updateAccount, AccountError } from "@/lib/accounts";
import type { FormState } from "@/components/entity-form";

function toMessage(error: unknown): string {
  if (error instanceof AccountError) return error.message;
  if (error instanceof ForbiddenError) {
    return "You do not have permission to change the chart of accounts.";
  }
  if (error && typeof error === "object" && "issues" in error) {
    return (error as { issues: { message: string }[] }).issues.map((i) => i.message).join(" ");
  }
  console.error("Unhandled account error:", error);
  return "Something went wrong. Nothing was changed.";
}

const on = (v: FormDataEntryValue | null) => String(v ?? "") === "on";

export async function createAccountAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("account:manage");

    const parentId = String(formData.get("parentId") ?? "").trim();

    const result = await createAccount(
      {
        code: String(formData.get("code") ?? ""),
        nameAr: String(formData.get("nameAr") ?? ""),
        nameEn: String(formData.get("nameEn") ?? "") || String(formData.get("nameAr") ?? ""),
        type: String(formData.get("type") ?? "EXPENSE") as
          "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "COGS" | "EXPENSE",
        scope: String(formData.get("scope") ?? "BOTH") as "FACTORY" | "BRAND" | "BOTH",
        parentId: parentId || null,
        isPostable: !on(formData.get("isHeader")),
        includeInMinuteRate: on(formData.get("includeInMinuteRate")),
        includeInBrandFixedPool: on(formData.get("includeInBrandFixedPool")),
        reportingCategory: String(formData.get("reportingCategory") ?? "").trim() || null,
      },
      { userId: session.userId, reason: null },
    );

    revalidatePath("/accounts");
    revalidatePath("/journal");

    return {
      success:
        `اتضاف ${result.code} برصيد طبيعي ${result.normalBalance === "DEBIT" ? "مدين" : "دائن"}.` +
        (result.parentBecameHeader ? " الحساب الأب بقى رأس مجموعة ومش هيتسجل عليه." : ""),
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function updateAccountAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("account:manage");

    const retire = String(formData.get("retire") ?? "");

    const result = await updateAccount(
      {
        id: String(formData.get("id") ?? ""),
        ...(formData.has("nameAr") ? { nameAr: String(formData.get("nameAr") ?? "") } : {}),
        ...(formData.has("nameEn") ? { nameEn: String(formData.get("nameEn") ?? "") } : {}),
        ...(retire ? { isActive: retire === "activate" } : {}),
        ...(formData.has("poolFlags")
          ? {
              includeInMinuteRate: on(formData.get("includeInMinuteRate")),
              includeInBrandFixedPool: on(formData.get("includeInBrandFixedPool")),
            }
          : {}),
      },
      { userId: session.userId, reason: null },
    );

    revalidatePath("/accounts");
    revalidatePath("/minute-rate");
    revalidatePath("/reports/break-even");

    return { success: `${result.code} اتعدّل.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
