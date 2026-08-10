"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { LedgerError } from "@/lib/ledger";
import { collectPayment, setCreditTerms, ReceivableError } from "@/lib/receivables";

export type ReceivableState = { error?: string; success?: string };

function toMessage(error: unknown): string {
  if (error instanceof ReceivableError || error instanceof LedgerError) {
    return error.message;
  }
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  console.error("Unhandled receivable error:", error);
  return "Something went wrong. Nothing was saved.";
}

function day(value: FormDataEntryValue | null): Date {
  const text = String(value ?? "");
  const parsed = text ? new Date(text) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export async function collectPaymentAction(
  _prev: ReceivableState,
  formData: FormData,
): Promise<ReceivableState> {
  try {
    const session = await authorize("payment:create");

    const result = await collectPayment(
      {
        salesOrderId: String(formData.get("salesOrderId") ?? ""),
        method: String(formData.get("method") ?? "CASH") as
          | "CASH" | "CARD" | "BANK_TRANSFER" | "WALLET",
        amount: String(formData.get("amount") ?? "0"),
        collectedOn: day(formData.get("collectedOn")),
        reference: String(formData.get("reference") ?? "") || null,
      },
      { userId: session.userId, reason: null },
    );

    revalidatePath("/receivables");
    revalidatePath("/customers");

    return {
      success:
        Number(result.stillOwed) > 0
          ? `اتحصّل ${Number(result.collected).toFixed(2)} على ${result.orderNumber} — فاضل ${Number(result.stillOwed).toFixed(2)}`
          : `${result.orderNumber} اتقفل بالكامل.`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function setCreditTermsAction(
  _prev: ReceivableState,
  formData: FormData,
): Promise<ReceivableState> {
  try {
    // Deciding who may owe money is not the same as taking a payment, so it
    // is gated on extending credit rather than on handling cash.
    const session = await authorize("sales_order:credit");

    await setCreditTerms(
      {
        customerId: String(formData.get("customerId") ?? ""),
        creditLimit: String(formData.get("creditLimit") ?? "0"),
        creditDays: Number(formData.get("creditDays") ?? 0),
      },
      { userId: session.userId, reason: null },
    );

    revalidatePath("/receivables");
    return { success: "الحد اتحدّث." };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
