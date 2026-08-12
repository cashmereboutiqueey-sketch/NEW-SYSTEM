"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { logStage, StageLogError } from "@/lib/stage-logs";
import type { FormState } from "@/components/entity-form";

/**
 * Logging a shift.
 *
 * Nothing here reaches the ledger — labour is already in the minute rate and
 * flows into every garment through the cost snapshot — but it decides what the
 * floor is measured on, so it sits behind `production:create` rather than a
 * view permission.
 */
export async function logStageAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("production:create");

    const lineId = String(formData.get("lineId") ?? "").trim();
    const operators = String(formData.get("operatorsCount") ?? "").trim();

    const result = await logStage(
      {
        productionOrderId: String(formData.get("productionOrderId") ?? ""),
        lineId: lineId || null,
        stage: String(formData.get("stage") ?? "SEWING") as
          "CUTTING" | "SEWING" | "FINISHING" | "QC" | "PACKING",
        logDate: new Date(String(formData.get("logDate") ?? "")),
        qtyIn: Number(formData.get("qtyIn") ?? 0),
        qtyOut: Number(formData.get("qtyOut") ?? 0),
        operatorsCount: operators ? Number(operators) : null,
        clockedMinutes: Number(formData.get("clockedMinutes") ?? 0),
        notes: String(formData.get("notes") ?? "").trim() || null,
      },
      { userId: session.userId, reason: null },
    );

    revalidatePath("/production/lines");
    revalidatePath("/capacity");

    const pct = (Number(result.efficiency) * 100).toFixed(1);
    return { success: `اتسجلت. كفاءة الوردية ${pct}%.` };
  } catch (error) {
    if (error instanceof StageLogError) return { error: error.message };
    if (error instanceof ForbiddenError) {
      return { error: "You do not have permission to log production." };
    }
    if (error && typeof error === "object" && "issues" in error) {
      return {
        error: (error as { issues: { message: string }[] }).issues
          .map((i) => i.message)
          .join(" "),
      };
    }
    console.error("Unhandled stage log error:", error);
    return { error: "Something went wrong. Nothing was recorded." };
  }
}
