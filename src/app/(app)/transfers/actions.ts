"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { transferToBrand, IntercompanyError } from "@/lib/intercompany";
import { LedgerError } from "@/lib/ledger";
import type { FormState } from "@/components/entity-form";

function toMessage(error: unknown): string {
  if (error instanceof IntercompanyError || error instanceof LedgerError) {
    return error.message;
  }
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  console.error("Unhandled transfer error:", error);
  return "Something went wrong. Nothing was saved.";
}

export async function transferToBrandAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    // Moving goods between the two companies changes both sets of books, so it
    // needs the stock-movement right, not merely the right to look at stock.
    const session = await authorize("inventory:transfer");

    const costSnapshotId = String(formData.get("costSnapshotId") ?? "");
    if (!costSnapshotId) {
      return {
        error:
          "These garments were made without a frozen cost, so there is no transfer price to invoice at.",
      };
    }

    const result = await transferToBrand(
      {
        variantId: String(formData.get("variantId") ?? ""),
        quantity: String(formData.get("quantity") ?? ""),
        fromLocationId: String(formData.get("fromLocationId") ?? ""),
        toLocationId: String(formData.get("toLocationId") ?? ""),
        transferDate: new Date(String(formData.get("transferDate") ?? "")),
        costSnapshotId,
      },
      { userId: session.userId },
    );

    revalidatePath("/transfers");
    revalidatePath("/inventory");
    revalidatePath("/pos");

    const margin = Number(result.marginPerUnit);
    return {
      success:
        `Invoiced as ${result.transferNumber}. The goods are now the Brand's, at ` +
        `${Number(result.transferPrice).toFixed(2)} — ${margin.toFixed(2)} per garment of ` +
        `that is internal margin, and stays out of the group's profit until it sells.`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
