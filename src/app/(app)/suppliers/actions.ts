"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { createSupplier, setSupplierActive, MasterDataError } from "@/lib/master-data";
import type { FormState } from "@/components/entity-form";

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

export async function createSupplierAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    // Suppliers are created by whoever raises purchase orders.
    const session = await authorize("purchase_order:create");

    const supplier = await createSupplier(
      {
        code: String(formData.get("code") ?? ""),
        nameEn: String(formData.get("nameEn") ?? ""),
        nameAr: String(formData.get("nameAr") ?? ""),
        contactPerson: (formData.get("contactPerson") as string) || null,
        phone: (formData.get("phone") as string) || null,
        email: (formData.get("email") as string) || null,
        creditDays: Number(formData.get("creditDays") ?? 0),
        notes: (formData.get("notes") as string) || null,
      },
      { userId: session.userId },
    );

    revalidatePath("/suppliers");
    return { success: `${supplier.nameEn} added as ${supplier.code}.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function toggleSupplierAction(formData: FormData): Promise<void> {
  const session = await authorize("purchase_order:create");
  await setSupplierActive(
    {
      id: String(formData.get("id") ?? ""),
      isActive: formData.get("isActive") === "true",
    },
    { userId: session.userId },
  );
  revalidatePath("/suppliers");
}
