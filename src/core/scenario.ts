import { Decimal, dec, safeDiv, type Numeric } from "@/lib/money";

/**
 * What-if, on one month's real figures.
 *
 * Every assumption is a change to something the business actually controls or
 * suffers: the price of cloth, the wage bill, how full the factory is, how
 * much gets discounted, how much comes back. The baseline is measured; only
 * the deltas are hypothetical.
 *
 * Pure, so the arithmetic can be tested without a database and so a scenario
 * gives the same answer twice.
 */

export type Baseline = {
  /** Factory conversion cost for the month, before any change. */
  conversionCost: Numeric;
  materialCost: Numeric;
  grossAvailableMinutes: Numeric;
  utilisationRate: Numeric;
  efficiencyRate: Numeric;
  /** Standard minutes in one garment. */
  smvPerUnit: Numeric;
  unitsSold: Numeric;
  retailPrice: Numeric;
  discountRate: Numeric;
  returnRate: Numeric;
  factoryMarginPct: Numeric;
  brandFixedCosts: Numeric;
  marketingSpend: Numeric;
  variableSellingCostPerUnit: Numeric;
};

export type Assumptions = {
  /** Cloth got dearer or cheaper, as a fraction. 0.10 is ten percent up. */
  fabricPriceDeltaPct?: Numeric;
  wageDeltaPct?: Numeric;
  marketingDeltaPct?: Numeric;
  /** Absolute replacements, not deltas — these are targets, not drifts. */
  utilisationRate?: Numeric;
  efficiencyRate?: Numeric;
  discountRate?: Numeric;
  returnRate?: Numeric;
  retailPriceDeltaPct?: Numeric;
  unitsSoldDeltaPct?: Numeric;
};

export type Outcome = {
  minuteRate: Decimal;
  fullCapacityMinuteRate: Decimal;
  idlePenaltyPerMinute: Decimal;
  materialCostPerUnit: Decimal;
  cmtCostPerUnit: Decimal;
  factoryCostPerUnit: Decimal;
  transferPrice: Decimal;
  netPrice: Decimal;
  effectiveRevenue: Decimal;
  contributionPerUnit: Decimal;
  unitsSold: Decimal;
  totalContribution: Decimal;
  brandProfit: Decimal;
  factoryProfit: Decimal;
  groupProfit: Decimal;
  breakEvenUnits: Decimal | null;
};

const one = dec(1);

function applyDelta(base: Numeric, delta: Numeric | undefined): Decimal {
  return dec(base).times(one.plus(dec(delta ?? 0)));
}

function pick(override: Numeric | undefined, fallback: Numeric): Decimal {
  return override == null ? dec(fallback) : dec(override);
}

/** Runs one set of assumptions over a measured month. */
export function simulate(baseline: Baseline, assumptions: Assumptions = {}): Outcome {
  const utilisation = pick(assumptions.utilisationRate, baseline.utilisationRate);
  const efficiency = pick(assumptions.efficiencyRate, baseline.efficiencyRate);

  // Wages move the conversion pool; cloth moves material cost. They are
  // separate levers because they have separate cures.
  const conversionCost = applyDelta(baseline.conversionCost, assumptions.wageDeltaPct);
  const materialCost = applyDelta(baseline.materialCost, assumptions.fabricPriceDeltaPct);

  const gross = dec(baseline.grossAvailableMinutes);
  const productive = gross.times(utilisation).times(efficiency);

  // A factory with no productive minutes has no rate, not an infinite one.
  const minuteRate = productive.isZero() ? dec(0) : conversionCost.div(productive);
  const fullCapacityRate = gross.isZero() ? dec(0) : conversionCost.div(gross);

  const unitsSold = applyDelta(baseline.unitsSold, assumptions.unitsSoldDeltaPct);

  // Material cost per garment comes from the month it was measured in, so a
  // change in volume does not make cloth cheaper per piece. Only the fabric
  // price assumption moves it.
  const baseUnits = dec(baseline.unitsSold);
  const materialPerUnit = baseUnits.isZero() ? dec(0) : materialCost.div(baseUnits);

  const cmtPerUnit = minuteRate.times(dec(baseline.smvPerUnit));
  const factoryCostPerUnit = materialPerUnit.plus(cmtPerUnit);
  const transferPrice = factoryCostPerUnit.times(one.plus(dec(baseline.factoryMarginPct)));

  const retailPrice = applyDelta(baseline.retailPrice, assumptions.retailPriceDeltaPct);
  const discount = pick(assumptions.discountRate, baseline.discountRate);
  const returns = pick(assumptions.returnRate, baseline.returnRate);

  const netPrice = retailPrice.times(one.minus(discount));
  const effectiveRevenue = netPrice.times(one.minus(returns));

  const variableCost = transferPrice.plus(dec(baseline.variableSellingCostPerUnit));
  const contributionPerUnit = effectiveRevenue.minus(variableCost);
  const totalContribution = contributionPerUnit.times(unitsSold);

  const marketing = applyDelta(baseline.marketingSpend, assumptions.marketingDeltaPct);
  const brandFixed = dec(baseline.brandFixedCosts);
  const brandProfit = totalContribution.minus(brandFixed).minus(marketing);

  // The factory earns its margin on what it transfers.
  const factoryProfit = transferPrice.minus(factoryCostPerUnit).times(unitsSold);

  // The two do add up, and it is worth seeing why rather than trusting it.
  // The Brand pays the transfer price; the Factory earns it less its own cost.
  // Adding them cancels the transfer price on both sides and leaves external
  // revenue less what the garments really cost to make, less Brand overhead —
  // which is the group result.
  //
  // This holds because the model transfers exactly what it sells. A month that
  // builds stock would leave margin sitting in inventory, and that is the
  // unrealised profit the consolidation report eliminates; a single-month
  // simulation has nowhere to put it.
  const groupProfit = brandProfit.plus(factoryProfit);

  return {
    minuteRate,
    fullCapacityMinuteRate: fullCapacityRate,
    idlePenaltyPerMinute: minuteRate.minus(fullCapacityRate),
    materialCostPerUnit: materialPerUnit,
    cmtCostPerUnit: cmtPerUnit,
    factoryCostPerUnit,
    transferPrice,
    netPrice,
    effectiveRevenue,
    contributionPerUnit,
    unitsSold,
    totalContribution,
    brandProfit,
    factoryProfit,
    groupProfit,
    breakEvenUnits: contributionPerUnit.greaterThan(0)
      ? brandFixed.plus(marketing).div(contributionPerUnit)
      : null,
  };
}

