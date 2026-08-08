import { Decimal, dec, safeDiv, type Numeric } from "@/lib/money";

/**
 * The factory minute rate — the spine of all costing.
 *
 * Utilisation and efficiency are kept separate throughout because they are
 * different problems with different owners:
 *
 *   utilisation — the share of available minutes actually booked with work.
 *                 Low utilisation is a sales problem.
 *   efficiency  — earned standard minutes over clocked minutes while working.
 *                 Low efficiency is a shop-floor problem.
 *
 * Collapsing them into one "productivity" number would hide which of the two
 * is costing the money.
 */

export type CapacityInputs = {
  operators: number;
  workingDays: Numeric;
  hoursPerDay: Numeric;
  /** Stored as a fraction: 0.6, not 60. */
  utilisationRate: Numeric;
  efficiencyRate: Numeric;
};

export type CostPoolInputs = {
  /** Factory conversion cost before any CMT credit. Materials are excluded. */
  grossCostPool: Numeric;
  /**
   * External CMT revenue credited against the pool. Selling otherwise-idle
   * minutes genuinely lowers the burden the brand carries, so it belongs in
   * the numerator rather than being reported separately.
   */
  cmtRevenueCredit?: Numeric;
};

export type MinuteRateResult = {
  grossAvailableMinutes: Decimal;
  productiveMinutes: Decimal;
  idleMinutes: Decimal;
  grossCostPool: Decimal;
  cmtRevenueCredit: Decimal;
  netCostPool: Decimal;
  /** What the brand pays today. Null when there are no productive minutes. */
  actualMinuteRate: Decimal | null;
  /** The floor for quoting external work. Null when capacity is zero. */
  fullCapacityMinuteRate: Decimal | null;
  idlePenaltyPerMinute: Decimal | null;
};

export function calculateMinuteRate(
  capacity: CapacityInputs,
  pool: CostPoolInputs,
): MinuteRateResult {
  const grossAvailableMinutes = dec(capacity.operators)
    .times(dec(capacity.workingDays))
    .times(dec(capacity.hoursPerDay))
    .times(60);

  const productiveMinutes = grossAvailableMinutes
    .times(dec(capacity.utilisationRate))
    .times(dec(capacity.efficiencyRate));

  const idleMinutes = grossAvailableMinutes.minus(productiveMinutes);

  const grossCostPool = dec(pool.grossCostPool);
  const cmtRevenueCredit = dec(pool.cmtRevenueCredit ?? 0);
  const netCostPool = grossCostPool.minus(cmtRevenueCredit);

  // safeDiv rather than plain division: a month with no capacity configured
  // must report "unavailable", not Infinity. An infinite minute rate silently
  // becomes an absurd garment cost three screens later.
  const actualMinuteRate = safeDiv(netCostPool, productiveMinutes);
  const fullCapacityMinuteRate = safeDiv(netCostPool, grossAvailableMinutes);

  const idlePenaltyPerMinute =
    actualMinuteRate && fullCapacityMinuteRate
      ? actualMinuteRate.minus(fullCapacityMinuteRate)
      : null;

  return {
    grossAvailableMinutes,
    productiveMinutes,
    idleMinutes,
    grossCostPool,
    cmtRevenueCredit,
    netCostPool,
    actualMinuteRate,
    fullCapacityMinuteRate,
    idlePenaltyPerMinute,
  };
}

/**
 * What idle capacity costs on one garment.
 *
 * This is the single most useful diagnostic the system produces: it converts
 * an abstract utilisation percentage into EGP per piece.
 */
export function idlePenaltyPerUnit(
  idlePenaltyPerMinute: Decimal | null,
  styleSmvMinutes: Numeric,
): Decimal | null {
  if (!idlePenaltyPerMinute) return null;
  return idlePenaltyPerMinute.times(dec(styleSmvMinutes));
}

/**
 * Whether a quoted rate for external CMT work is allowed.
 *
 * Below the full-capacity rate the quote does not recover overhead even with
 * the factory completely full, so every minute sold at that price makes the
 * position worse rather than better.
 */
export function isQuoteAboveFloor(
  quotedMinuteRate: Numeric,
  fullCapacityMinuteRate: Decimal | null,
): boolean {
  if (!fullCapacityMinuteRate) return false;
  return dec(quotedMinuteRate).greaterThanOrEqualTo(fullCapacityMinuteRate);
}
