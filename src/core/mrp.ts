import { Decimal, dec, type Numeric } from "@/lib/money";

/**
 * Material requirements planning.
 *
 * The whole point is to answer one question honestly: for the production we
 * have committed to, what is short, and when does it need ordering? Every
 * figure here is a quantity that already exists somewhere — planned orders,
 * stock on hand, deliveries already placed — so a suggestion can always be
 * taken apart into the rows that produced it.
 *
 * Suggestions are never commitments. Nothing here writes a purchase order.
 */

export type MaterialPosition = {
  materialId: string;
  materialCode: string;
  materialNameEn: string;
  materialNameAr: string;
  uom: string;
  /** What confirmed production orders will consume, waste included. */
  required: Decimal;
  /** Unreserved stock on the shelf. */
  onHand: Decimal;
  /** Already ordered from a supplier but not yet delivered. */
  onOrder: Decimal;
  /** Kept back as a buffer; not available to plan against. */
  safetyStock: Decimal;
  leadTimeDays: number;
  moq: Decimal | null;
  packSize: Decimal | null;
  unitCost: Decimal;
};

export type Suggestion = {
  materialId: string;
  materialCode: string;
  materialNameEn: string;
  materialNameAr: string;
  uom: string;
  required: Decimal;
  onHand: Decimal;
  onOrder: Decimal;
  safetyStock: Decimal;
  /** required + safety − on hand − on order. Positive means short. */
  shortfall: Decimal;
  /** What to actually buy, after MOQ and pack rounding. */
  suggestedQty: Decimal;
  /** Why suggestedQty differs from the shortfall, if it does. */
  roundedUpBecause: "MOQ" | "PACK_SIZE" | null;
  estimatedCost: Decimal;
  leadTimeDays: number;
  /** The last day an order can be placed and still arrive in time. */
  orderBy: Date | null;
  urgency: "OVERDUE" | "URGENT" | "PLANNED";
};

/**
 * Rounds a shortfall up to something a supplier will actually sell.
 *
 * Ordering 42 metres when the roll is 100 is not an order anyone can place, so
 * the reason for the difference is returned alongside it — a planner needs to
 * see that the extra 58 metres is the supplier's rule, not the plan's.
 */
export function roundToPurchasable(
  shortfall: Decimal,
  moq: Numeric | null,
  packSize: Numeric | null,
): { quantity: Decimal; reason: "MOQ" | "PACK_SIZE" | null } {
  if (shortfall.lessThanOrEqualTo(0)) {
    return { quantity: dec(0), reason: null };
  }

  let quantity = shortfall;
  let reason: "MOQ" | "PACK_SIZE" | null = null;

  const minimum = moq != null ? dec(moq) : null;
  if (minimum && minimum.greaterThan(0) && quantity.lessThan(minimum)) {
    quantity = minimum;
    reason = "MOQ";
  }

  const pack = packSize != null ? dec(packSize) : null;
  if (pack && pack.greaterThan(0)) {
    const packs = quantity.div(pack).ceil();
    const rounded = packs.times(pack);
    if (rounded.greaterThan(quantity)) {
      quantity = rounded;
      // MOQ is the more surprising constraint, so it keeps the explanation.
      reason = reason ?? "PACK_SIZE";
    }
  }

  return { quantity, reason };
}

/**
 * Turns positions into suggestions.
 *
 * `needBy` is the earliest date the material is actually wanted; subtracting
 * the lead time gives the last day an order can be placed. A date already in
 * the past is reported as overdue rather than quietly shown as fine.
 */
export function planRequirements(
  positions: MaterialPosition[],
  options: { asOf: Date; needBy?: Date | null; urgentWithinDays?: number },
): Suggestion[] {
  const urgentWithin = options.urgentWithinDays ?? 7;

  return positions
    .map((p) => {
      const available = p.onHand.plus(p.onOrder).minus(p.safetyStock);
      const shortfall = p.required.minus(available);
      const { quantity, reason } = roundToPurchasable(shortfall, p.moq, p.packSize);

      const orderBy = options.needBy
        ? new Date(options.needBy.getTime() - p.leadTimeDays * 86_400_000)
        : null;

      const daysUntilOrderBy = orderBy
        ? Math.floor((orderBy.getTime() - options.asOf.getTime()) / 86_400_000)
        : null;

      const urgency: Suggestion["urgency"] =
        daysUntilOrderBy == null
          ? "PLANNED"
          : daysUntilOrderBy < 0
            ? "OVERDUE"
            : daysUntilOrderBy <= urgentWithin
              ? "URGENT"
              : "PLANNED";

      return {
        materialId: p.materialId,
        materialCode: p.materialCode,
        materialNameEn: p.materialNameEn,
        materialNameAr: p.materialNameAr,
        uom: p.uom,
        required: p.required,
        onHand: p.onHand,
        onOrder: p.onOrder,
        safetyStock: p.safetyStock,
        shortfall,
        suggestedQty: quantity,
        roundedUpBecause: reason,
        estimatedCost: quantity.times(p.unitCost),
        leadTimeDays: p.leadTimeDays,
        orderBy,
        urgency,
      };
    })
    .filter((s) => s.suggestedQty.greaterThan(0))
    .sort((a, b) => {
      const rank = { OVERDUE: 0, URGENT: 1, PLANNED: 2 };
      const byUrgency = rank[a.urgency] - rank[b.urgency];
      return byUrgency !== 0
        ? byUrgency
        : Number(b.estimatedCost.minus(a.estimatedCost));
    });
}

export type CapacityCheck = {
  minutesRequired: Decimal;
  minutesAvailable: Decimal;
  minutesBooked: Decimal;
  minutesFree: Decimal;
  fits: boolean;
  /** How much more capacity is needed, in minutes. Zero when it fits. */
  shortfallMinutes: Decimal;
};

/**
 * Whether a planned run fits in what is left of the month.
 *
 * Checked against *productive* minutes rather than gross, because a factory
 * running at 60% utilisation and 80% efficiency does not have its full clock
 * available — planning against gross minutes is how a run gets promised on a
 * date it can never be made by.
 */
export function checkCapacity(input: {
  productiveMinutes: Numeric;
  alreadyBookedMinutes: Numeric;
  minutesRequired: Numeric;
}): CapacityCheck {
  const available = dec(input.productiveMinutes);
  const booked = dec(input.alreadyBookedMinutes);
  const required = dec(input.minutesRequired);
  const free = available.minus(booked);
  const shortfall = required.minus(free);

  return {
    minutesRequired: required,
    minutesAvailable: available,
    minutesBooked: booked,
    minutesFree: free,
    fits: shortfall.lessThanOrEqualTo(0),
    shortfallMinutes: shortfall.greaterThan(0) ? shortfall : dec(0),
  };
}

/** Stock that has fallen to or below its reorder point. */
export function belowReorderPoint(
  materials: {
    materialId: string;
    materialCode: string;
    onHand: Numeric;
    reorderPoint: Numeric | null;
  }[],
): { materialId: string; materialCode: string; onHand: Decimal; reorderPoint: Decimal }[] {
  return materials
    .filter((m) => m.reorderPoint != null && dec(m.onHand).lessThanOrEqualTo(dec(m.reorderPoint)))
    .map((m) => ({
      materialId: m.materialId,
      materialCode: m.materialCode,
      onHand: dec(m.onHand),
      reorderPoint: dec(m.reorderPoint!),
    }));
}
