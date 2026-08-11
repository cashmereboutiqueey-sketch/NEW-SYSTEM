"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { createSale, openPosSession, closePosSession, SalesError } from "@/lib/sales";
import { LedgerError } from "@/lib/ledger";
import { InventoryError } from "@/lib/inventory";
import { can } from "@/core/permissions";
import { findUnitBySerial } from "@/lib/garment-units";
import { db } from "@/lib/db";
import { sellConsignedItem, ConsignmentError } from "@/lib/consignment";
import { createCustomer } from "@/lib/master-data";
import { normalisePhone } from "@/core/crm";

export type PosState = {
  error?: string;
  success?: string;
  /** Echoed back so the terminal can show a receipt after a sale. */
  receipt?: { orderNumber: string; total: string; change: string };
};

/** Rounds the way the invoice does, so the split lands on the piastre. */
const round = (n: number) => Math.round(n * 100) / 100;

/** What is genuinely left of a consigned item, checked before anything moves. */
async function consignedAvailability(itemId: string) {
  const item = await db.consignmentItem.findUnique({
    where: { id: itemId },
    select: {
      description: true,
      quantityReceived: true,
      quantitySold: true,
      quantityReturned: true,
    },
  });
  if (!item) return { description: "الصنف", available: 0 };
  return {
    description: item.description,
    available: item.quantityReceived - item.quantitySold - item.quantityReturned,
  };
}

