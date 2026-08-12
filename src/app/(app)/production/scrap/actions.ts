"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { recordScrap, ScrapError } from "@/lib/scrap";
import type { FormState } from "@/components/entity-form";

/**
 * Recording cloth that came off the table.
 *
 * Sits behind `production:create` rather than a view permission: this writes
 * fabric out of stock and posts a loss to the ledger, so it is the same kind
 * of act as issuing material to a run, not the same kind as reading a report.
 */
export async function recordScrapAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("production:create");

    const productionOrderId = String(formData.get("productionOrderId") ?? "").trim();
    // The material and the pile it comes from travel together: the same cloth
    // in two stores is two different piles.
    const [materialId, locationId] = String(formData.get("source") ?? "").split(":");
    if (!materialId || !locationId) {
      return { error: "Choose which fabric, and where it is." };
    }

    const salvage = String(formData.get("salvageValue") ?? "").trim();

    const result = await recordScrap(
      {
        materialId,
        locationId,
        entityId: String(formData.get("entityId") ?? ""),
        productionOrderId: productionOrderId || null,
        disposition: String(formData.get("disposition") ?? "DISCARDED") as
          "DISCARDED" | "SOLD" | "USED_FOR_SAMPLING" | "RETURNED_TO_STOCK",
        quantity: Number(formData.get("quantity") ?? 0),
        salvageValue: salvage ? Number(salvage) : 0,
        scrapDate: new Date(String(formData.get("scrapDate") ?? "")),
        notes: String(formData.get("notes") ?? "").trim() || null,
      },
      { userId: session.userId, reason: null },
    );

    revalidatePath("/production/scrap");
    revalidatePath("/inventory");
    revalidatePath("/materials");

    return {
      success:
        result.journalEntryNumber === null
          ? "اتسجلت. البضاعة رجعت للمخزن فمفيش خسارة."
          : `اتسجلت. الخسارة ${result.netLoss} — قيد ${result.journalEntryNumber}.`,
    };
  } catch (error) {
    if (error instanceof ScrapError) return { error: error.message };
    if (error instanceof ForbiddenError) {
      return { error: "You do not have permission to write stock off." };
    }
    if (error && typeof error === "object" && "issues" in error) {
      return {
        error: (error as { issues: { message: string }[] }).issues
          .map((i) => i.message)
          .join(" "),
      };
    }
    console.error("Unhandled scrap error:", error);
    return { error: "Something went wrong. Nothing was recorded." };
  }
}
