"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { createSale, openPosSession, closePosSession, SalesError } from "@/lib/sales";
import { LedgerError } from "@/lib/ledger";
import { InventoryError } from "@/lib/inventory";
import { can } from "@/core/permissions";

export type PosState = {
  error?: string;
  success?: string;
  /** Echoed back so the terminal can show a receipt after a sale. */
  receipt?: { orderNumber: string; total: string; change: string };
};

function toMessage(error: unknown): string {
  if (
    error instanceof SalesError ||
    error instanceof LedgerError ||
    error instanceof InventoryError
  ) {
    return error.message;
  }
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  if (error && typeof error === "object" && "issues" in error) {
    return (error as { issues: { message: string }[] }).issues
      .map((i) => i.message)
      .join(" ");
  }
  console.error("Unhandled POS error:", error);
  return "Something went wrong. The sale was not recorded.";
}

export async function openTillAction(_prev: PosState, formData: FormData): Promise<PosState> {
  try {
    const session = await authorize("pos:operate");
    const result = await openPosSession(
      {
        locationId: String(formData.get("locationId") ?? ""),
        cashierUserId: session.userId,
        openingFloat: String(formData.get("openingFloat") || "0"),
      },
      { userId: session.userId },
    );
    revalidatePath("/pos");
    return { success: `Till ${result.sessionNumber} is open.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function closeTillAction(_prev: PosState, formData: FormData): Promise<PosState> {
  try {
    const session = await authorize("pos:close_shift");
    const result = await closePosSession(
      {
        posSessionId: String(formData.get("posSessionId") ?? ""),
        countedCash: String(formData.get("countedCash") ?? "0"),
        note: (formData.get("note") as string) || null,
      },
      { userId: session.userId },
    );

    revalidatePath("/pos");
    const variance = Number(result.variance);
    return {
      success:
        variance === 0
          ? "Till closed and the drawer balances."
          : `Till closed with a ${variance > 0 ? "surplus" : "shortfall"} of ${Math.abs(variance).toFixed(2)}, recorded against the shift.`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

type CartLine = { variantId: string; quantity: number; retailPrice: number; discountPct: number };

export async function checkoutAction(_prev: PosState, formData: FormData): Promise<PosState> {
  try {
    const session = await authorize("pos:operate");

    const cart: CartLine[] = JSON.parse(String(formData.get("cart") ?? "[]"));
    if (cart.length === 0) return { error: "The cart is empty." };

    // Discounting is a separate capability from ringing up a sale, so a
    // cashier cannot mark stock down on their own authority.
    const discounted = cart.some((l) => l.discountPct > 0);
    if (discounted && !can(session.role, "sales_order:discount")) {
      return { error: "You do not have permission to apply a discount." };
    }

    const method = String(formData.get("method") ?? "CASH") as
      | "CASH" | "CARD" | "WALLET" | "COD";
    const tendered = Number(formData.get("tendered") ?? 0);

    const result = await createSale(
      {
        source: "POS",
        channelId: String(formData.get("channelId") ?? ""),
        entityId: String(formData.get("entityId") ?? ""),
        locationId: String(formData.get("locationId") ?? ""),
        posSessionId: String(formData.get("posSessionId") ?? ""),
        customerId: (formData.get("customerId") as string) || null,
        orderDate: new Date(),
        lines: cart,
        payments: [
          {
            method,
            amount: Number(formData.get("total") ?? 0),
            fee: 0,
            // Cash and card at the till are collected there and then; a COD
            // sale from the shop floor is not money in hand yet.
            collected: method !== "COD",
          },
        ],
      },
      { userId: session.userId },
    );

    revalidatePath("/pos");
    const change = Math.max(0, tendered - Number(result.netAmount));

    return {
      success: `Sale ${result.orderNumber} recorded.`,
      receipt: {
        orderNumber: result.orderNumber,
        total: Number(result.netAmount).toFixed(2),
        change: change.toFixed(2),
      },
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
