import { Decimal, dec, safeDiv, type Numeric } from "@/lib/money";

/**
 * Cash conversion cycle and break-even.
 *
 * These are the two numbers that explain the gap between "profitable on
 * paper" and "no cash in hand", which is the daily reality this system was
 * built to make legible.
 */

export type CccInputs = {
  /** Days fabric sits in the store before it is cut. */
  rawMaterialDays: Numeric;
  productionLeadDays: Numeric;
  /** Days finished garments wait to be sold. */
  finishedGoodsDays: Numeric;
  /** Days between selling and the cash actually arriving. */
  collectionDays: Numeric;
  /** Days of credit suppliers grant, which funds part of the cycle. */
  supplierCreditDays: Numeric;
};

export type CccResult = {
  cashConversionDays: Decimal;
  workingCapitalLocked: Decimal;
  /** The part of the cycle suppliers are financing for you. */
  supplierFunded: Decimal;
};

/**
 * CCC = raw material + production + finished goods + collection − supplier credit
 *
 * Raw-material days are included by explicit decision: fabric sitting in the
 * store is locked capital, and it is precisely the period supplier credit is
 * meant to cover.
 */
export function cashConversionCycle(
  inputs: CccInputs,
  monthlyCogs: Numeric,
): CccResult {
  const days = dec(inputs.rawMaterialDays)
    .plus(dec(inputs.productionLeadDays))
    .plus(dec(inputs.finishedGoodsDays))
    .plus(dec(inputs.collectionDays))
    .minus(dec(inputs.supplierCreditDays));

  const dailyCogs = dec(monthlyCogs).div(30);

  return {
    cashConversionDays: days,
    // A negative cycle means suppliers fund the business outright, so there is
    // no capital locked to report.
    workingCapitalLocked: days.greaterThan(0) ? days.times(dailyCogs) : dec(0),
    supplierFunded: dec(inputs.supplierCreditDays).times(dailyCogs),
  };
}

export type UnitEconomics = {
  retailPrice: Numeric;
  discountRate: Numeric;
  returnRate: Numeric;
  transferPrice: Numeric;
  packaging: Numeric;
  shipping: Numeric;
  paymentFee: Numeric;
  marketingPerUnit: Numeric;
  returnHandlingCost: Numeric;
};

export type ContributionResult = {
  netPrice: Decimal;
  effectiveRevenue: Decimal;
  variableCost: Decimal;
  contributionMargin: Decimal;
  contributionMarginPct: Decimal | null;
};

export function contribution(u: UnitEconomics): ContributionResult {
  const netPrice = dec(u.retailPrice).times(dec(1).minus(dec(u.discountRate)));
  const effectiveRevenue = netPrice.times(dec(1).minus(dec(u.returnRate)));

  const variableCost = dec(u.transferPrice)
    .plus(dec(u.packaging))
    .plus(dec(u.shipping))
    .plus(dec(u.paymentFee))
    .plus(dec(u.marketingPerUnit))
    .plus(dec(u.returnHandlingCost));

  const contributionMargin = effectiveRevenue.minus(variableCost);

  return {
    netPrice,
    effectiveRevenue,
    variableCost,
    contributionMargin,
    contributionMarginPct: safeDiv(contributionMargin, effectiveRevenue),
  };
}

export type BreakEven =
  | {
      achievable: true;
      units: Decimal;
      revenue: Decimal;
      /** Share of the production run that must sell just to cover fixed costs. */
      shareOfRun: Decimal | null;
      highRisk: boolean;
    }
  | { achievable: false; reason: "NO_CONTRIBUTION" };

/**
 * Break-even in units and as a share of the run.
 *
 * When contribution is zero or negative the answer is that the style never
 * breaks even — not a very large number. Printing 8,000,000 units invites
 * someone to believe the target is merely ambitious.
 *
 * `allocatedFixedCosts` must be Brand-only fixed costs. Factory overhead is
 * already absorbed into the transfer price inside `variableCost`, so counting
 * it again here would charge it twice.
 */
export function breakEven(
  contributionMargin: Numeric,
  allocatedFixedCosts: Numeric,
  productionRunQty?: Numeric,
  highRiskThreshold: Numeric = "0.6",
): BreakEven {
  const cm = dec(contributionMargin);
  if (cm.lessThanOrEqualTo(0)) return { achievable: false, reason: "NO_CONTRIBUTION" };

  const units = dec(allocatedFixedCosts).div(cm);
  const shareOfRun = productionRunQty ? safeDiv(units, productionRunQty) : null;

  return {
    achievable: true,
    units,
    revenue: units.times(cm),
    shareOfRun,
    highRisk: shareOfRun ? shareOfRun.greaterThan(dec(highRiskThreshold)) : false,
  };
}

/**
 * Gross margin return on inventory investment.
 *
 * Answers what each pound tied up in stock earns. Null when there is no
 * inventory, because dividing by an empty warehouse means nothing.
 */
export function gmroi(grossMargin: Numeric, averageInventoryCost: Numeric): Decimal | null {
  return safeDiv(dec(grossMargin), dec(averageInventoryCost));
}

/** Share of a production run that has actually sold. */
export function sellThrough(unitsSold: Numeric, unitsProduced: Numeric): Decimal | null {
  return safeDiv(dec(unitsSold), dec(unitsProduced));
}
