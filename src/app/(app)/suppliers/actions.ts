"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { createSupplier, setSupplierActive, MasterDataError } from "@/lib/master-data";
import { createSupplierOpeningBalance, paySupplierOpeningBalance, SupplierOpeningError } from "@/lib/supplier-opening-balances";
import { LedgerError } from "@/lib/ledger";
import { formCommand, CommandError } from "@/lib/command";
import type { FormState } from "@/components/entity-form";

function toMessage(error: unknown): string {
  if (error instanceof MasterDataError || error instanceof SupplierOpeningError ||
      error instanceof LedgerError || error instanceof CommandError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  if (error && typeof error === "object" && "issues" in error) {
    return (error as { issues: { message: string }[] }).issues
      .map((i) => i.message)
      .join(" ");
  }
  console.error("Unhandled master data error:", error);
  return "Something went wrong. Nothing was saved.";
}

export async function createSupplierOpeningAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("journal:create");
    const result = await formCommand("supplierOpening.create", formData,
      { userId: session.userId }, () => createSupplierOpeningBalance({
        supplierId: String(formData.get("supplierId") ?? ""),
        entityId: String(formData.get("entityId") ?? ""),
        amount: String(formData.get("amount") ?? ""),
        asOfDate: new Date(String(formData.get("asOfDate") ?? "")),
        dueDate: new Date(String(formData.get("dueDate") ?? "")),
        note: String(formData.get("note") ?? "") || null,
      }, { userId: session.userId }),
    );
    revalidatePath("/suppliers");
    revalidatePath("/suppliers/statements");
    revalidatePath("/expenses/aging");
    return { success: `Opening balance of ${Number(result.amount).toFixed(2)} recorded.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function paySupplierOpeningAction(
  _prev: FormState, formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("payment:create");
    const result = await formCommand("supplierOpening.pay", formData,
      { userId: session.userId }, () => paySupplierOpeningBalance({
        openingBalanceId: String(formData.get("openingBalanceId") ?? ""),
        amount: String(formData.get("amount") ?? ""),
        paidDate: new Date(String(formData.get("paidDate") ?? "")),
        method: String(formData.get("method") ?? "BANK_TRANSFER") as
          "CASH" | "CARD" | "BANK_TRANSFER" | "INSTAPAY",
        reference: String(formData.get("reference") ?? "") || null,
      }, { userId: session.userId }),
    );
    revalidatePath("/suppliers");
    revalidatePath("/suppliers/statements");
    revalidatePath("/expenses/aging");
    return { success: `Payment recorded. ${Number(result.outstanding).toFixed(2)} remains.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
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
