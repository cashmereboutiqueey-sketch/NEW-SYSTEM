"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { LedgerError } from "@/lib/ledger";
import { SalesError } from "@/lib/sales";
import { InventoryError } from "@/lib/inventory";
import {
  takeCustomOrder,
  addDeposit,
  linkProductionOrder,
  markReady,
  deliverCustomOrder,
  cancelCustomOrder,
  CustomOrderError,
} from "@/lib/custom-orders";

export type CustomOrderState = { error?: string; success?: string };

function toMessage(error: unknown): string {
  if (
    error instanceof CustomOrderError ||
    error instanceof SalesError ||
    error instanceof InventoryError ||
    error instanceof LedgerError
  ) {
    return error.message;
  }
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  console.error("Unhandled custom order error:", error);
  return "Something went wrong. Nothing was saved.";
}

function day(value: FormDataEntryValue | null): Date {
  const text = String(value ?? "");
  const parsed = text ? new Date(text) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function refresh() {
  revalidatePath("/custom-orders");
  revalidatePath("/receivables");
}

export async function takeCustomOrderAction(
  _prev: CustomOrderState,
  formData: FormData,
): Promise<CustomOrderState> {
  try {
    const session = await authorize("sales_order:create");

    const depositAmount = String(formData.get("depositAmount") ?? "").trim();
    const hasDeposit = depositAmount !== "" && Number(depositAmount) > 0;

    const promised = String(formData.get("promisedDate") ?? "");

    const result = await takeCustomOrder(
      {
        customerId: String(formData.get("customerId") ?? ""),
        variantId: String(formData.get("variantId") ?? ""),
        quantity: Number(formData.get("quantity") ?? 1),
        agreedUnitPrice: String(formData.get("agreedUnitPrice") ?? "0"),
        deposit: hasDeposit
          ? {
              amount: depositAmount,
              method: String(formData.get("depositMethod") ?? "CASH") as
                | "CASH" | "CARD" | "BANK_TRANSFER" | "WALLET",
            }
          : null,
        entityId: String(formData.get("entityId") ?? ""),
        locationId: String(formData.get("locationId") ?? ""),
        orderDate: day(formData.get("orderDate")),
        promisedDate: promised ? new Date(promised) : null,
        notes: String(formData.get("notes") ?? "") || null,
      },
      { userId: session.userId, reason: null },
    );

    refresh();
    return {
      success: `اتسجّل ${result.orderNumber} بـ ${Number(result.agreedTotal).toFixed(2)}${
        Number(result.deposit) > 0 ? ` وعربون ${Number(result.deposit).toFixed(2)}` : " من غير عربون"
      }`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function addDepositAction(
  _prev: CustomOrderState,
  formData: FormData,
): Promise<CustomOrderState> {
  try {
    const session = await authorize("payment:create");

    const result = await addDeposit(
      {
        customOrderId: String(formData.get("customOrderId") ?? ""),
        amount: String(formData.get("amount") ?? "0"),
        method: String(formData.get("method") ?? "CASH") as
          | "CASH" | "CARD" | "BANK_TRANSFER" | "WALLET",
        paidOn: day(formData.get("paidOn")),
      },
      { userId: session.userId, reason: null },
    );

    refresh();
    return {
      success: `العربون بقى ${Number(result.deposit).toFixed(2)} — فاضل ${Number(result.stillDue).toFixed(2)}`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function linkRunAction(
  _prev: CustomOrderState,
  formData: FormData,
): Promise<CustomOrderState> {
  try {
    const session = await authorize("production:create");

    await linkProductionOrder(
      {
        customOrderId: String(formData.get("customOrderId") ?? ""),
        productionOrderId: String(formData.get("productionOrderId") ?? ""),
      },
      { userId: session.userId, reason: null },
    );

    refresh();
    revalidatePath("/production");
    return { success: "الأوردر اتربط بأمر الإنتاج." };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function markReadyAction(
  _prev: CustomOrderState,
  formData: FormData,
): Promise<CustomOrderState> {
  try {
    const session = await authorize("production:record");
    await markReady(
      { customOrderId: String(formData.get("customOrderId") ?? "") },
      { userId: session.userId, reason: null },
    );
    refresh();
    return { success: "جاهز للتسليم." };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function deliverAction(
  _prev: CustomOrderState,
  formData: FormData,
): Promise<CustomOrderState> {
  try {
    const session = await authorize("sales_order:create");

    const payNow = String(formData.get("payNow") ?? "").trim();

    const result = await deliverCustomOrder(
      {
        customOrderId: String(formData.get("customOrderId") ?? ""),
        deliveredOn: day(formData.get("deliveredOn")),
        payNow:
          payNow !== "" && Number(payNow) > 0
            ? {
                amount: payNow,
                method: String(formData.get("method") ?? "CASH") as
                  | "CASH" | "CARD" | "BANK_TRANSFER" | "WALLET",
              }
            : null,
        channelId: String(formData.get("channelId") ?? ""),
      },
      { userId: session.userId, reason: null },
    );

    refresh();
    revalidatePath("/sales");
    revalidatePath("/inventory");

    return {
      success:
        Number(result.stillOwed) > 0
          ? `اتسلّم — فاتورة ${result.salesOrderNumber}، وعليه ${Number(result.stillOwed).toFixed(2)}`
          : `اتسلّم واتسدّد بالكامل — فاتورة ${result.salesOrderNumber}`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function cancelAction(
  _prev: CustomOrderState,
  formData: FormData,
): Promise<CustomOrderState> {
  try {
    // Cancelling gives somebody their money back, so it sits with the people
    // who may hand money out rather than with whoever took the order.
    const session = await authorize("payment:create");

    const result = await cancelCustomOrder(
      {
        customOrderId: String(formData.get("customOrderId") ?? ""),
        reason: String(formData.get("reason") ?? ""),
        cancelledOn: day(formData.get("cancelledOn")),
        refundMethod: String(formData.get("refundMethod") ?? "CASH") as
          | "CASH" | "CARD" | "BANK_TRANSFER" | "WALLET",
      },
      { userId: session.userId, reason: null },
    );

    refresh();
    return {
      success:
        Number(result.refunded) > 0
          ? `اتلغى، واترجّع عربون ${Number(result.refunded).toFixed(2)}`
          : "اتلغى.",
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
