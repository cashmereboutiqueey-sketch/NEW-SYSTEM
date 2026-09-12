"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { LedgerError } from "@/lib/ledger";
import { PayrollError } from "@/lib/payroll";
import { approveAndPostPayroll } from "@/lib/payroll";
import {
  approveExpense,
  rejectExpense,
  approvePurchaseOrder,
  rejectPurchaseOrder,
  ApprovalError,
} from "@/lib/approvals";
import {
  approveStockAdjustment,
  rejectStockAdjustment,
  StocktakeError,
} from "@/lib/stocktake";

export type ApprovalState = { error?: string; success?: string };

function toMessage(error: unknown): string {
  if (
    error instanceof ApprovalError ||
    error instanceof PayrollError ||
    error instanceof LedgerError ||
    error instanceof StocktakeError
  ) {
    return error.message;
  }
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  console.error("Unhandled approval error:", error);
  return "Something went wrong. Nothing was saved.";
}

function refresh() {
  revalidatePath("/approvals");
  revalidatePath("/expenses");
  revalidatePath("/purchasing");
  revalidatePath("/hr");
  revalidatePath("/inventory");
}

export async function approveStockAdjustmentAction(
  _prev: ApprovalState,
  formData: FormData,
): Promise<ApprovalState> {
  try {
    // Checked against the person approving, who is whoever is signed in.
    const session = await authorize("inventory:approve_adjustment");
    const result = await approveStockAdjustment(
      { requestId: String(formData.get("requestId") ?? "") },
      { userId: session.userId, reason: null },
    );
    refresh();
    return result.outcome === "STALE"
      ? { error: "The stock has moved since it was counted, so this difference is out of date. It has been closed; count the shelf again." }
      : { success: `اتعتمد واتقيّد (${result.journalEntryNumber}).` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function rejectStockAdjustmentAction(
  _prev: ApprovalState,
  formData: FormData,
): Promise<ApprovalState> {
  try {
    const session = await authorize("inventory:approve_adjustment");
    await rejectStockAdjustment(
      {
        requestId: String(formData.get("requestId") ?? ""),
        reason: String(formData.get("reason") ?? ""),
      },
      { userId: session.userId, reason: null },
    );
    refresh();
    return { success: "اترجّع للي عدّه." };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function approveExpenseAction(
  _prev: ApprovalState,
  formData: FormData,
): Promise<ApprovalState> {
  try {
    const session = await authorize("expense:approve");
    await approveExpense(
      {
        expenseId: String(formData.get("expenseId") ?? ""),
        overrideReason: String(formData.get("overrideReason") ?? "") || null,
      },
      { userId: session.userId, reason: null },
    );
    refresh();
    return { success: "اتعتمد." };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function rejectExpenseAction(
  _prev: ApprovalState,
  formData: FormData,
): Promise<ApprovalState> {
  try {
    const session = await authorize("expense:approve");
    await rejectExpense(
      {
        expenseId: String(formData.get("expenseId") ?? ""),
        reason: String(formData.get("reason") ?? ""),
      },
      { userId: session.userId, reason: null },
    );
    refresh();
    return { success: "اترجّع لصاحبه." };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function approvePurchaseOrderAction(
  _prev: ApprovalState,
  formData: FormData,
): Promise<ApprovalState> {
  try {
    const session = await authorize("purchase_order:approve");
    await approvePurchaseOrder(
      {
        purchaseOrderId: String(formData.get("purchaseOrderId") ?? ""),
        overrideReason: String(formData.get("overrideReason") ?? "") || null,
      },
      { userId: session.userId, reason: null },
    );
    refresh();
    return { success: "الأمر اتعتمد، والبضاعة تقدر تتستلم عليه." };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function rejectPurchaseOrderAction(
  _prev: ApprovalState,
  formData: FormData,
): Promise<ApprovalState> {
  try {
    const session = await authorize("purchase_order:approve");
    await rejectPurchaseOrder(
      {
        purchaseOrderId: String(formData.get("purchaseOrderId") ?? ""),
        reason: String(formData.get("reason") ?? ""),
      },
      { userId: session.userId, reason: null },
    );
    refresh();
    return { success: "اترجّع للمشتريات." };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function approvePayrollAction(
  _prev: ApprovalState,
  formData: FormData,
): Promise<ApprovalState> {
  try {
    // The service has enforced the separation of duties all along; nothing
    // ever called it, so payroll could be prepared and never posted.
    const session = await authorize("payroll:approve");
    const result = await approveAndPostPayroll(
      { payrollRunId: String(formData.get("payrollRunId") ?? "") },
      { userId: session.userId, reason: null },
    );
    refresh();
    return {
      success: `المرتبات اتعتمدت واتقيدت — ${Number(result.totalCharged).toFixed(2)} (${result.journalEntryNumber})`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
