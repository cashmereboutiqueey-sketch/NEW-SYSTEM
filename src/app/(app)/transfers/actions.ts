"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { despatchToBrand, IntercompanyError } from "@/lib/intercompany";
import { LedgerError } from "@/lib/ledger";
import type { FormState } from "@/components/entity-form";

function toMessage(error: unknown): string {
  if (error instanceof IntercompanyError || error instanceof LedgerError) {
    return error.message;
  }
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  console.error("Unhandled despatch error:", error);
  return "Something went wrong. Nothing was saved.";
}

export async function despatchToBrandAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    // Moving goods out of the warehouse needs the stock-movement right, not
    // merely the right to look at stock.
    const session = await authorize("inventory:transfer");

    const costSnapshotId = String(formData.get("costSnapshotId") ?? "");
    if (!costSnapshotId) {
      return {
        error:
          "These garments were made without a frozen cost, so there is no transfer price to invoice at.",
      };
    }

    const result = await despatchToBrand(
      {
        variantId: String(formData.get("variantId") ?? ""),
        quantity: String(formData.get("quantity") ?? ""),
        fromLocationId: String(formData.get("fromLocationId") ?? ""),
        despatchDate: new Date(String(formData.get("despatchDate") ?? "")),
        costSnapshotId,
        notes: (formData.get("notes") as string) || null,
      },
      { userId: session.userId },
    );

    revalidatePath("/transfers");
    revalidatePath("/goods-in");
    revalidatePath("/inventory");

    return {
      success:
        `Sent on ${result.despatchNumber}. Nothing is invoiced yet — the shop counts ` +
        `it in on the goods-in screen, and the invoice is raised for what actually arrives.`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
