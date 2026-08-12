"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import {
  createCostCategory,
  createColour,
  createSize,
  createUnitOfMeasure,
  MasterDataError,
} from "@/lib/master-data";
import type { FormState } from "@/components/entity-form";

/**
 * The small lists, addable from wherever somebody needs them.
 *
 * Shared rather than duplicated per screen: a colour added from the styles
 * page and a colour added from anywhere else are the same act, and having two
 * of them is how the two drift apart.
 */

function toMessage(error: unknown): string {
  if (error instanceof MasterDataError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  if (error && typeof error === "object" && "issues" in error) {
    return (error as { issues: { message: string }[] }).issues
      .map((i) => i.message)
      .join(" ");
  }
  console.error("Unhandled master data error:", error);
  return "Something went wrong. Nothing was saved.";
}

const on = (v: FormDataEntryValue | null) => String(v ?? "") === "on";

export async function addCostCategoryAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    // Adding a heading that money gets filed under, and possibly one that
    // changes the minute rate — so it sits with whoever manages settings
    // rather than with whoever types the expense.
    const session = await authorize("settings:manage");

    const result = await createCostCategory(
      {
        entityId: String(formData.get("entityId") ?? ""),
        code: String(formData.get("code") ?? ""),
        nameAr: String(formData.get("nameAr") ?? ""),
        nameEn: String(formData.get("nameEn") ?? "") || String(formData.get("nameAr") ?? ""),
        behaviour: (String(formData.get("behaviour") ?? "FIXED") as
          | "FIXED" | "VARIABLE" | "SEMI_VARIABLE"),
        includeInMinuteRate: on(formData.get("includeInMinuteRate")),
        includeInBrandFixedPool: on(formData.get("includeInBrandFixedPool")),
      },
      { userId: session.userId, reason: null },
    );

    revalidatePath("/expenses");
    revalidatePath("/settings");
    return { success: `اتضاف ${result.code}.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function addColourAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("retail_price:manage");

    const hex = String(formData.get("hex") ?? "").trim();
    const result = await createColour(
      {
        code: String(formData.get("code") ?? ""),
        nameAr: String(formData.get("nameAr") ?? ""),
        nameEn: String(formData.get("nameEn") ?? "") || String(formData.get("nameAr") ?? ""),
        hex: hex || null,
      },
      { userId: session.userId, reason: null },
    );

    revalidatePath("/styles");
    revalidatePath("/pos");
    return { success: `اتضاف ${result.code}.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function addSizeAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("retail_price:manage");

    const factor = String(formData.get("consumptionFactor") ?? "").trim();
    const result = await createSize(
      {
        code: String(formData.get("code") ?? ""),
        nameAr: String(formData.get("nameAr") ?? "") || String(formData.get("code") ?? ""),
        nameEn: String(formData.get("nameEn") ?? "") || String(formData.get("code") ?? ""),
        consumptionFactor: factor ? Number(factor) : 1,
      },
      { userId: session.userId, reason: null },
    );

    revalidatePath("/styles");
    return { success: `اتضاف ${result.code}.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function addUnitAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("settings:manage");

    const result = await createUnitOfMeasure(
      {
        code: String(formData.get("code") ?? ""),
        nameAr: String(formData.get("nameAr") ?? ""),
        nameEn: String(formData.get("nameEn") ?? "") || String(formData.get("nameAr") ?? ""),
        kind: String(formData.get("kind") ?? "PIECE") as
          | "LENGTH" | "MASS" | "PIECE" | "AREA",
      },
      { userId: session.userId, reason: null },
    );

    revalidatePath("/materials");
    return { success: `اتضاف ${result.code}.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