export type Comparison = {
  metricKey: string;
  labelEn: string;
  labelAr: string;
  baseline: Decimal;
  simulated: Decimal;
  delta: Decimal;
  deltaPct: Decimal | null;
  unit: "EGP" | "PCT" | "MIN" | "UNITS" | "RATE";
};

const METRICS: {
  key: keyof Outcome;
  labelEn: string;
  labelAr: string;
  unit: Comparison["unit"];
}[] = [
  { key: "minuteRate", labelEn: "Minute rate", labelAr: "تكلفة الدقيقة", unit: "RATE" },
  { key: "idlePenaltyPerMinute", labelEn: "Idle penalty per minute", labelAr: "عبء الدقيقة العاطلة", unit: "RATE" },
  { key: "factoryCostPerUnit", labelEn: "Factory cost per garment", labelAr: "تكلفة المصنع للقطعة", unit: "EGP" },
  { key: "transferPrice", labelEn: "Transfer price", labelAr: "سعر التحويل", unit: "EGP" },
  { key: "netPrice", labelEn: "Net price after discount", labelAr: "السعر بعد الخصم", unit: "EGP" },
  { key: "contributionPerUnit", labelEn: "Contribution per garment", labelAr: "هامش المساهمة للقطعة", unit: "EGP" },
  { key: "unitsSold", labelEn: "Units sold", labelAr: "القطع المباعة", unit: "UNITS" },
  { key: "totalContribution", labelEn: "Total contribution", labelAr: "إجمالي المساهمة", unit: "EGP" },
  { key: "brandProfit", labelEn: "Brand profit", labelAr: "ربح البراند", unit: "EGP" },
  { key: "factoryProfit", labelEn: "Factory margin on transfers", labelAr: "هامش المصنع على التحويلات", unit: "EGP" },
  { key: "groupProfit", labelEn: "Group profit", labelAr: "ربح المجموعة", unit: "EGP" },
  { key: "breakEvenUnits", labelEn: "Break-even units", labelAr: "وحدات التعادل", unit: "UNITS" },
];

/** Lines up a run against its baseline, metric by metric. */
export function compare(before: Outcome, after: Outcome): Comparison[] {
  return METRICS.map(({ key, labelEn, labelAr, unit }, i) => {
    const baseline = before[key] ?? dec(0);
    const simulated = after[key] ?? dec(0);
    const b = dec(baseline as Numeric);
    const s = dec(simulated as Numeric);
    const delta = s.minus(b);

    return {
      metricKey: String(key),
      labelEn,
      labelAr,
      baseline: b,
      simulated: s,
      delta,
      // Null rather than infinity when the baseline is zero: a change from
      // nothing to something has no percentage.
      deltaPct: safeDiv(delta, b),
      unit,
      sortOrder: i,
    };
  });
}
