"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { recordCount, StocktakeError } from "@/lib/stocktake";
import { LedgerError } from "@/lib/ledger";
import type { FormState } from "@/components/entity-form";

function toMessage(error: unknown): string {
  if (error instanceof StocktakeError || error instanceof LedgerError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  console.error("Unhandled stocktake error:", error);
  return "Something went wrong. Nothing was saved.";
}

/**
 * Recording a count.
 *
 * Counting is one right and approving the difference is another. A difference
 * over the approval limit is not approved here at all: it goes to the
 * approvals inbox, where somebody else approves it signed in as themselves.
 */
export async function recordCountAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("inventory:adjust");

    const result = await recordCount(
      {
        lotId: String(formData.get("lotId") ?? ""),
        countedQty: String(formData.get("countedQty") ?? ""),
        reason: String(formData.get("reason") ?? ""),
        countDate: new Date(String(formData.get("countDate") ?? "")),
      },
      { userId: session.userId },
    );

    revalidatePath("/inventory");
    revalidatePath("/pos");
    revalidatePath("/approvals");

    if (result.direction === "EXACT") {
      return { success: `${result.lotNumber} counted and agreed. Nothing to adjust.` };
    }
    if (result.direction === "PENDING") {
      return {
        success:
          `${result.lotNumber}: a difference of ${result.difference}, worth ` +
          `${Number(result.value).toFixed(2)}, is waiting in approvals. Nothing moves until ` +
          `somebody else approves it.`,
      };
    }

    return {
      success:
        `${result.lotNumber} adjusted by ${result.difference}, ` +
        `worth ${Number(result.value).toFixed(2)}, posted as ${result.journalEntryNumber}.`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
