"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { evaluateAlerts, acknowledgeAlert, AlertError } from "@/lib/alerts";
import type { FormState } from "@/components/entity-form";

function toMessage(error: unknown): string {
  if (error instanceof AlertError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  console.error("Unhandled alerts error:", error);
  return "Something went wrong.";
}

export async function runAlertsAction(
  _prev: FormState,
  _formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("alert:view");
    const result = await evaluateAlerts({ userId: session.userId });

    revalidatePath("/alerts");
    revalidatePath("/");

    const parts: string[] = [];
    if (result.raised > 0) parts.push(`${result.raised} raised`);
    if (result.stillOpen > 0) parts.push(`${result.stillOpen} still open`);
    if (result.resolved > 0) parts.push(`${result.resolved} cleared`);

    // A rule that could not read its data is reported rather than passed over
    // in silence — a quiet screen would otherwise look like good news.
    if (result.failed.length > 0) {
      return {
        error:
          `${result.failed.length} rule(s) could not run: ` +
          result.failed.map((f) => `${f.code} (${f.message})`).join("; "),
      };
    }

    return {
      success: parts.length > 0 ? parts.join(", ") + "." : "Nothing to report — everything is within its threshold.",
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function acknowledgeAlertAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("alert:acknowledge");

    const snoozeDays = Number(formData.get("snoozeDays") ?? 0);
    await acknowledgeAlert(
      { alertId: String(formData.get("alertId") ?? ""), snoozeDays },
      { userId: session.userId },
    );

    revalidatePath("/alerts");
    return {
      success:
        snoozeDays > 0
          ? `Snoozed for ${snoozeDays} days. It comes back if the condition is still true.`
          : "Acknowledged.",
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
