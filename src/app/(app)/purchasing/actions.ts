"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { createPurchaseOrder, receiveGoods, PurchasingError } from "@/lib/purchasing";
import { InventoryError } from "@/lib/inventory";
import { LedgerError } from "@/lib/ledger";
import type { FormState } from "@/components/entity-form";

function toMessage(error: unknown): string {
  if (
    error instanceof PurchasingError ||
    error instanceof InventoryError ||
    error instanceof LedgerError
  ) {
    return error.message;
  }
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  if (error && typeof error === "object" && "issues" in error) {
    return (error as { issues: { message: string }[] }).issues
      .map((i) => i.message)
      .join(" ");
  }
  console.error("Unhandled purchasing error:", error);
  return "Something went wrong. Nothing was saved.";
}

export async function createPurchaseOrderAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("purchase_order:create");

    const lines = JSON.parse(String(formData.get("lines") ?? "[]"));
    const result = await createPurchaseOrder(
      {
        supplierId: String(formData.get("supplierId") ?? ""),
        orderDate: String(formData.get("orderDate") ?? ""),
        expectedDate: String(formData.get("expectedDate") ?? "") || null,
        notes: (formData.get("notes") as string) || null,
        lines,
      },
      { userId: session.userId },
    );

    revalidatePath("/purchasing");
    return { success: `Order ${result.poNumber} raised for ${Number(result.total).toFixed(2)}.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function receiveGoodsAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    // Receiving is a warehouse act, separate from raising the order.
    const session = await authorize("goods_receipt:create");

    const lines = JSON.parse(String(formData.get("lines") ?? "[]"));
    const result = await receiveGoods(
      {
        purchaseOrderId: String(formData.get("purchaseOrderId") ?? ""),
        receivedDate: String(formData.get("receivedDate") ?? ""),
        locationId: String(formData.get("locationId") ?? ""),
        entityId: String(formData.get("entityId") ?? ""),
        invoiceRef: (formData.get("invoiceRef") as string) || null,
        lines,
      },
      { userId: session.userId },
    );

    revalidatePath("/purchasing");
    revalidatePath("/inventory");

    const variance = Number(result.priceVariance);
    return {
      success:
        variance === 0
          ? `Received as ${result.receiptNumber}.`
          : `Received as ${result.receiptNumber}, with a price variance of ${variance > 0 ? "+" : ""}${variance.toFixed(2)} against the order.`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
