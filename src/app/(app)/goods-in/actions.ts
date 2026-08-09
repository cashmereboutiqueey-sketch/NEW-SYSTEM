"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { receiveAtBrand, IntercompanyError } from "@/lib/intercompany";
import { LedgerError } from "@/lib/ledger";
import type { FormState } from "@/components/entity-form";

function toMessage(error: unknown): string {
  if (error instanceof IntercompanyError || error instanceof LedgerError) {
    return error.message;
  }
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  console.error("Unhandled goods-in error:", error);
  return "Something went wrong. Nothing was saved.";
}

export async function receiveAtBrandAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("inventory:transfer");

    const result = await receiveAtBrand(
      {
        despatchNumber: String(formData.get("despatchNumber") ?? ""),
        variantId: String(formData.get("variantId") ?? ""),
        countedQty: String(formData.get("countedQty") ?? ""),
        toLocationId: String(formData.get("toLocationId") ?? ""),
        receivedDate: new Date(String(formData.get("receivedDate") ?? "")),
        labelsPrinted: formData.get("labelsPrinted") === "on",
        shortfallNote: (formData.get("shortfallNote") as string) || null,
      },
      { userId: session.userId },
    );

    revalidatePath("/goods-in");
    revalidatePath("/transfers");
    revalidatePath("/inventory");
    revalidatePath("/pos");

    const short = Number(result.shortfallQty);
    return {
      success:
        `${result.countedQty} on the floor, invoiced as ${result.transferNumber}.` +
        (short > 0
          ? ` ${short} did not arrive — charged to the factory as an abnormal loss, so the Brand pays only for what it got.`
          : ""),
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
