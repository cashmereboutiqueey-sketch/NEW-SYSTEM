"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import {
  createPurchaseOrder,
  receiveGoods,
  payGoodsReceipt,
  PurchasingError,
} from "@/lib/purchasing";
import { InventoryError } from "@/lib/inventory";
import { LedgerError } from "@/lib/ledger";
import type { FormState } from "@/components/entity-form";
import { formCommand, CommandError } from "@/lib/command";

function toMessage(error: unknown): string {
  if (
    error instanceof PurchasingError ||
    error instanceof InventoryError ||
    error instanceof LedgerError ||
    error instanceof CommandError
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
    // A second press after a lost response returns this receipt rather than
    // receiving the same delivery twice.
    const result = await formCommand("purchasing.receive", formData, { userId: session.userId }, () =>
      receiveGoods(
        {
          purchaseOrderId: String(formData.get("purchaseOrderId") ?? ""),
          receivedDate: String(formData.get("receivedDate") ?? ""),
          locationId: String(formData.get("locationId") ?? ""),
          entityId: String(formData.get("entityId") ?? ""),
          invoiceRef: (formData.get("invoiceRef") as string) || null,
          lines,
        },
        { userId: session.userId },
      ),
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

export async function payGoodsReceiptAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    // Paying a supplier is handing out money, whoever raised the order.
    const session = await authorize("payment:create");

    // A second press after a lost response returns this payment rather than
    // paying for the delivery twice.
    const result = await formCommand("purchasing.payReceipt", formData, { userId: session.userId }, () =>
      payGoodsReceipt(
        {
          goodsReceiptId: String(formData.get("goodsReceiptId") ?? ""),
          amount: Number(formData.get("amount")),
          paidDate: String(formData.get("paidDate") ?? ""),
          method: (formData.get("method") as
            | "CASH" | "BANK_TRANSFER" | "INSTAPAY" | "CARD") ?? "BANK_TRANSFER",
          reference: (formData.get("reference") as string) || null,
        },
        { userId: session.userId },
      ),
    );

    revalidatePath("/expenses/aging");
    revalidatePath("/suppliers/statements");
    return {
      success:
        Number(result.outstanding) > 0
          ? `Paid as ${result.journalEntryNumber}; ${Number(result.outstanding).toFixed(2)} still owed.`
          : `Paid in full as ${result.journalEntryNumber}.`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
