"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import {
  CommissionError,
  setModeratorRate,
  endModeratorRate,
  settleModerator,
} from "@/lib/moderator-commission";
import { LedgerError } from "@/lib/ledger";
import { formCommand, CommandError } from "@/lib/command";
import type { FormState } from "@/components/entity-form";

function toMessage(error: unknown): string {
  if (
    error instanceof CommissionError ||
    error instanceof LedgerError ||
    error instanceof CommandError
  ) {
    return error.message;
  }
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  if (error && typeof error === "object" && "issues" in error) {
    return (error as { issues: { message: string }[] }).issues.map((i) => i.message).join(" ");
  }
  console.error("Unhandled commission error:", error);
  return "Something went wrong. Nothing was saved.";
}

function day(value: FormDataEntryValue | null): Date {
  const text = String(value ?? "");
  return text ? new Date(`${text}T00:00:00.000Z`) : new Date();
}

function refresh() {
  revalidatePath("/commissions");
  revalidatePath("/journal");
}

/**
 * Putting somebody on commission, or moving them to a new rate.
 *
 * `payment:create` rather than anything to do with taking orders: deciding
 * what a person is paid is not a thing the person being paid should be able
 * to do, and every moderator holds `sales_order:create`.
 */
export async function setRateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await authorize("payment:create");

    const result = await formCommand("commissions.setRate", formData, { userId: session.userId }, () =>
      setModeratorRate(
        {
          userId: String(formData.get("userId") ?? ""),
          perPieceAmount: String(formData.get("perPieceAmount") ?? "0") || "0",
          percentOfNet: String(formData.get("percentOfNet") ?? "0") || "0",
          effectiveFrom: day(formData.get("effectiveFrom")),
          notes: String(formData.get("notes") ?? "") || null,
        },
        { userId: session.userId, reason: null },
      ),
    );

    refresh();
    return { success: result.rateId ? "الرات اتسجّل. اللي قبله اتقفل من اليوم اللي قبل ده." : "اتسجّل." };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

/** Taking somebody off commission, without touching what they already earned. */
export async function endRateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await authorize("payment:create");

    await formCommand("commissions.endRate", formData, { userId: session.userId }, () =>
      endModeratorRate(
        { userId: String(formData.get("userId") ?? ""), lastDay: day(formData.get("lastDay")) },
        { userId: session.userId, reason: null },
      ),
    );

    refresh();
    return { success: "اتقفل. اللي اتكسب قبل كده زي ما هو." };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

/** Paying over everything outstanding, and clearing the debt from the books. */
export async function settleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await authorize("payment:create");

    const result = await formCommand("commissions.settle", formData, { userId: session.userId }, () =>
      settleModerator(
        {
          userId: String(formData.get("userId") ?? ""),
          method: String(formData.get("method") ?? "CASH") as "CASH" | "BANK_TRANSFER" | "INSTAPAY",
          paidOn: day(formData.get("paidOn")),
          notes: String(formData.get("notes") ?? "") || null,
        },
        { userId: session.userId, reason: null },
      ),
    );

    refresh();
    return {
      success: `${result.number} — اتدفع ${Number(result.amount).toFixed(2)} عن ${result.lines} سطر.`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
