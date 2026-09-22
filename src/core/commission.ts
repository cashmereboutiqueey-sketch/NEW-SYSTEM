import { Decimal, dec, roundMoney, type Numeric } from "@/lib/money";

/**
 * What a moderator earns on an order they entered.
 *
 * Two halves, added: a flat amount for every garment, and a share of what the
 * order actually came to. Either can be zero and usually one is — this shop
 * pays per piece — but a rate that can only be one of the two has to be
 * rebuilt the first time somebody is promised "ten pounds a piece and two per
 * cent", so both are here from the start.
 *
 * The share is taken on the net: after the discount, before shipping. Shipping
 * is the courier's money passing through, and paying commission on it would
 * mean a moderator earned more for sending a parcel further.
 *
 * Pure, because this is somebody's pay and an argument about it should be
 * settleable by running the numbers rather than reading a query.
 */

export type CommissionRate = {
  /** EGP per garment. */
  perPieceAmount: Numeric;
  /** A fraction of the net: 0.02 is two per cent. */
  percentOfNet: Numeric;
};

export type CommissionBasis = {
  /** Garments on the order. */
  pieces: number;
  /** The order's net, after discount and before shipping. */
  netAmount: Numeric;
};

/** The two halves separately, so a screen can show where the figure came from. */
export type CommissionBreakdown = {
  fromPieces: Decimal;
  fromPercent: Decimal;
  total: Decimal;
};

export function commissionBreakdown(
  rate: CommissionRate,
  basis: CommissionBasis,
): CommissionBreakdown {
  const fromPieces = roundMoney(dec(rate.perPieceAmount).times(basis.pieces));
  const fromPercent = roundMoney(dec(rate.percentOfNet).times(dec(basis.netAmount)));
  // Each half rounded before they are added, so the figure on the payslip is
  // the sum of the two figures printed beside it.
  return { fromPieces, fromPercent, total: fromPieces.plus(fromPercent) };
}

/** What the rate comes to on this order. */
export function commissionFor(rate: CommissionRate, basis: CommissionBasis): Decimal {
  return commissionBreakdown(rate, basis).total;
}

/**
 * What comes back when goods do.
 *
 * Worked out on what was returned rather than as a share of what was earned,
 * so a return of two pieces out of five takes back two pieces' worth — which
 * is what "ten pounds a piece" means when a piece comes back.
 *
 * Capped at what is left of the earning. A shop that discounts a return, or
 * returns more than the order held because somebody typed it twice, must not
 * end up with a moderator owing money they never earned.
 */
export function clawBackFor(
  rate: CommissionRate,
  returned: CommissionBasis,
  alreadyEarned: Numeric,
  alreadyClawedBack: Numeric = 0,
): Decimal {
  const owedBack = commissionFor(rate, returned);
  const remaining = dec(alreadyEarned).minus(dec(alreadyClawedBack));
  if (remaining.lessThanOrEqualTo(0)) return dec(0);
  return owedBack.greaterThan(remaining) ? remaining : owedBack;
}

/**
 * The rate in force on a given day.
 *
 * Effective-dated so raising somebody in March does not rewrite February. A
 * day before every rate has none — a moderator who started after an order was
 * collected did not earn on it.
 */
export function rateOn<T extends { effectiveFrom: Date; effectiveTo: Date | null }>(
  rates: T[],
  day: Date,
): T | null {
  const at = day.getTime();
  const live = rates.filter(
    (r) => r.effectiveFrom.getTime() <= at && (r.effectiveTo === null || r.effectiveTo.getTime() >= at),
  );
  if (live.length === 0) return null;
  // The latest start wins where two overlap, which is what a correction looks
  // like: the old row left open and a new one written over the top of it.
  return live.reduce((best, r) => (r.effectiveFrom > best.effectiveFrom ? r : best));
}
