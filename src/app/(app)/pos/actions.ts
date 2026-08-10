"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { createSale, openPosSession, closePosSession, SalesError } from "@/lib/sales";
import { LedgerError } from "@/lib/ledger";
import { InventoryError } from "@/lib/inventory";
import { can } from "@/core/permissions";
import { findUnitBySerial } from "@/lib/garment-units";
import { db } from "@/lib/db";

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

type CartLine = {
  variantId: string;
  quantity: number;
  retailPrice: number;
  discountPct: number;
  /** Tags the cashier scanned for this line, if they scanned rather than tapped. */
  scannedSerials?: string[];
};

export type ScanResult =
  | { ok: true; variantId: string; serial: string; label: string; retailPrice: string | null }
  | { ok: false; message: string };

/**
 * Resolves a tag the cashier just scanned.
 *
 * The garment has to be in stock at *this* till's location. One that is still
 * at the factory, already sold, or sitting in the other branch is a real
 * situation with a real answer, and saying which is far more use to the person
 * at the counter than "not found".
 */
export async function lookupSerialAction(
  serial: string,
  locationId: string,
): Promise<ScanResult> {
  try {
    await authorize("pos:operate");

    const found = await findUnitBySerial(serial);
    if (!found.ok) {
      return {
        ok: false,
        message:
          found.reason === "MALFORMED"
            ? "That scan came through garbled. Scan it again."
            : "No garment carries that code.",
      };
    }

    const unit = found.unit;
    const label = `${unit.styleEn} · ${unit.colourEn} · ${unit.size}`;

    if (unit.status === "SOLD") {
      const when = unit.soldAt?.toISOString().slice(0, 10) ?? "earlier";
      return { ok: false, message: `${label} was already sold on ${when}.` };
    }
    if (unit.status === "LOST") {
      return { ok: false, message: `${label} is written off as lost.` };
    }
    if (unit.status !== "IN_STOCK") {
      return {
        ok: false,
        message: `${label} has not been received onto the floor yet.`,
      };
    }
    if (unit.locationId !== locationId) {
      return {
        ok: false,
        message: `${label} belongs to ${unit.locationEn ?? "another location"}, not this till.`,
      };
    }

    return {
      ok: true,
      variantId: unit.variantId,
      serial: unit.serial,
      label,
      retailPrice: unit.retailPrice,
    };
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return { ok: false, message: "You do not have permission to do that." };
    }
    console.error("Unhandled scan error:", error);
    return { ok: false, message: "Something went wrong reading that code." };
  }
}

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

    // A sale rung up at a bazaar is a bazaar sale, not a showroom one. The
    // till is the same till, so the source has to come from where it is
    // standing — otherwise every bazaar's takings land in the showroom's
    // revenue account and no channel report can tell them apart.
    const locationId = String(formData.get("locationId") ?? "");
    const location = await db.location.findUnique({
      where: { id: locationId },
      select: { kind: true },
    });
    const source = location?.kind === "EXHIBITION" ? "EXHIBITION" : "POS";

    const result = await createSale(
      {
        source,
        channelId: String(formData.get("channelId") ?? ""),
        entityId: String(formData.get("entityId") ?? ""),
        locationId,
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
