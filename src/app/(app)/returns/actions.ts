"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { LedgerError } from "@/lib/ledger";
import { recordReturn, returnableLines, ReturnError, type RefundMethod } from "@/lib/returns";

export type ReturnState = { error?: string; success?: string };

function toMessage(error: unknown): string {
  if (error instanceof ReturnError || error instanceof LedgerError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  console.error("Unhandled return error:", error);
  return "Something went wrong. Nothing was saved.";
}

export type OrderPicture = Awaited<ReturnType<typeof returnableLines>>;

/** What is still returnable on an order, once the cashier has found it. */
export async function loadOrderAction(
  salesOrderId: string,
): Promise<OrderPicture | { error: string }> {
  try {
    await authorize("sales_order:refund");
    return await returnableLines(salesOrderId);
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function recordReturnAction(
  _prev: ReturnState,
  formData: FormData,
): Promise<ReturnState> {
  try {
    const session = await authorize("sales_order:refund");

    const dateText = String(formData.get("returnDate") ?? "");
    const parsed = dateText ? new Date(dateText) : new Date();

    const result = await recordReturn(
      {
        salesOrderId: String(formData.get("salesOrderId") ?? ""),
        variantId: String(formData.get("variantId") ?? ""),
        quantity: Number(formData.get("quantity") ?? 0),
        disposition: String(formData.get("disposition") ?? "RESTOCK") as
          | "RESTOCK" | "WRITE_OFF" | "REPAIR_AND_RESTOCK",
        refundMethod: String(formData.get("refundMethod") ?? "CASH") as RefundMethod,
        refundAmount: String(formData.get("refundAmount") ?? "") || null,
        reason: String(formData.get("reason") ?? "") || null,
        returnDate: Number.isNaN(parsed.getTime()) ? new Date() : parsed,
      },
      { userId: session.userId, reason: null },
    );

    revalidatePath("/returns");
    revalidatePath("/inventory");
    revalidatePath("/sales");
    revalidatePath("/receivables");

    return {
      success:
        result.restocked > 0
          ? `${result.returnNumber}: اترجّع ${Number(result.refunded).toFixed(2)} و${result.restocked} قطعة رجعت المخزن.`
          : `${result.returnNumber}: اترجّع ${Number(result.refunded).toFixed(2)}، والقطعة اتشالت من المخزون.`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
