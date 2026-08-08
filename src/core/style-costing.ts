import { Decimal, dec, sum, type Numeric } from "@/lib/money";

/**
 * Style costing and the arm's-length transfer price.
 *
 * Decision D-002: the factory margin applies to the **full** factory cost,
 * materials included. The factory therefore earns margin on fabric as well as
 * on manufacturing, which compensates it for carrying purchasing, financing
 * and stock-holding risk — and means a fabric price rise raises the brand's
 * cost by more than the fabric rise itself.
 *
 * Every intermediate figure is returned, not just the final price. A transfer
 * price that cannot be opened up is a number the owner has to take on faith.
 */

export type BomLineInput = {
  materialId: string;
  materialCode: string;
  materialNameEn: string;
  materialNameAr: string;
  materialType: "FABRIC" | "TRIM" | "PACKAGING" | "CONSUMABLE";
  /** Per garment at the base size, before waste. */
  standardConsumption: Numeric;
  /** Landed cost: purchase price plus freight and duty, not the invoice price. */
  unitCost: Numeric;
  /** Overrides the style's planned waste rate for this line only. */
  wasteRateOverride?: Numeric | null;
};

export type StyleCostInput = {
  bomLines: BomLineInput[];
  /** Style-level planned waste. Actual waste drives variance, never costing. */
  plannedWasteRate: Numeric;
  /** Sum of the style's operation SMVs. */
  smvMinutes: Numeric;
  minuteRate: Numeric;
  factoryMarginPct: Numeric;
  /** Per-size multiplier; the base size is 1.0. */
  sizeConsumptionFactor?: Numeric;
};

export type CostLine = BomLineInput & {
  wasteRate: Decimal;
  effectiveConsumption: Decimal;
  lineCost: Decimal;
};

export type StyleCostResult = {
  lines: CostLine[];
  fabricCost: Decimal;
  trimCost: Decimal;
  materialCost: Decimal;
  cmtCost: Decimal;
  factoryTotalCost: Decimal;
  transferPrice: Decimal;
  /** transferPrice − factoryTotalCost. What the factory earns on the garment. */
  factoryMarginValue: Decimal;
};

export function calculateStyleCost(input: StyleCostInput): StyleCostResult {
  const sizeFactor = dec(input.sizeConsumptionFactor ?? 1);
  const styleWaste = dec(input.plannedWasteRate);

  const lines: CostLine[] = input.bomLines.map((line) => {
    const wasteRate =
      line.wasteRateOverride != null ? dec(line.wasteRateOverride) : styleWaste;

    // Waste is applied to consumption, not to cost, so the quantity actually
    // issued from the store is what gets costed.
    const effectiveConsumption = dec(line.standardConsumption)
      .times(sizeFactor)
      .times(wasteRate.plus(1));

    return {
      ...line,
      wasteRate,
      effectiveConsumption,
      lineCost: effectiveConsumption.times(dec(line.unitCost)),
    };
  });

  const fabricCost = sum(
    lines.filter((l) => l.materialType === "FABRIC").map((l) => l.lineCost),
  );
  // Everything that is not fabric — trims, packaging, consumables — is
  // grouped as trim cost for reporting; each still has its own line.
  const trimCost = sum(
    lines.filter((l) => l.materialType !== "FABRIC").map((l) => l.lineCost),
  );
  const materialCost = fabricCost.plus(trimCost);

  const cmtCost = dec(input.smvMinutes).times(dec(input.minuteRate));
  const factoryTotalCost = materialCost.plus(cmtCost);

  const transferPrice = factoryTotalCost.times(dec(input.factoryMarginPct).plus(1));

  return {
    lines,
    fabricCost,
    trimCost,
    materialCost,
    cmtCost,
    factoryTotalCost,
    transferPrice,
    factoryMarginValue: transferPrice.minus(factoryTotalCost),
  };
}

/**
 * What idle capacity costs on this specific garment.
 *
 * Reported alongside the cost rather than inside it: the penalty is already
 * embedded in `cmtCost` through the actual minute rate. Showing it separately
 * answers "how much of this garment's cost is us not selling enough".
 */
export function idleCapacityPenalty(
  actualMinuteRate: Numeric,
  fullCapacityMinuteRate: Numeric,
  smvMinutes: Numeric,
): Decimal {
  return dec(actualMinuteRate).minus(dec(fullCapacityMinuteRate)).times(dec(smvMinutes));
}

/**
 * Whether a generated transfer price clears the arm's-length floor.
 *
 * The rule exists because a discounted internal price does not save money — it
 * just migrates the factory's loss into the brand's accounts, and the system
 * stops being able to tell you anything useful.
 */
export function isBelowArmsLength(
  factoryMarginPct: Numeric,
  minimumMarginPct: Numeric,
): boolean {
  return dec(factoryMarginPct).lessThan(dec(minimumMarginPct));
}
