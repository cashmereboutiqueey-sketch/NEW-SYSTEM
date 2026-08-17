"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { reverseJournalEntry, JournalError } from "@/lib/journal";
import { LedgerError } from "@/lib/ledger";
import type { FormState } from "@/components/entity-form";

/**
 * Correcting a posted entry.
 *
 * `journal:reverse` was declared from the first migration and nothing had ever
 * checked it, because nothing could reverse anything. It is deliberately a
 * separate permission from posting: whoever can make an entry should not
 * silently be able to unmake one.
 */
export async function reverseEntryAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("journal:reverse");

    const result = await reverseJournalEntry(
      {
        entryId: String(formData.get("entryId") ?? ""),
        // Today, not the original's date. A correction belongs in the period
        // it was noticed in — backdating it into a period that has been
        // reported on would restate a month somebody has already closed.
        postingDate: new Date(),
        reason: String(formData.get("reason") ?? ""),
      },
      { userId: session.userId, reason: String(formData.get("reason") ?? "") },
    );

    revalidatePath("/journal");
    revalidatePath("/reports/group-pnl");

    return { success: `اتعكس بالقيد ${result.entryNumber}. الأصلي زي ما هو.` };
  } catch (error) {
    if (error instanceof JournalError || error instanceof LedgerError) {
      return { error: error.message };
    }
    if (error instanceof ForbiddenError) {
      return { error: "You do not have permission to reverse a posting." };
    }
    if (error && typeof error === "object" && "issues" in error) {
      return {
        error: (error as { issues: { message: string }[] }).issues
          .map((i) => i.message)
          .join(" "),
      };
    }
    console.error("Unhandled reversal error:", error);
    return { error: "Something went wrong. Nothing was reversed." };
  }
}
