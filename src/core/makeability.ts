import { Decimal, dec, type Numeric } from "@/lib/money";

/**
 * How many of something the cloth on hand will actually make.
 *
 * A shop takes an order for a garment it does not have, and the only honest
 * answer to "when can I have it" begins with whether the fabric exists. This
 * turns a bill of materials and a shelf into that answer, in pieces.
 *
 * Waste is included, for the same reason the run includes it: the cutting
 * table consumes cloth, not the theoretical minimum, and promising to the
 * standard consumption guarantees running short partway through the cut.
 *
 * Pure, because it decides what a customer is told. An answer that can be run
 * on the numbers is an answer somebody can argue with.
 */

export type MaterialNeed = {
  materialId: string;
  materialCode: string;
  /** Per garment, before waste. */
  standardConsumption: Numeric;
  /** As a fraction: 0.05 is five per cent. */
  wasteRate: Numeric;
};

export type MaterialVerdict = {
  materialId: string;
  materialCode: string;
  /** What one garment takes, waste included. */
  perUnit: Decimal;
  onHand: Decimal;
  /** Whole garments this one material supports. */
  makes: number;
};

export type Makeability = {
  /** Whole garments the scarcest material allows. */
  makeable: number;
  lines: MaterialVerdict[];
  /** The material that runs out first, which is the one to go and buy. */
  limitedBy: MaterialVerdict | null;
};

/** What one garment consumes of a material, waste included. */
export function perUnitConsumption(need: MaterialNeed): Decimal {
  return dec(need.standardConsumption).times(dec(need.wasteRate).plus(1));
}

/**
 * The verdict, material by material and then as one number.
 *
 * A bill with no lines makes nothing. That is not a quibble: a style with no
 * bill has never been costed, and a run cannot be raised against it either,
 * so answering "unlimited" would promise a garment the factory would then
 * refuse to start.
 *
 * A material consumed at zero per garment is skipped rather than treated as
 * infinite, so one mistyped line cannot make a style look unlimited.
 */
export function makeabilityFrom(
  needs: MaterialNeed[],
  onHand: Map<string, Numeric>,
): Makeability {
  const lines: MaterialVerdict[] = needs.map((need) => {
    const perUnit = perUnitConsumption(need);
    const have = dec(onHand.get(need.materialId) ?? 0);
    return {
      materialId: need.materialId,
      materialCode: need.materialCode,
      perUnit,
      onHand: have,
      // Floored: half a metre short of the next piece is short.
      makes: perUnit.lessThanOrEqualTo(0)
        ? Number.POSITIVE_INFINITY
        : Math.floor(have.dividedBy(perUnit).toNumber()),
    };
  });

  const binding = lines.filter((l) => Number.isFinite(l.makes));
  if (binding.length === 0) return { makeable: 0, lines, limitedBy: null };

  const limitedBy = binding.reduce((worst, l) => (l.makes < worst.makes ? l : worst));
  return { makeable: Math.max(0, limitedBy.makes), lines, limitedBy };
}

/** What is still to be bought before `quantity` can be cut. */
export function shortfallFor(
  needs: MaterialNeed[],
  onHand: Map<string, Numeric>,
  quantity: number,
): { materialId: string; materialCode: string; short: Decimal }[] {
  const short: { materialId: string; materialCode: string; short: Decimal }[] = [];
  for (const need of needs) {
    const required = perUnitConsumption(need).times(quantity);
    const have = dec(onHand.get(need.materialId) ?? 0);
    if (required.greaterThan(have)) {
      short.push({
        materialId: need.materialId,
        materialCode: need.materialCode,
        short: required.minus(have),
      });
    }
  }
  return short;
}
