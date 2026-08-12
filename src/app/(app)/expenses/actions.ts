"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { createExpense, payExpense, ExpenseError } from "@/lib/expenses";
import { LedgerError } from "@/lib/ledger";

export type ActionState = { error?: string; success?: string };

/**
 * Turns a thrown error into something safe to show.
 *
 * Domain errors are written for the user and are shown as-is. Anything else is
 * a bug or a database message and is replaced with a generic line, so internal
 * details never reach the browser.
 */
function toMessage(error: unknown): string {
  if (error instanceof ExpenseError || error instanceof LedgerError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  if (error && typeof error === "object" && "issues" in error) {
    const issues = (error as { issues: { message: string }[] }).issues;
    return issues.map((i) => i.message).join(" ");
  }
  console.error("Unhandled expense action error:", error);
  return "Something went wrong. The change was not saved.";
}

export async function createExpenseAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const session = await authorize("expense:create");

    const result = await createExpense(
      {
        entityId: String(formData.get("entityId") ?? ""),
        costCategoryId: String(formData.get("costCategoryId") ?? ""),
        supplierId: (formData.get("supplierId") as string) || null,
        costCenterId: (formData.get("costCenterId") as string) || null,
        description: String(formData.get("description") ?? ""),
        reference: (formData.get("reference") as string) || null,
        amount: Number(formData.get("amount")),
        incurredDate: String(formData.get("incurredDate") ?? ""),
        dueDate: String(formData.get("dueDate") ?? ""),
      },
      { userId: session.userId },
    );

    revalidatePath("/expenses");
    return { success: `Recorded and posted as ${result.journalEntryNumber}.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function payExpenseAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const session = await authorize("payment:create");

    const result = await payExpense(
      {
        expenseId: String(formData.get("expenseId") ?? ""),
        amount: Number(formData.get("amount")),
        paidDate: String(formData.get("paidDate") ?? ""),
        // Cash leaves the box, everything else leaves the bank — but which
        // one was used is what makes a bank statement reconcilable.
        method: (formData.get("method") as
          | "CASH" | "BANK_TRANSFER" | "INSTAPAY" | "CARD") ?? "BANK_TRANSFER",
        reference: (formData.get("reference") as string) || null,
      },
      { userId: session.userId },
    );

    revalidatePath("/expenses");
    return { success: `Payment posted as ${result.journalEntryNumber}.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
