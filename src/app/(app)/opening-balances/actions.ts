"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import {
  OpeningBalanceError,
  previewOpeningBalance,
  commitOpeningBalance,
  parseCountedFile,
  type OpeningPreview,
} from "@/lib/opening-balance";
import { LedgerError } from "@/lib/ledger";
import { formCommand, CommandError } from "@/lib/command";
import type { FormState } from "@/components/entity-form";
import type { CountedRow } from "@/core/opening-balance";

export type OpeningState = FormState & { preview?: OpeningPreview };

function toMessage(error: unknown): string {
  if (
    error instanceof OpeningBalanceError ||
    error instanceof LedgerError ||
    error instanceof CommandError
  ) {
    return error.message;
  }
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  console.error("Unhandled opening balance error:", error);
  return "Something went wrong. Nothing was saved.";
}

function day(value: FormDataEntryValue | null): Date {
  const text = String(value ?? "");
  return text ? new Date(`${text}T00:00:00.000Z`) : new Date();
}

/**
 * Counts and prices what was found, and writes no stock.
 *
 * Behind `journal:create`, because posting an opening balance is opening the
 * books: it creates an asset out of nothing but a count, and the other side of
 * it is equity.
 */
export async function previewAction(_prev: OpeningState, formData: FormData): Promise<OpeningState> {
  try {
    const session = await authorize("journal:create");

    const text = String(formData.get("text") ?? "");
    const typed = String(formData.get("rows") ?? "");

    // Either a file, or rows typed on the screen — the same shape reaches the
    // same code, so a mistake cannot be possible one way and not the other.
    const rows: CountedRow[] = text.trim()
      ? parseCountedFile(text)
      : typed.trim()
        ? (JSON.parse(typed) as CountedRow[]).map((r, i) => ({ ...r, rowNumber: i + 1 }))
        : [];

    if (rows.length === 0) return { error: "Nothing counted yet — choose a file or add a line." };

    const ratio = String(formData.get("retailCostRatio") ?? "").trim();

    const preview = await previewOpeningBalance(
      {
        entityId: String(formData.get("entityId") ?? ""),
        asOfDate: day(formData.get("asOfDate")),
        // Typed as a percentage on screen, kept as a fraction.
        retailCostRatio: ratio ? String(Number(ratio) / 100) : null,
        filename: String(formData.get("filename") ?? "") || null,
        notes: String(formData.get("notes") ?? "") || null,
        rows,
      },
      { userId: session.userId },
    );

    revalidatePath("/opening-balances");
    return {
      preview,
      success: `${preview.acceptedLines} سطر اتقبل من ${preview.totalLines}. لسه مفيش حاجة اتكتبت.`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

/** Posts it: the stock exists and the books balance. */
export async function commitAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await authorize("journal:create");

    const result = await formCommand(
      "openingBalance.post",
      formData,
      { userId: session.userId },
      () =>
        commitOpeningBalance(
          { batchId: String(formData.get("batchId") ?? "") },
          { userId: session.userId, reason: null },
        ),
    );

    revalidatePath("/opening-balances");
    revalidatePath("/inventory");
    revalidatePath("/journal");
    return {
      success: `${result.number} اتقيّد — ${result.lots} دفعة مخزون بقيمة ${Number(result.value).toFixed(2)}.`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
