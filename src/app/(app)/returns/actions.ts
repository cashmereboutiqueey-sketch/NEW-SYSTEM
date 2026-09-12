"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { LedgerError } from "@/lib/ledger";
import {
  recordReturn,
  returnableLines,
  releaseRepairedStock,
  ReturnError,
  type RefundMethod,
} from "@/lib/returns";
import { formCommand, CommandError } from "@/lib/command";

export type ReturnState = { error?: string; success?: string };

function toMessage(error: unknown): string {
  if (
    error instanceof ReturnError ||
    error instanceof LedgerError ||
    error instanceof CommandError
  ) {
    return error.message;
  }
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  console.error("Unhandled return error:", error);
  return "Something went wrong. Nothing was saved.";
}

export type OrderPicture = Awaited<ReturnType<typeof returnableLines>>;

/**
 * Declaring a repaired return fit to sell. The same right as adjusting stock:
 * it changes what the till may sell.
 */
export async function releaseRepairAction(
  _prev: ReturnState,
  formData: FormData,
): Promise<ReturnState> {
  try {
    const session = await authorize("inventory:adjust");
    const result = await releaseRepairedStock(
      {
        lotId: String(formData.get("lotId") ?? ""),
        note: String(formData.get("note") ?? "") || null,
      },
      { userId: session.userId, reason: null },
    );
    revalidatePath("/returns");
    revalidatePath("/inventory");
    revalidatePath("/pos");
    return { success: `${result.lotNumber}: ${result.released} رجعت للبيع.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

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

    // A second press after a lost response returns this refund rather than
    // handing the money back twice.
    const result = await formCommand("returns.record", formData, { userId: session.userId }, () =>
      recordReturn(
        {
          salesOrderId: String(formData.get("salesOrderId") ?? ""),
          variantId: String(formData.get("variantId") ?? ""),
          quantity: Number(formData.get("quantity") ?? 0),
          disposition: String(formData.get("disposition") ?? "RESTOCK") as
            | "RESTOCK" | "WRITE_OFF" | "REPAIR_AND_RESTOCK",
          refundMethod: String(formData.get("refundMethod") ?? "CASH") as RefundMethod,
          refundAmount: String(formData.get("refundAmount") ?? "") || null,
          creditAgainstBalance: formData.get("creditAgainstBalance") === "on",
          reason: String(formData.get("reason") ?? "") || null,
          returnDate: Number.isNaN(parsed.getTime()) ? new Date() : parsed,
        },
        { userId: session.userId, reason: null },
      ),
    );

    revalidatePath("/returns");
    revalidatePath("/inventory");
    revalidatePath("/sales");
    revalidatePath("/receivables");

    return {
      success: [
        `${result.returnNumber}:`,
        Number(result.creditedBalance) > 0
          ? `اتخصم ${Number(result.creditedBalance).toFixed(2)} من المديونية`
          : null,
        Number(result.cashRefunded) > 0 ? `واترد ${Number(result.cashRefunded).toFixed(2)}` : null,
        result.restocked > 0
          ? `و${result.restocked} قطعة رجعت المخزن.`
          : "والقطعة اتشالت من المخزون.",
      ]
        .filter(Boolean)
        .join(" "),
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
