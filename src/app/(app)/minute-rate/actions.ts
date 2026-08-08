"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import {
  calculatePeriodMinuteRate,
  lockMinuteRatePeriod,
  MinuteRateError,
} from "@/lib/minute-rate";

export type ActionState = { error?: string; success?: string };

function toMessage(error: unknown): string {
  if (error instanceof MinuteRateError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  console.error("Unhandled minute rate action error:", error);
  return "Something went wrong. Nothing was changed.";
}

export async function calculateMinuteRateAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const session = await authorize("minute_rate:calculate");

    const result = await calculatePeriodMinuteRate(
      {
        entityId: String(formData.get("entityId") ?? ""),
        fiscalPeriodId: String(formData.get("fiscalPeriodId") ?? ""),
        cmtRevenueCredit: String(formData.get("cmtRevenueCredit") || "0"),
      },
      { userId: session.userId },
    );

    revalidatePath("/minute-rate");
    return {
      success: result.actualMinuteRate
        ? `Calculated: ${Number(result.actualMinuteRate).toFixed(4)} EGP per minute.`
        : "Calculated, but there are no productive minutes in this period.",
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function lockMinuteRateAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    // Locking is irreversible, so it sits behind the period-close capability
    // rather than the everyday calculate one.
    const session = await authorize("period:close");
    await lockMinuteRatePeriod(String(formData.get("minuteRatePeriodId") ?? ""), {
      userId: session.userId,
    });

    revalidatePath("/minute-rate");
    return { success: "Period locked. This rate can no longer be recalculated." };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
