import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { dec, type Numeric } from "./money";

/**
 * Cash through a till's drawer.
 *
 * Every service that puts cash into the POS drawer account, or takes it out,
 * records the movement here against the till it went through, so a till's
 * expected cash at close is simply its opening float plus these. Anything
 * reconstructed after the fact from the documents a till happens to be linked
 * to misses the ones it is not: a consignor's garment, a refund, a deposit.
 *
 * The till is the one named, when the caller knows it (a sale rung up on it),
 * or else the till open at the location where the cash changed hands. With no
 * till open there, the cash still posts to the drawer account but belongs to
 * no till's count — which is the honest answer for money taken while no drawer
 * was open, and it surfaces as a difference rather than vanishing into one.
 */

export class TillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TillError";
  }
}

export type TillCashKind =
  | "SALE"
  | "CONSIGNMENT_SALE"
  | "REFUND"
  | "DEPOSIT"
  | "COLLECTION"
  | "PAYOUT";

export async function recordTillCash(
  tx: Prisma.TransactionClient,
  event: {
    posSessionId?: string | null;
    locationId?: string | null;
    kind: TillCashKind;
    /** Positive into the drawer, negative out of it. */
    amount: Numeric;
    reference: string;
    occurredAt?: Date;
  },
): Promise<string | null> {
  const amount = dec(event.amount);
  if (amount.isZero()) return null;

  let posSessionId: string | null = null;
  if (event.posSessionId) {
    const till = await tx.posSession.findUnique({
      where: { id: event.posSessionId },
      select: { id: true, closedAt: true },
    });
    if (!till) throw new TillError("Till session not found.");
    if (till.closedAt) throw new TillError("That till session is already closed.");
    posSessionId = till.id;
  } else if (event.locationId) {
    const open = await tx.posSession.findFirst({
      where: { locationId: event.locationId, closedAt: null },
      select: { id: true },
    });
    posSessionId = open?.id ?? null;
  }
  if (!posSessionId) return null;

  await tx.tillCashEvent.create({
    data: {
      posSessionId,
      kind: event.kind,
      amount: amount.toString(),
      reference: event.reference,
      occurredAt: event.occurredAt ?? new Date(),
    },
  });
  return posSessionId;
}
