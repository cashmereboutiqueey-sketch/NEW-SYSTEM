"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { recordInspection, recordRework, QualityError } from "@/lib/quality";
import type { FormState } from "@/components/entity-form";

function toMessage(error: unknown): string {
  if (error instanceof QualityError) return error.message;
  if (error instanceof ForbiddenError) {
    return "You do not have permission to record quality.";
  }
  if (error && typeof error === "object" && "issues" in error) {
    return (error as { issues: { message: string }[] }).issues.map((i) => i.message).join(" ");
  }
  console.error("Unhandled quality error:", error);
  return "Something went wrong. Nothing was recorded.";
}

export async function recordInspectionAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("production:create");

    const result = await recordInspection(
      {
        productionOrderId: String(formData.get("productionOrderId") ?? ""),
        stage: String(formData.get("stage") ?? "QC") as
          "CUTTING" | "SEWING" | "FINISHING" | "QC" | "PACKING",
        inspectionDate: new Date(String(formData.get("inspectionDate") ?? "")),
        inspectedQty: Number(formData.get("inspectedQty") ?? 0),
        passedQty: Number(formData.get("passedQty") ?? 0),
        reworkQty: Number(formData.get("reworkQty") ?? 0),
        rejectedQty: Number(formData.get("rejectedQty") ?? 0),
        defectNotes: String(formData.get("defectNotes") ?? "").trim() || null,
      },
      { userId: session.userId, reason: null },
    );

    revalidatePath("/production/quality");
    const pct = (Number(result.defectRate) * 100).toFixed(1);
    return { success: `اتسجل الفحص. نسبة العيوب ${pct}%.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function recordReworkAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("production:create");

    const lineId = String(formData.get("lineId") ?? "").trim();
    // Named as a pile and a quantity, never as a price: the cost is whatever
    // FIFO says those units cost.
    const [materialId, locationId] = String(formData.get("materialSource") ?? "").split(":");
    const materialQty = String(formData.get("materialQuantity") ?? "").trim();

    const result = await recordRework(
      {
        productionOrderId: String(formData.get("productionOrderId") ?? ""),
        entityId: String(formData.get("entityId") ?? ""),
        lineId: lineId || null,
        type: String(formData.get("type") ?? "RESEWING") as
          "RESEWING" | "REPRESSING" | "REPACKING" | "RECUTTING" | "WASHING",
        quantity: Number(formData.get("quantity") ?? 0),
        minutesPerUnit: Number(formData.get("minutesPerUnit") ?? 0),
        material:
          materialId && locationId && materialQty
            ? { materialId, locationId, quantity: Number(materialQty) }
            : null,
        reworkDate: new Date(String(formData.get("reworkDate") ?? "")),
        reason: String(formData.get("reason") ?? "").trim() || null,
      },
      { userId: session.userId, reason: null },
    );

    revalidatePath("/production/quality");
    revalidatePath("/alerts");
    return {
      success: `اتسجلت. كلّفت ${result.totalCost} — قيد ${result.journalEntryNumber}.`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
