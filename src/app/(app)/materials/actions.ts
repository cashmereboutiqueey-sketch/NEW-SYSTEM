"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { createMaterial, setMaterialActive, MasterDataError } from "@/lib/master-data";
import type { FormState } from "@/components/entity-form";

function toMessage(error: unknown): string {
  if (error instanceof MasterDataError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  if (error && typeof error === "object" && "issues" in error) {
    return (error as { issues: { message: string }[] }).issues
      .map((i) => i.message)
      .join(" ");
  }
  console.error("Unhandled material error:", error);
  return "Something went wrong. Nothing was saved.";
}

/** Accepts "2.5" as 2.5% and stores the 0.025 the schema expects. */
function pct(value: FormDataEntryValue | null): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n / 100 : 0;
}

export async function createMaterialAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("purchase_order:create");

    const material = await createMaterial(
      {
        code: String(formData.get("code") ?? ""),
        nameEn: String(formData.get("nameEn") ?? ""),
        nameAr: String(formData.get("nameAr") ?? ""),
        type: String(formData.get("type") ?? "FABRIC") as never,
        uomId: String(formData.get("uomId") ?? ""),
        supplierId: (formData.get("supplierId") as string) || null,
        basePrice: Number(formData.get("basePrice") ?? 0),
        freightPct: pct(formData.get("freightPct")),
        dutyPct: pct(formData.get("dutyPct")),
        moq: formData.get("moq") ? Number(formData.get("moq")) : null,
        packSize: formData.get("packSize") ? Number(formData.get("packSize")) : null,
        leadTimeDays: Number(formData.get("leadTimeDays") ?? 0),
        reorderPoint: formData.get("reorderPoint") ? Number(formData.get("reorderPoint")) : null,
        composition: (formData.get("composition") as string) || null,
        gsm: formData.get("gsm") ? Number(formData.get("gsm")) : null,
        widthCm: formData.get("widthCm") ? Number(formData.get("widthCm")) : null,
      },
      { userId: session.userId },
    );

    revalidatePath("/materials");
    return { success: `${material.nameEn} added as ${material.code}.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function toggleMaterialAction(formData: FormData): Promise<void> {
  const session = await authorize("purchase_order:create");
  await setMaterialActive(
    {
      id: String(formData.get("id") ?? ""),
      isActive: formData.get("isActive") === "true",
    },
    { userId: session.userId },
  );
  revalidatePath("/materials");
}
