import { Decimal, dec, safeDiv, type Numeric } from "@/lib/money";

/**
 * Production planning and variance.
 *
 * The point of holding planned and actual side by side is to answer *why* an
 * order cost what it did, not merely what it cost. A single "actual cost"
 * figure tells you the run was expensive; splitting it into fabric and minutes
 * tells you whether that was the cutting table or the sewing line.
 */

export type PlannedRequirement = {
  materialId: string;
  materialCode: string;
  /** Per garment at base size, before waste. */
  standardConsumption: Decimal;
  wasteRate: Decimal;
  /** What the store should issue for the whole run. */
  requiredQty: Decimal;
};

/**
 * Explodes a BOM across a run.
 *
 * Waste is included because the store issues cloth, not the theoretical
 * minimum — planning to the standard consumption guarantees a shortage
 * partway through every cut.
 */
export function explodeBom(
  bomLines: {
    materialId: string;
    materialCode: string;
    standardConsumption: Numeric;
    wasteRateOverride?: Numeric | null;
  }[],
  plannedQty: Numeric,
  styleWasteRate: Numeric,
  sizeFactor: Numeric = 1,
): PlannedRequirement[] {
  const qty = dec(plannedQty);
  const styleWaste = dec(styleWasteRate);

  return bomLines.map((l) => {
    const wasteRate = l.wasteRateOverride != null ? dec(l.wasteRateOverride) : styleWaste;
    const standardConsumption = dec(l.standardConsumption);
    return {
      materialId: l.materialId,
      materialCode: l.materialCode,
      standardConsumption,
      wasteRate,
      requiredQty: standardConsumption
        .times(dec(sizeFactor))
        .times(wasteRate.plus(1))
        .times(qty),
    };
  });
}

export type Variance = {
  planned: Decimal;
  actual: Decimal;
  /** actual − planned. Positive means it cost more than planned. */
  variance: Decimal;
  /** Null when planned is zero — a percentage of nothing is meaningless. */
  variancePct: Decimal | null;
  favourable: boolean;
};

export function variance(planned: Numeric, actual: Numeric): Variance {
  const p = dec(planned);
  const a = dec(actual);
  const diff = a.minus(p);
  return {
    planned: p,
    actual: a,
    variance: diff,
    variancePct: safeDiv(diff, p),
    // Using less material or fewer minutes than planned is the good direction.
    favourable: diff.lessThanOrEqualTo(0),
  };
}

/**
 * Actual waste implied by what was really issued.
 *
 *   actual_waste_rate = (actual issued / standard required) − 1
 *
 * `standardRequired` is the waste-free quantity, so the result is comparable
 * with the style's planned waste rate. Null when nothing was required.
 */
export function actualWasteRate(
  actualIssued: Numeric,
  standardRequired: Numeric,
): Decimal | null {
  const ratio = safeDiv(dec(actualIssued), dec(standardRequired));
  return ratio ? ratio.minus(1) : null;
}

/**
 * Whether measured waste has drifted far enough above plan to flag the style.
 *
 * Costing keeps using the planned rate — historical snapshots are never
 * rewritten. This only drives the variance report and the alert.
 */
export function wasteDriftExceeded(
  actual: Numeric,
  planned: Numeric,
  thresholdPct: Numeric,
): boolean {
  return dec(actual).minus(dec(planned)).greaterThan(dec(thresholdPct));
}

export type OrderYield = {
  goodQty: Decimal;
  rejectedQty: Decimal;
  reworkQty: Decimal;
  totalOutput: Decimal;
  /** Good units over everything that came off the line. Null if nothing did. */
  yieldRate: Decimal | null;
  defectRate: Decimal | null;
};

export function orderYield(input: {
  goodQty: Numeric;
  rejectedQty?: Numeric;
  reworkQty?: Numeric;
}): OrderYield {
  const good = dec(input.goodQty);
  const rejected = dec(input.rejectedQty ?? 0);
  const rework = dec(input.reworkQty ?? 0);
  const total = good.plus(rejected).plus(rework);

  return {
    goodQty: good,
    rejectedQty: rejected,
    reworkQty: rework,
    totalOutput: total,
    yieldRate: safeDiv(good, total),
    defectRate: safeDiv(rejected.plus(rework), total),
  };
}

/**
 * Line efficiency: earned standard minutes over minutes actually clocked.
 *
 * Deliberately separate from utilisation, which measures whether the line had
 * work at all. A line can be 100% efficient and still idle half the month.
 */
export function lineEfficiency(
  earnedMinutes: Numeric,
  clockedMinutes: Numeric,
): Decimal | null {
  return safeDiv(dec(earnedMinutes), dec(clockedMinutes));
}

/** Standard minutes genuinely earned by good output. */
export function earnedMinutes(goodQty: Numeric, smvPerUnit: Numeric): Decimal {
  return dec(goodQty).times(dec(smvPerUnit));
}
