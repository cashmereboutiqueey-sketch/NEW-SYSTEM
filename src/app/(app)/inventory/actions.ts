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
 * Counting is one right and approving the difference is another, which is why
 * they are two `authorize` calls rather than one. Somebody who holds both can
 * make any amount of stock disappear a little at a time.
 */
export async function recordCountAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("inventory:adjust");

    const approverUserId = (formData.get("approverUserId") as string) || null;
    if (approverUserId) {
      // The approver named on the form must actually hold the right, and the
      // form cannot be trusted to have checked that.
      await authorize("inventory:approve_adjustment");
    }

    const result = await recordCount(
      {
        lotId: String(formData.get("lotId") ?? ""),
        countedQty: String(formData.get("countedQty") ?? ""),
        reason: String(formData.get("reason") ?? ""),
        countDate: new Date(String(formData.get("countDate") ?? "")),
        approverUserId,
      },
      { userId: session.userId },
    );

    revalidatePath("/inventory");
    revalidatePath("/pos");

    if (result.direction === "EXACT") {
      return { success: `${result.lotNumber} counted and agreed. Nothing to adjust.` };
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
