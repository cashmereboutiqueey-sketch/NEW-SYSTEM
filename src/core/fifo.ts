import { Decimal, dec, sum, type Numeric } from "@/lib/money";

/**
 * FIFO lot consumption.
 *
 * Valuation is by lot, oldest first, and is deterministic: the same lots and
 * the same quantity always produce the same allocation and the same cost. The
 * current price of a material is never used to value stock that was bought
 * earlier — that is how a system starts reporting profit it did not make.
 */

export type Lot = {
  id: string;
  /** Aging clock. Ties are broken by `sequence` so the order is total. */
  receivedDate: Date;
  /** Insertion order, to disambiguate lots received on the same day. */
  sequence: number;
  remainingQty: Numeric;
  unitCost: Numeric;
};

export type Allocation = {
  lotId: string;
  quantity: Decimal;
  unitCost: Decimal;
  cost: Decimal;
};

export type ConsumeResult =
  | { ok: true; allocations: Allocation[]; totalCost: Decimal; totalQuantity: Decimal }
  | { ok: false; shortfall: Decimal; available: Decimal; requested: Decimal };

/** Oldest first; same-day receipts keep the order they were entered in. */
export function sortFifo(lots: Lot[]): Lot[] {
  return [...lots].sort((a, b) => {
    const byDate = a.receivedDate.getTime() - b.receivedDate.getTime();
    return byDate !== 0 ? byDate : a.sequence - b.sequence;
  });
}

/**
 * Allocates a quantity across lots, oldest first.
 *
 * Returns a shortfall rather than throwing or allocating what it can: a
 * partial issue would leave production thinking it had material it does not
 * have. The caller decides whether to buy, substitute or cut the run.
 */
export function consumeFifo(lots: Lot[], requested: Numeric): ConsumeResult {
  const want = dec(requested);

  if (want.lessThanOrEqualTo(0)) {
    return { ok: true, allocations: [], totalCost: dec(0), totalQuantity: dec(0) };
  }

  const available = sum(lots.map((l) => dec(l.remainingQty)));
  if (available.lessThan(want)) {
    return { ok: false, shortfall: want.minus(available), available, requested: want };
  }

  const allocations: Allocation[] = [];
  let outstanding = want;

  for (const lot of sortFifo(lots)) {
    if (outstanding.lessThanOrEqualTo(0)) break;

    const lotRemaining = dec(lot.remainingQty);
    if (lotRemaining.lessThanOrEqualTo(0)) continue;

    const take = Decimal.min(lotRemaining, outstanding);
    const unitCost = dec(lot.unitCost);

    allocations.push({
      lotId: lot.id,
      quantity: take,
      unitCost,
      cost: take.times(unitCost),
    });
    outstanding = outstanding.minus(take);
  }

  return {
    ok: true,
    allocations,
    totalCost: sum(allocations.map((a) => a.cost)),
    totalQuantity: sum(allocations.map((a) => a.quantity)),
  };
}

/** Book value of what is left: Σ remaining × unit cost. */
export function valuation(lots: Lot[]): Decimal {
  return sum(lots.map((l) => dec(l.remainingQty).times(dec(l.unitCost))));
}

/**
 * Weighted average unit cost of the remaining stock.
 *
 * Reporting only — consumption stays strictly FIFO. Null when there is no
 * stock, since an average of nothing is not zero.
 */
export function averageUnitCost(lots: Lot[]): Decimal | null {
  const qty = sum(lots.map((l) => dec(l.remainingQty)));
  if (qty.isZero()) return null;
  return valuation(lots).div(qty);
}

export type AgeBucket = "0-30" | "31-60" | "61-90" | "90+";

export const AGE_BUCKETS: AgeBucket[] = ["0-30", "31-60", "61-90", "90+"];

export function ageBucket(receivedDate: Date, asOf: Date): AgeBucket {
  const days = Math.floor((asOf.getTime() - receivedDate.getTime()) / 86_400_000);
  if (days <= 30) return "0-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

/**
 * Capital locked per age bucket — the dead-stock view.
 *
 * Stock is reported at what it cost, because that is the cash actually tied up
 * in it, whatever it might eventually sell for.
 */
export function agingProfile(
  lots: Lot[],
  asOf: Date,
): Record<AgeBucket, { quantity: Decimal; value: Decimal }> {
  const empty = () => ({ quantity: dec(0), value: dec(0) });
  const profile: Record<AgeBucket, { quantity: Decimal; value: Decimal }> = {
    "0-30": empty(), "31-60": empty(), "61-90": empty(), "90+": empty(),
  };

  for (const lot of lots) {
    const qty = dec(lot.remainingQty);
    if (qty.lessThanOrEqualTo(0)) continue;
    const bucket = profile[ageBucket(lot.receivedDate, asOf)];
    bucket.quantity = bucket.quantity.plus(qty);
    bucket.value = bucket.value.plus(qty.times(dec(lot.unitCost)));
  }

  return profile;
}
