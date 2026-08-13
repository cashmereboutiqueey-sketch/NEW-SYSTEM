"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { freezeScorecards, ScorecardError } from "@/lib/supplier-scorecards";
import type { FormState } from "@/components/entity-form";

/**
 * Freezing a period's scorecards.
 *
 * Behind `settings:manage` rather than a purchasing permission: this writes a
 * judgement about a supplier that is then kept, and the weights it is scored
 * on are the owner's decision.
 */
export async function freezeScorecardsAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("settings:manage");

    const result = await freezeScorecards(
      String(formData.get("fiscalPeriodId") ?? ""),
      { userId: session.userId, reason: null },
    );

    revalidatePath("/suppliers/scorecard");

    return {
      success:
        result.scored === 0
          ? `مفيش أي مورد اتعامل معاه في ${result.period}، فمفيش تقييم اتحفظ.`
          : `اتحفظ تقييم ${result.scored} مورد عن ${result.period}.`,
    };
  } catch (error) {
    if (error instanceof ScorecardError) return { error: error.message };
    if (error instanceof ForbiddenError) {
      return { error: "You do not have permission to freeze scorecards." };
    }
    console.error("Unhandled scorecard error:", error);
    return { error: "Something went wrong. Nothing was saved." };
  }
}
