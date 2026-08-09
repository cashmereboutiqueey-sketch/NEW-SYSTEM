"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { runScenario, deleteScenario, ScenarioError } from "@/lib/scenarios";
import type { Assumptions } from "@/core/scenario";
import type { FormState } from "@/components/entity-form";

function toMessage(error: unknown): string {
  if (error instanceof ScenarioError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  console.error("Unhandled scenario error:", error);
  return "Something went wrong. Nothing was saved.";
}

/** Reads a percentage field, returning undefined when it was left blank. */
function optionalPct(formData: FormData, key: string): number | undefined {
  const raw = formData.get(key);
  if (raw == null || String(raw).trim() === "") return undefined;
  const n = Number(raw);
  // A blank field means "leave it alone"; zero means "set it to zero", and
  // those are different instructions.
  return Number.isFinite(n) ? n / 100 : undefined;
}

export async function runScenarioAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("scenario:run");

    const assumptions: Assumptions = {
      fabricPriceDeltaPct: optionalPct(formData, "fabricPriceDeltaPct"),
      wageDeltaPct: optionalPct(formData, "wageDeltaPct"),
      marketingDeltaPct: optionalPct(formData, "marketingDeltaPct"),
      retailPriceDeltaPct: optionalPct(formData, "retailPriceDeltaPct"),
      unitsSoldDeltaPct: optionalPct(formData, "unitsSoldDeltaPct"),
      utilisationRate: optionalPct(formData, "utilisationRate"),
      efficiencyRate: optionalPct(formData, "efficiencyRate"),
      discountRate: optionalPct(formData, "discountRate"),
      returnRate: optionalPct(formData, "returnRate"),
    };

    const stated = Object.values(assumptions).filter((v) => v !== undefined);
    if (stated.length === 0) {
      return { error: "Change at least one assumption, or the answer is the month you already had." };
    }

    const result = await runScenario(
      {
        name: String(formData.get("name") ?? ""),
        descriptionAr: (formData.get("description") as string) || null,
        assumptions,
      },
      { userId: session.userId },
    );

    revalidatePath("/scenarios");
    return { success: `Run against ${result.periodLabel}.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function deleteScenarioAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("scenario:run");
    await deleteScenario(String(formData.get("scenarioId") ?? ""), { userId: session.userId });
    revalidatePath("/scenarios");
    return { success: "Deleted." };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
