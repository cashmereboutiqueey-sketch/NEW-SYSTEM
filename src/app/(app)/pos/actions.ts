"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { createSale, openPosSession, closePosSession, SalesError } from "@/lib/sales";
import { LedgerError } from "@/lib/ledger";
import { InventoryError } from "@/lib/inventory";
import { can, type Role } from "@/core/permissions";
import { findUnitBySerial } from "@/lib/garment-units";
import { db } from "@/lib/db";
import { sellConsignedItem, ConsignmentError } from "@/lib/consignment";
import { createCustomer } from "@/lib/master-data";
import { formCommand, CommandError } from "@/lib/command";
import { dec, Decimal } from "@/lib/money";
import {
  checkOwnedPrices,
  checkConsignedPrices,
  ownedTotal,
  consignedTotal,
  SalePriceError,
} from "@/lib/sale-prices";
import { normalisePhone } from "@/core/crm";

export type PosState = {
  error?: string;
  success?: string;
  /** Echoed back so the terminal can show a receipt after a sale. */
  receipt?: {
    orderNumber: string;
    total: string;
    change: string;
    /** The sale itself, so the till can offer to print it. */
    salesOrderId?: string;
  };
};

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
  if (
    error instanceof ConsignmentError ||
    error instanceof CheckoutError ||
    error instanceof SalePriceError ||
    error instanceof CommandError
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

/** A basket the till refuses, with the reason the cashier is shown. */
class CheckoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutError";
  }
}

/**
 * The till this sale is rung up on, and whether this person may use it.
 *
 * A till is one cashier at one location for one shift: its drawer count at
 * the end is only meaningful if every sale in it was theirs, taken there. A
 * supervisor — anybody who may close a shift — can ring up on a colleague's
 * till, which is how cover for a break works.
 */
