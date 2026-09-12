"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { createSale, SalesError } from "@/lib/sales";
import { InventoryError } from "@/lib/inventory";
import { LedgerError } from "@/lib/ledger";
import type { FormState } from "@/components/entity-form";
import { can } from "@/core/permissions";
import { formCommand, CommandError } from "@/lib/command";
import { checkOwnedPrices, ownedTotal, SalePriceError } from "@/lib/sale-prices";
import { dec, roundMoney } from "@/lib/money";

function toMessage(error: unknown): string {
  if (
    error instanceof SalesError ||
    error instanceof InventoryError ||
    error instanceof LedgerError ||
    error instanceof SalePriceError ||
    error instanceof CommandError
  ) {
    return error.message;
  }
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  if (error && typeof error === "object" && "issues" in error) {
    return (error as { issues: { message: string }[] }).issues.map((i) => i.message).join(" ");
  }
  console.error("Unhandled sales error:", error);
  return "Something went wrong. Nothing was saved.";
}

/**
 * An order taken by hand — WhatsApp, Instagram, a phone call.
 *
 * Same engine as the till and the website: stock is relieved, cost of goods
 * sold is posted against the lot it came from, and the order carries who took
 * it. A social order recorded in a notebook is a sale nobody can cost.
 */
export async function createModeratorSaleAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("sales_order:create");

    const lines = JSON.parse(String(formData.get("lines") ?? "[]"));
    const method = String(formData.get("paymentMethod") ?? "COD");
    const shipping = Number(formData.get("shippingAmount") ?? 0);

    const discountPct = Number(formData.get("discountPct") ?? 0) / 100;
    // Taking an order and discounting it are separate rights: a moderator who
    // can do both can give the price away.
    const canDiscount = can(session.role, "sales_order:discount");
    if (discountPct > 0 && !canDiscount) {
      return { error: "You do not have permission to apply a discount." };
    }

    const priced = (lines as { variantId: string; quantity: number; retailPrice: number }[]).map(
      (l) => ({ ...l, discountPct }),
    );

    // The payment is the invoice, worked out the way the invoice works it out
    // — in decimals, not in floating point, which drops a piastre on some
    // prices and leaves the order a piastre short of paid.
    const due = ownedTotal(priced).plus(roundMoney(dec(shipping)));

    // One command: the price check reads the same prices the sale then uses,
    // and a second press after a lost response returns this order.
    const result = await formCommand("sales.moderatorOrder", formData, { userId: session.userId }, async () => {
      await checkOwnedPrices(priced, canDiscount);
      return createSale(
        {
          source: "MODERATOR",
          channelId: String(formData.get("channelId") ?? ""),
          entityId: String(formData.get("entityId") ?? ""),
          locationId: String(formData.get("locationId") ?? ""),
          customerId: (formData.get("customerId") as string) || null,
          orderDate: new Date(String(formData.get("orderDate") ?? "")),
          shippingAmount: shipping,
          city: (formData.get("city") as string) || null,
          notes: (formData.get("notes") as string) || null,
          lines: priced,
          payments: [
            {
              method: method as "CASH" | "CARD" | "COD" | "BANK_TRANSFER" | "INSTAPAY",
              amount: due.toNumber(),
              fee: Number(formData.get("fee") ?? 0),
              // Cash on delivery is money the courier still owes; anything else
              // taken up front is already in hand.
              collected: method !== "COD",
            },
          ],
        },
        { userId: session.userId },
      );
    });

    revalidatePath("/sales");
    revalidatePath("/inventory");
    revalidatePath("/customers");

    return {
      success:
        `${result.orderNumber} recorded for ${Number(result.netAmount).toFixed(2)} — ` +
        `margin ${Number(result.grossMargin).toFixed(2)}.` +
        (method === "COD" ? " Marked as collected on delivery, not yet received." : ""),
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
