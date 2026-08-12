"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { createCostSnapshot, CostingError } from "@/lib/costing";

export type ActionState = { error?: string; success?: string };

function toMessage(error: unknown): string {
  if (error instanceof CostingError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  console.error("Unhandled costing action error:", error);
  return "Something went wrong. Nothing was saved.";
}

export async function createSnapshotAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const margin = String(formData.get("factoryMarkupPct") ?? "").trim();
    const approvalNote = String(formData.get("approvalNote") ?? "").trim();

    // Overriding the margin is a separate, owner-only capability from simply
    // viewing a price, because it is how an arm's-length price gets discounted.
    const session = await authorize(
      margin ? "transfer_price:override" : "production:confirm_cost",
    );

    const result = await createCostSnapshot(
      {
        styleId: String(formData.get("styleId") ?? ""),
        minuteRatePeriodId: String(formData.get("minuteRatePeriodId") ?? ""),
        factoryMarkupPct: margin || undefined,
        reason: String(formData.get("reason") ?? "") || undefined,
        approvalNote: approvalNote || undefined,
      },
      { userId: session.userId },
    );

    revalidatePath("/costing");
    return {
      success: result.belowFloor
        ? `Frozen at ${Number(result.transferPrice).toFixed(2)} EGP — recorded as below the arm's-length floor.`
        : `Frozen at ${Number(result.transferPrice).toFixed(2)} EGP.`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
