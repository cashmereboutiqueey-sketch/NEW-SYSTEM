"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { LedgerError } from "@/lib/ledger";
import {
  createConsignor,
  receiveConsignment,
  sellConsignedItem,
  returnToConsignor,
  settleConsignor,
  ConsignmentError,
} from "@/lib/consignment";

export type ConsignmentState = { error?: string; success?: string };

function toMessage(error: unknown): string {
  if (error instanceof ConsignmentError || error instanceof LedgerError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  console.error("Unhandled consignment error:", error);
  return "Something went wrong. Nothing was saved.";
}

function day(value: FormDataEntryValue | null): Date {
  const text = String(value ?? "");
  const parsed = text ? new Date(text) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function refresh() {
  revalidatePath("/consignment");
  revalidatePath("/pos");
}

/** Typed as a percentage on screen, stored as a fraction. */
function fraction(value: FormDataEntryValue | null): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? String(n / 100) : "0";
}

export async function createConsignorAction(
  _prev: ConsignmentState,
  formData: FormData,
): Promise<ConsignmentState> {
  try {
    const session = await authorize("inventory:transfer");
    const result = await createConsignor(
      {
        code: String(formData.get("code") ?? ""),
        name: String(formData.get("name") ?? ""),
        commissionRate: fraction(formData.get("commissionPct")),
        settlementDays: Number(formData.get("settlementDays") ?? 0),
        phone: String(formData.get("phone") ?? "") || null,
        contactPerson: String(formData.get("contactPerson") ?? "") || null,
      },
      { userId: session.userId, reason: null },
    );
    refresh();
    return { success: `اتضاف ${result.code}.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function receiveConsignmentAction(
  _prev: ConsignmentState,
  formData: FormData,
): Promise<ConsignmentState> {
  try {
    const session = await authorize("inventory:transfer");

    const expires = String(formData.get("expiresAt") ?? "");
    const ratePct = String(formData.get("commissionPct") ?? "").trim();

    const result = await receiveConsignment(
      {
        consignorId: String(formData.get("consignorId") ?? ""),
        description: String(formData.get("description") ?? ""),
        size: String(formData.get("size") ?? "") || null,
        colour: String(formData.get("colour") ?? "") || null,
        quantity: Number(formData.get("quantity") ?? 0),
        retailPrice: String(formData.get("retailPrice") ?? "0"),
        commissionRate: ratePct ? String(Number(ratePct) / 100) : null,
        locationId: String(formData.get("locationId") ?? ""),
        receivedDate: day(formData.get("receivedDate")),
        expiresAt: expires ? new Date(expires) : null,
      },
      { userId: session.userId, reason: null },
    );

    refresh();
    return { success: `اتسجّلت ${result.itemCode}.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function sellConsignedAction(
  _prev: ConsignmentState,
  formData: FormData,
): Promise<ConsignmentState> {
  try {
    const session = await authorize("sales_order:create");

    const price = String(formData.get("soldPrice") ?? "").trim();
    const result = await sellConsignedItem(
      {
        itemId: String(formData.get("itemId") ?? ""),
        quantity: Number(formData.get("quantity") ?? 1),
        soldPrice: price || null,
        paymentMethod: String(formData.get("paymentMethod") ?? "CASH") as
          | "CASH" | "CARD" | "BANK_TRANSFER" | "INSTAPAY" | "COD",
        customerId: String(formData.get("customerId") ?? "") || null,
        saleDate: day(formData.get("saleDate")),
      },
      { userId: session.userId, reason: null },
    );

    refresh();
    return {
      success:
        `${result.saleNumber}: اتباعت بـ ${Number(result.total).toFixed(2)} — ` +
        `عمولتك ${Number(result.commission).toFixed(2)}، ` +
        `وعليك ${Number(result.owedToOwner).toFixed(2)} لصاحبها.`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function returnConsignmentAction(
  _prev: ConsignmentState,
  formData: FormData,
): Promise<ConsignmentState> {
  try {
    const session = await authorize("inventory:transfer");
    const result = await returnToConsignor(
      {
        itemId: String(formData.get("itemId") ?? ""),
        quantity: Number(formData.get("quantity") ?? 0),
        reason: String(formData.get("reason") ?? "") || null,
      },
      { userId: session.userId, reason: null },
    );
    refresh();
    return { success: `رجع ${result.returned} — فاضل ${result.left}.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function settleConsignorAction(
  _prev: ConsignmentState,
  formData: FormData,
): Promise<ConsignmentState> {
  try {
    // Paying somebody money, so it sits with whoever may hand money out.
    const session = await authorize("payment:create");

    const amount = String(formData.get("amount") ?? "").trim();
    const result = await settleConsignor(
      {
        consignorId: String(formData.get("consignorId") ?? ""),
        method: String(formData.get("method") ?? "CASH") as
          | "CASH" | "BANK_TRANSFER" | "INSTAPAY",
        paidOn: day(formData.get("paidOn")),
        amount: amount || null,
        reference: String(formData.get("reference") ?? "") || null,
      },
      { userId: session.userId, reason: null },
    );

    refresh();
    return {
      success: `${result.settlementNumber}: اتدفع ${Number(result.amount).toFixed(2)} عن ${result.salesCovered} بيعة.`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
