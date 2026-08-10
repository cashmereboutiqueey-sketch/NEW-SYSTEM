"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { setCapacity, CapacityError } from "@/lib/capacity";
import type { FormState } from "@/components/entity-form";

function toMessage(error: unknown): string {
  if (error instanceof CapacityError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  console.error("Unhandled capacity error:", error);
  return "Something went wrong. Nothing was saved.";
}

/** Percentages are typed as percentages and stored as fractions. */
function fraction(formData: FormData, key: string): string {
  const n = Number(formData.get(key) ?? 0);
  return String(n / 100);
}

export async function setCapacityAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    // Capacity is what the minute rate is built from, so setting it is the
    // same right as calculating the rate itself.
    const session = await authorize("minute_rate:calculate");

    const result = await setCapacity(
      {
        entityId: String(formData.get("entityId") ?? ""),
        fiscalPeriodId: String(formData.get("fiscalPeriodId") ?? ""),
        operators: Number(formData.get("operators") ?? 0),
        workingDays: String(formData.get("workingDays") ?? ""),
        hoursPerDay: String(formData.get("hoursPerDay") ?? ""),
        utilisationRate: fraction(formData, "utilisationRate"),
        efficiencyRate: fraction(formData, "efficiencyRate"),
        notes: (formData.get("notes") as string) || null,
      },
      { userId: session.userId },
    );

    revalidatePath("/capacity");
    revalidatePath("/minute-rate");

    return {
      success:
        `Saved. ${Number(result.grossMinutes).toLocaleString()} minutes available, ` +
        `${Number(result.productiveMinutes).toLocaleString()} of them productive. ` +
        `Recalculate the minute rate to price against it.`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
