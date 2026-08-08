import { Decimal, dec, sum, type Numeric } from "@/lib/money";

/**
 * Group consolidation.
 *
 * Adding the Factory's and the Brand's results together double-counts the
 * internal sale: the Factory books revenue the Brand books as cost, and
 * neither is money from outside the group. Two eliminations fix that.
 *
 *   1. Intercompany revenue and the matching cost cancel.
 *   2. Factory margin still sitting inside unsold Brand stock is removed,
 *      because the group has not earned it until the goods leave the group.
 *
 * Without the second elimination the group looks more profitable simply for
 * producing into stock, which is precisely the illusion this system exists to
 * remove.
 */

export type EntityResult = {
  /** Revenue from customers outside the group. */
  externalRevenue: Numeric;
  /** Revenue from the other group entity. Eliminated in full. */
  intercompanyRevenue: Numeric;
  /** Cost of goods bought from the other group entity. Eliminated in full. */
  intercompanyCogs: Numeric;
  /** Cost of goods sold to outside customers. */
  externalCogs: Numeric;
  operatingExpenses: Numeric;
};

export type UnrealisedProfit = {
  /** Factory margin embedded in Brand stock at the start of the period. */
  opening: Numeric;
  /** Factory margin embedded in Brand stock at the end of the period. */
  closing: Numeric;
};

export type ConsolidatedResult = {
  factoryProfit: Decimal;
  brandProfit: Decimal;
  /** Simple sum, before any elimination. Shown so the workings are visible. */
  combinedProfit: Decimal;

  intercompanyRevenueEliminated: Decimal;
  intercompanyCogsEliminated: Decimal;
  /** Movement in unrealised profit. Positive means stock grew this period. */
  unrealisedProfitMovement: Decimal;

  groupExternalRevenue: Decimal;
  groupCogs: Decimal;
  groupOperatingExpenses: Decimal;
  groupProfit: Decimal;
};

function entityProfit(r: EntityResult): Decimal {
  return dec(r.externalRevenue)
    .plus(dec(r.intercompanyRevenue))
    .minus(dec(r.externalCogs))
    .minus(dec(r.intercompanyCogs))
    .minus(dec(r.operatingExpenses));
}

export function consolidate(
  factory: EntityResult,
  brand: EntityResult,
  unrealised: UnrealisedProfit,
): ConsolidatedResult {
  const factoryProfit = entityProfit(factory);
  const brandProfit = entityProfit(brand);
  const combinedProfit = factoryProfit.plus(brandProfit);

  // Both sides of the internal sale disappear. They should be equal; where
  // they are not, the difference is goods still in transit between the books
  // and belongs in the reconciliation queue rather than being smoothed over.
  const intercompanyRevenueEliminated = dec(factory.intercompanyRevenue).plus(
    dec(brand.intercompanyRevenue),
  );
  const intercompanyCogsEliminated = dec(factory.intercompanyCogs).plus(
    dec(brand.intercompanyCogs),
  );

  // Only the *movement* hits this period's profit. Margin already deferred at
  // the start was removed from a previous period and is released as those
  // goods sell.
  const unrealisedProfitMovement = dec(unrealised.closing).minus(dec(unrealised.opening));

  const groupExternalRevenue = dec(factory.externalRevenue).plus(dec(brand.externalRevenue));
  const groupOperatingExpenses = dec(factory.operatingExpenses).plus(
    dec(brand.operatingExpenses),
  );

  // Only the unrealised margin adjusts profit.
  //
  // It is tempting to also subtract the intercompany revenue and add back the
  // intercompany cost, but that double-counts: within the combined figure the
  // Factory's internal revenue is already offset by its own cost of making the
  // goods, and the Brand capitalised the rest into stock. What survives that
  // offset is exactly the margin on units the Brand has not yet sold — which
  // is what `unrealisedProfitMovement` removes.
  //
  // The two elimination figures below are therefore presentational: they
  // restate the revenue and cost lines, not the bottom line.
  const groupProfit = combinedProfit.minus(unrealisedProfitMovement);

  const combinedCogs = dec(factory.externalCogs)
    .plus(dec(factory.intercompanyCogs))
    .plus(dec(brand.externalCogs))
    .plus(dec(brand.intercompanyCogs));

  // Removing the internal invoice leaves the Factory's own cost of production;
  // adding back the deferred margin strips out the portion belonging to goods
  // still sitting in Brand stock.
  const groupCogs = combinedCogs
    .minus(intercompanyRevenueEliminated)
    .plus(unrealisedProfitMovement);

  return {
    factoryProfit,
    brandProfit,
    combinedProfit,
    intercompanyRevenueEliminated,
    intercompanyCogsEliminated,
    unrealisedProfitMovement,
    groupExternalRevenue,
    groupCogs,
    groupOperatingExpenses,
    groupProfit,
  };
}

export type BrandStockLot = {
  remainingQty: Numeric;
  /** Factory margin per unit baked into this lot's cost. */
  transferMarginPerUnit: Numeric | null;
};

/**
 * Factory profit still sitting inside unsold Brand stock.
 *
 * Lots with no recorded transfer margin contribute nothing: stock the Brand
 * bought from an outside supplier carries no internal margin to remove.
 */
export function unrealisedProfitInStock(lots: BrandStockLot[]): Decimal {
  return sum(
    lots.map((l) =>
      l.transferMarginPerUnit == null
        ? dec(0)
        : dec(l.remainingQty).times(dec(l.transferMarginPerUnit)),
    ),
  );
}

/**
 * Checks that the two sides of the intercompany account agree.
 *
 * A mismatch is a real condition — an invoice raised but not yet received —
 * and must surface as an exception rather than be forced to zero.
 */
export function intercompanyReconciliation(
  factoryReceivable: Numeric,
  brandPayable: Numeric,
): { matched: boolean; difference: Decimal } {
  const difference = dec(factoryReceivable).minus(dec(brandPayable));
  return { matched: difference.isZero(), difference };
}
