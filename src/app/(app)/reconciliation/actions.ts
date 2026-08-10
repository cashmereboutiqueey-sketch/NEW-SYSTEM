"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import {
  recordSettlement,
  importStatement,
  autoMatch,
  matchLine,
  explainLine,
  ReconciliationError,
} from "@/lib/reconciliation";
import { LedgerError } from "@/lib/ledger";
import type { FormState } from "@/components/entity-form";

function toMessage(error: unknown): string {
  if (error instanceof ReconciliationError || error instanceof LedgerError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  console.error("Unhandled reconciliation error:", error);
  return "Something went wrong. Nothing was saved.";
}

export async function recordSettlementAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    // Clearing money into the bank is a payment event, not a bookkeeping one.
    const session = await authorize("payment:create");

    const paymentIds = String(formData.get("paymentIds") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const result = await recordSettlement(
      {
        provider: String(formData.get("provider") ?? "COURIER") as
          | "COURIER" | "PAYMENT_GATEWAY",
        entityId: String(formData.get("entityId") ?? ""),
        channelId: (formData.get("channelId") as string) || null,
        reference: (formData.get("reference") as string) || null,
        settlementDate: new Date(String(formData.get("settlementDate") ?? "")),
        netReceived: String(formData.get("netReceived") ?? "0"),
        paymentIds,
        varianceNote: (formData.get("varianceNote") as string) || null,
      },
      { userId: session.userId },
    );

    revalidatePath("/reconciliation");
    revalidatePath("/cash-flow");
    revalidatePath("/");

    const variance = Number(result.variance);
    return {
      success:
        `${result.settlementNumber} posted as ${result.journalEntryNumber}: ` +
        `${result.cleared} order(s) cleared for ${Number(result.netReceived).toFixed(2)}.` +
        (variance === 0
          ? " It matched to the piastre."
          : ` They paid ${Math.abs(variance).toFixed(2)} ${variance < 0 ? "short" : "over"}, charged to fees.`),
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function importStatementAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("journal:view");

    // One line per row: date, description, amount. Signed, so a single column
    // says which way the money went.
    const raw = String(formData.get("lines") ?? "").trim();
    if (!raw) return { error: "Paste the statement lines first." };

    const lines: { valueDate: Date; description: string; reference: string | null; amount: string }[] = [];
    const rejected: string[] = [];

    for (const [i, row] of raw.split("\n").entries()) {
      const text = row.trim();
      if (!text) continue;

      const parts = text.split(/\t|\s*,\s*|\s{2,}/).map((p) => p.trim()).filter(Boolean);
      if (parts.length < 3) {
        rejected.push(`line ${i + 1}`);
        continue;
      }

      const date = new Date(parts[0]);
      const amount = Number(parts[parts.length - 1].replace(/[^0-9.\-]/g, ""));
      if (Number.isNaN(date.getTime()) || !Number.isFinite(amount)) {
        rejected.push(`line ${i + 1}`);
        continue;
      }

      lines.push({
        valueDate: date,
        description: parts.slice(1, -1).join(" "),
        reference: null,
        amount: String(amount),
      });
    }

    if (lines.length === 0) {
      return {
        error:
          "None of those rows could be read. Each needs a date, a description and an amount, separated by tabs or commas.",
      };
    }

    const result = await importStatement(
      {
        accountCode: String(formData.get("accountCode") ?? "1120"),
        entityId: String(formData.get("entityId") ?? ""),
        statementDate: new Date(String(formData.get("statementDate") ?? "")),
        openingBalance: String(formData.get("openingBalance") ?? "0"),
        closingBalance: String(formData.get("closingBalance") ?? "0"),
        reference: (formData.get("reference") as string) || null,
        lines,
      },
      { userId: session.userId },
    );

    revalidatePath("/reconciliation");

    return {
      success:
        `${result.imported} line(s) read, ${result.matched} matched automatically.` +
        (rejected.length > 0 ? ` ${rejected.length} row(s) could not be read and were skipped.` : "") +
        (result.imported > result.matched
          ? ` ${result.imported - result.matched} need looking at.`
          : ""),
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function autoMatchAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    await authorize("journal:view");
    const matched = await autoMatch(String(formData.get("statementId") ?? ""));
    revalidatePath("/reconciliation");
    return {
      success:
        matched > 0
          ? `${matched} more matched.`
          : "Nothing else could be matched without guessing.",
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function matchLineAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("journal:create");
    await matchLine(
      {
        bankStatementLineId: String(formData.get("bankStatementLineId") ?? ""),
        journalLineId: String(formData.get("journalLineId") ?? ""),
      },
      { userId: session.userId },
    );
    revalidatePath("/reconciliation");
    return { success: "Matched." };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function explainLineAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("journal:create");
    await explainLine(
      {
        bankStatementLineId: String(formData.get("bankStatementLineId") ?? ""),
        note: String(formData.get("note") ?? ""),
      },
      { userId: session.userId },
    );
    revalidatePath("/reconciliation");
    return {
      success: "Noted. It still needs entering as an expense — this only records what it is.",
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
