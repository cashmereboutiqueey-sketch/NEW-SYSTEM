"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { recordProductivity, OperatorError } from "@/lib/operators";
import type { FormState } from "@/components/entity-form";

export async function recordProductivityAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("production:create");

    const typed = String(formData.get("clockedMinutes") ?? "").trim();

    const result = await recordProductivity(
      {
        operatorId: String(formData.get("operatorId") ?? ""),
        logDate: new Date(String(formData.get("logDate") ?? "")),
        smvProduced: Number(formData.get("smvProduced") ?? 0),
        clockedMinutes: typed ? Number(typed) : null,
        notes: String(formData.get("notes") ?? "").trim() || null,
      },
      { userId: session.userId, reason: null },
    );

    revalidatePath("/production/operators");

    const pct = (Number(result.efficiency) * 100).toFixed(1);
    const source = result.clockedFromAttendance
      ? "الدقايق من البصمة"
      : "الدقايق مكتوبة بإيد";
    return { success: `اتسجلت. الكفاءة ${pct}% — ${source}.` };
  } catch (error) {
    if (error instanceof OperatorError) return { error: error.message };
    if (error instanceof ForbiddenError) {
      return { error: "You do not have permission to record productivity." };
    }
    if (error && typeof error === "object" && "issues" in error) {
      return {
        error: (error as { issues: { message: string }[] }).issues
          .map((i) => i.message)
          .join(" "),
      };
    }
    console.error("Unhandled operator productivity error:", error);
    return { error: "Something went wrong. Nothing was recorded." };
  }
}