function toMessage(error: unknown): string {
  if (
    error instanceof SalesError ||
    error instanceof LedgerError ||
    error instanceof InventoryError
  ) {
    return error.message;
  }
  if (error instanceof ConsignmentError) return error.message;
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

/**
 * A consigned garment in the same basket.
 *
 * A customer buying two dresses of the shop and one of somebody else pays
 * once and walks out with three. To the cashier it is one sale; underneath it
 * has to be two documents, because almost nothing about the two halves is the
 * same — one relieves stock and earns the whole price, the other relieves
 * nothing and earns a commission.
 */
type ConsignedCartLine = {
  itemId: string;
  quantity: number;
  retailPrice: number;
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
    const consignedCart: ConsignedCartLine[] = JSON.parse(
      String(formData.get("consignedCart") ?? "[]"),
    );
    if (cart.length === 0 && consignedCart.length === 0) {
      return { error: "The cart is empty." };
    }

    // Discounting is a separate capability from ringing up a sale, so a
    // cashier cannot mark stock down on their own authority.
    const discounted = cart.some((l) => l.discountPct > 0);
    if (discounted && !can(session.role, "sales_order:discount")) {
      return { error: "You do not have permission to apply a discount." };
    }

    const method = String(formData.get("method") ?? "CASH") as
      | "CASH" | "CARD" | "WALLET" | "COD";
    const tendered = Number(formData.get("tendered") ?? 0);

    // How much is actually being handed over. Anything short of the total is
    // credit, and credit is a separate right from ringing up a sale: a cashier
    // may be trusted to take the full price and not to judge who is good for a
    // debt. Checked here as well as in the browser, because the browser is not
    // where permissions live.
    const total = Number(formData.get("total") ?? 0);
    const paidNow = Number(formData.get("paidNow") ?? total);

    if (paidNow < total && !can(session.role, "sales_order:credit")) {
      return { error: "You do not have permission to let a customer pay later." };
    }

    // The payment splits by ownership. Each document carries its own share, so
    // the drawer receives the whole basket across two journals and neither
    // side claims money belonging to the other.
    const consignedTotal = round(
      consignedCart.reduce((sum, l) => sum + l.retailPrice * l.quantity, 0),
    );
    const ownTotal = round(total - consignedTotal);

    // Goods belonging to somebody else cannot go out on credit. The shop owes
    // their owner a share from the moment they leave, and letting a customer
    // pay later means owing real money against a debt not yet collected.
    if (consignedCart.length > 0 && paidNow < total) {
      return {
        error:
          "بضاعة الأمانة لازم تتدفع كاملة — انت مدين لصاحبها من ساعة ما تخرج من المحل.",
      };
    }

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

    const posSessionId = String(formData.get("posSessionId") ?? "");
    const customerId = (formData.get("customerId") as string) || null;
    const now = new Date();

    // Every consigned line is checked for availability before anything is
    // recorded, so the common failure — the last one of something already
    // sold — is caught while the basket is still only a basket.
    for (const line of consignedCart) {
      const check = await consignedAvailability(line.itemId);
      if (line.quantity > check.available) {
        return {
          error:
            check.available <= 0
              ? `${check.description}: خلصت خلاص.`
              : `${check.description}: فاضل ${check.available} بس.`,
        };
      }
    }

    // The goods the shop owns go first. If a consigned line then fails, no
    // money has been misrecorded: that part of the basket simply was not rung
    // up, and the cashier is told which item to ring again. Neither document
    // is ever left half-written.
    let orderNumber: string | null = null;
    if (cart.length > 0) {
      const result = await createSale(
        {
          source,
          channelId: String(formData.get("channelId") ?? ""),
          entityId: String(formData.get("entityId") ?? ""),
          locationId,
          posSessionId,
          customerId,
          orderDate: now,
          lines: cart,
          payments:
            paidNow > 0
              ? [
                  {
                    method,
                    // Only the share belonging to the shop.
                    amount: Math.min(paidNow, ownTotal),
                    fee: 0,
                    // Cash and card at the till are collected there and then;
                    // a COD sale from the shop floor is not money in hand yet.
                    collected: method !== "COD",
                  },
                ]
              : [],
        },
        { userId: session.userId },
      );
      orderNumber = result.orderNumber;
    }

    const consignedSales: string[] = [];
    let commission = 0;
    for (const line of consignedCart) {
      const sale = await sellConsignedItem(
        {
          itemId: line.itemId,
          quantity: line.quantity,
          soldPrice: String(line.retailPrice),
          paymentMethod: method,
          customerId,
          posSessionId,
          saleDate: now,
        },
        { userId: session.userId, reason: null },
      );
      consignedSales.push(sale.saleNumber);
      commission += Number(sale.commission);
    }

    revalidatePath("/pos");
    revalidatePath("/consignment");

    const change = Math.max(0, tendered - total);
    const reference = orderNumber ?? consignedSales[0] ?? "";

    return {
      success:
        consignedSales.length > 0
          ? `${reference} — منها ${consignedSales.length} صنف أمانة، عمولتك ${commission.toFixed(2)}.`
          : `Sale ${reference} recorded.`,
      receipt: {
        orderNumber: reference,
        total: total.toFixed(2),
        change: change.toFixed(2),
      },
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export type QuickCustomerResult =
  | { ok: true; customer: { id: string; name: string; phone: string | null } }
  | {
      /** Somebody already has that number. The cashier decides who it is. */
      ok: false;
      match: { id: string; name: string; phone: string | null; code: string };
    }
  | { ok: false; message: string };

/**
 * Add a customer without leaving the till.
 *
 * A queue is exactly where duplicate customer records get made: the cashier
 * cannot leave the screen mid-sale to check, so they type the name again and
 * the person's history splits in two. So the phone is checked first — but the
 * match is offered rather than acted on. A shared family phone is common
 * enough that silently selecting the wrong sister is worse than asking, and
 * silently creating a second record is what we are trying to avoid.
 */
export async function quickAddCustomerAction(input: {
  name: string;
  phone: string;
  /** Where they walked in, so acquisition reporting means something. */
  source: "POS" | "EXHIBITION";
  /** Set once the cashier has seen the match and said it is somebody else. */
  createAnyway?: boolean;
}): Promise<QuickCustomerResult> {
  try {
    // Whoever can ring up a sale can name the person it belongs to.
    const session = await authorize("sales_order:create");

    const name = input.name.trim();
    if (!name) return { ok: false, message: "اكتب الاسم." };

    const phone = input.phone.trim();
    const normalised = normalisePhone(phone);

    if (normalised && !input.createAnyway) {
      const existing = await db.customer.findFirst({
        where: { phoneNormalised: normalised, mergedIntoId: null, isActive: true },
        select: { id: true, name: true, phone: true, code: true },
        orderBy: { createdAt: "asc" },
      });
      if (existing) return { ok: false, match: existing };
    }

    const { customer } = await createCustomer(
      {
        name,
        phone: phone || null,
        // A bazaar customer is not a showroom customer.
        acquiredVia: input.source,
      } as never,
      { userId: session.userId },
    );

    revalidatePath("/pos");
    revalidatePath("/customers");

    return {
      ok: true,
      customer: { id: customer.id, name: customer.name, phone: customer.phone },
    };
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return { ok: false, message: "You do not have permission to add a customer." };
    }
    console.error("Unhandled quick-add error:", error);
    return { ok: false, message: toMessage(error) };
  }
}