async function checkTill(
  posSessionId: string,
  locationId: string,
  session: { userId: string; role: Role },
): Promise<void> {
  const till = await db.posSession.findUnique({
    where: { id: posSessionId },
    select: { locationId: true, cashierUserId: true, closedAt: true },
  });
  if (!till) throw new CheckoutError("Open a till before ringing up a sale.");
  if (till.closedAt) throw new CheckoutError("That till is already closed. Open a new one.");
  if (till.locationId !== locationId) {
    throw new CheckoutError("That till is at another location from this sale.");
  }
  if (till.cashierUserId !== session.userId && !can(session.role, "pos:close_shift")) {
    // Not "open your own": one drawer takes one shift, so that is the one
    // thing this person cannot do. What unblocks it is the drawer being
    // counted and closed by somebody who may.
    throw new CheckoutError(
      "That till is open in another cashier's name. It has to be counted and closed before you can sell.",
    );
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
    const canDiscount = can(session.role, "sales_order:discount");
    if (cart.some((l) => l.discountPct > 0) && !canDiscount) {
      return { error: "You do not have permission to apply a discount." };
    }

    const method = String(formData.get("method") ?? "CASH") as
      | "CASH" | "CARD" | "INSTAPAY" | "COD";
    if (!["CASH", "CARD", "INSTAPAY", "COD"].includes(method)) {
      throw new CheckoutError("Choose a supported till payment method.");
    }
    const tendered = Number(formData.get("tendered") ?? 0);

    // The total is worked out here, the way the invoice will work it out,
    // rather than taken from the browser. A total typed down to 1 alongside
    // "paid 1" used to read as paid in full while the sale recorded the real
    // price, and the difference went on the customer's account without anyone
    // allowed to give credit having agreed to it.
    const ownTotal = ownedTotal(cart);
    const total = ownTotal.plus(consignedTotal(consignedCart));

    // How much is actually being handed over. Anything short of the total is
    // credit, and credit is a separate right from ringing up a sale: a cashier
    // may be trusted to take the full price and not to judge who is good for a
    // debt.
    const paidRaw = formData.get("paidNow");
    const paidNow = paidRaw == null || paidRaw === "" ? total : dec(Number(paidRaw));
    if (!paidNow.isFinite() || paidNow.isNegative()) {
      return { error: "The amount paid is not a number." };
    }
    if (paidNow.lessThan(total) && !can(session.role, "sales_order:credit")) {
      return { error: "You do not have permission to let a customer pay later." };
    }

    // Goods belonging to somebody else used to be refused on credit outright.
    // By instruction they are allowed, and the reason for the old rule has not
    // gone anywhere: the shop owes their owner a share from the moment they
    // leave, so a customer who pays later leaves the shop owing real money
    // against a debt not yet collected. The till says so on the screen before
    // the sale, which is where a warning is worth something; refusing it here
    // was deciding for the owner what risk the shop may take.

    const locationId = String(formData.get("locationId") ?? "");
    const posSessionId = String(formData.get("posSessionId") ?? "");
    const customerId = (formData.get("customerId") as string) || null;
    const now = new Date();

    // One basket, one transaction. The shop's goods and a consignor's go on
    // two documents, but the customer paid once: either both are recorded or
    // neither is, so a failure on the consigned line can no longer leave the
    // shop's half sold and the cashier guessing what to ring again. A second
    // press with the same submission — the response lost on the way back —
    // returns this sale rather than making another.
    const result = await formCommand(
      "pos.checkout",
      formData,
      { userId: session.userId },
      async () => {
        await checkTill(posSessionId, locationId, session);
        await checkOwnedPrices(cart, canDiscount);
        await checkConsignedPrices(consignedCart, canDiscount);

        // A sale rung up at a bazaar is a bazaar sale, not a showroom one. The
        // till is the same till, so the source has to come from where it is
        // standing — otherwise every bazaar's takings land in the showroom's
        // revenue account and no channel report can tell them apart.
        const location = await db.location.findUnique({
          where: { id: locationId },
          select: { kind: true },
        });
        const source = location?.kind === "EXHIBITION" ? "EXHIBITION" : "POS";

        // The last one of a consigned item is the common failure, and it gets
        // its own message in the cashier's words.
        for (const line of consignedCart) {
          const check = await consignedAvailability(line.itemId);
          if (line.quantity > check.available) {
            throw new CheckoutError(
              check.available <= 0
                ? `${check.description}: خلصت خلاص.`
                : `${check.description}: فاضل ${check.available} بس.`,
            );
          }
        }

        let orderNumber: string | null = null;
        let salesOrderId: string | null = null;
        if (cart.length > 0) {
          const sale = await createSale(
            {
              source,
              channelId: String(formData.get("channelId") ?? ""),
              entityId: String(formData.get("entityId") ?? ""),
              locationId,
              posSessionId,
              customerId,
              orderDate: now,
              lines: cart,
              payments: paidNow.greaterThan(0)
                ? [
                    {
                      method,
                      // Only the share belonging to the shop.
                      amount: Decimal.min(paidNow, ownTotal).toNumber(),
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
          orderNumber = sale.orderNumber;
          salesOrderId = sale.salesOrderId;
        }

        const consignedSales: string[] = [];
        let commission = dec(0);
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
          commission = commission.plus(sale.commission);
        }

        return { orderNumber, salesOrderId, consignedSales, commission: commission.toFixed(2) };
      },
    );

    revalidatePath("/pos");
    revalidatePath("/consignment");

    const change = Decimal.max(0, dec(Number.isFinite(tendered) ? tendered : 0).minus(total));
    const reference = result.orderNumber ?? result.consignedSales[0] ?? "";

    return {
      success:
        result.consignedSales.length > 0
          ? `${reference} — منها ${result.consignedSales.length} صنف أمانة، عمولتك ${result.commission}.`
          : `Sale ${reference} recorded.`,
      receipt: {
        orderNumber: reference,
        // Absent for a basket of nothing but consigned goods: those are the
        // owner's sales, not the shop's, and have no receipt of this kind.
        salesOrderId: result.salesOrderId ?? undefined,
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
