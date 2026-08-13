import "server-only";
import { db } from "./db";
import { dec, safeDiv, type Decimal } from "./money";
import { writeAudit, type AuditContext } from "./audit";

/**
 * A supplier's scorecard, frozen for a period.
 *
 * The live scorecard on the suppliers screen is computed over everything that
 * has ever happened, which answers "how is this supplier" and cannot answer
 * "are they getting better". A supplier who was poor last year and good since
 * looks mediocre forever, and the one going quietly downhill looks fine right
 * up until they stop delivering.
 *
 * So each period is scored on its own activity and kept. Nothing is recomputed
 * afterwards: a frozen scorecard is a record of what was true then, and a
 * supplier who improves should not have last quarter rewritten in their favour
 * any more than one who slips should have it rewritten against them.
 *
 * The three scores measure the three things that actually go wrong: goods
 * arriving late, goods arriving faulty, and goods costing more than the order
 * said. The weights are settings rather than constants, because how much each
 * matters is a judgement about this business and not a fact about arithmetic.
 */

export class ScorecardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScorecardError";
  }
}

/**
 * Out of ten.
 *
 * The column is Decimal(4, 2), which tops out at 99.99 — it was built for a
 * ten-point scale, and a hundred-point one overflows it on the first perfect
 * delivery. Ten is also how supplier scorecards are usually read.
 */
const MAX_SCORE = 10;

const DEFAULTS = {
  deliveryWeight: "0.4",
  qualityWeight: "0.4",
  priceWeight: "0.2",
  /**
   * How hard a price overrun bites. At 5, a 2% overrun costs a full point and
   * a 20% overrun takes the price score to zero. Stated here rather than
   * buried as a magic number in a formula.
   */
  priceSensitivity: "5",
} as const;

async function weights() {
  const rows = await db.setting.findMany({
    where: { key: { startsWith: "supplier.score." } },
    select: { key: true, value: true },
  });
  const get = (name: keyof typeof DEFAULTS) =>
    dec(rows.find((r) => r.key === `supplier.score.${name}`)?.value ?? DEFAULTS[name]);

  const delivery = get("deliveryWeight");
  const quality = get("qualityWeight");
  const price = get("priceWeight");
  const total = delivery.plus(quality).plus(price);

  if (total.isZero()) {
    throw new ScorecardError("The scorecard weights add up to nothing, so no score can be worked out.");
  }

  // Normalised rather than demanded to sum to one: an owner who sets 2/2/1 in
  // the settings means the same thing as 0.4/0.4/0.2 and should not be told
  // off for it.
  return {
    delivery: delivery.div(total),
    quality: quality.div(total),
    price: price.div(total),
    sensitivity: get("priceSensitivity"),
  };
}

const clamp = (v: Decimal) =>
  v.lessThan(0) ? dec(0) : v.greaterThan(MAX_SCORE) ? dec(MAX_SCORE) : v;

/**
 * Score every supplier on what they did inside one fiscal period.
 *
 * Only receipts and orders dated inside the period count. A supplier with no
 * activity is left out entirely rather than scored zero — nothing happened is
 * not the same claim as everything went wrong.
 */
export async function freezeScorecards(fiscalPeriodId: string, ctx: AuditContext) {
  const period = await db.fiscalPeriod.findUnique({
    where: { id: fiscalPeriodId },
    select: { id: true, year: true, month: true, startDate: true, endDate: true },
  });
  if (!period) throw new ScorecardError("Fiscal period not found.");

  const w = await weights();

  const suppliers = await db.supplier.findMany({
    include: {
      purchaseOrders: {
        where: { orderDate: { gte: period.startDate, lte: period.endDate } },
        include: {
          lines: true,
          receipts: {
            where: { receivedDate: { gte: period.startDate, lte: period.endDate } },
            include: { lines: true },
          },
        },
      },
    },
  });

  const frozen: {
    supplierId: string;
    code: string;
    priceScore: Decimal;
    qualityScore: Decimal;
    deliveryScore: Decimal;
    overallScore: Decimal;
    onTimeDeliveryRate: Decimal | null;
    defectRate: Decimal | null;
    avgPriceVariance: Decimal | null;
  }[] = [];

  for (const supplier of suppliers) {
    let ordered = dec(0);
    let received = dec(0);
    let rejected = dec(0);
    let priceVariance = dec(0);
    let receipts = 0;
    let late = 0;

    for (const order of supplier.purchaseOrders) {
      for (const line of order.lines) {
        ordered = ordered.plus(dec(line.quantity).times(dec(line.unitPrice)));
      }
      for (const receipt of order.receipts) {
        receipts += 1;
        if (order.expectedDate && receipt.receivedDate > order.expectedDate) late += 1;
        for (const line of receipt.lines) {
          received = received.plus(dec(line.acceptedQty));
          rejected = rejected.plus(dec(line.rejectedQty));
          priceVariance = priceVariance.plus(dec(line.priceVariance));
        }
      }
    }

    // Nothing happened is not the same claim as everything went wrong.
    if (supplier.purchaseOrders.length === 0 && receipts === 0) continue;

    const presented = received.plus(rejected);
    const onTime = receipts > 0 ? dec(receipts - late).div(receipts) : null;
    const defectRate = safeDiv(rejected, presented);
    const variancePct = safeDiv(priceVariance, ordered);

    const deliveryScore = clamp(dec(onTime ?? 1).times(MAX_SCORE));
    const qualityScore = clamp(dec(1).minus(defectRate ?? dec(0)).times(MAX_SCORE));

    // A favourable variance — the goods came in under the order — is a full
    // score rather than a bonus. Paying less than agreed is good, but it is
    // not a reason to forgive a late, faulty delivery.
    const overrun = variancePct && variancePct.greaterThan(0) ? variancePct : dec(0);
    const priceScore = clamp(
      dec(MAX_SCORE).minus(overrun.times(w.sensitivity).times(MAX_SCORE)),
    );

    const overallScore = clamp(
      deliveryScore.times(w.delivery)
        .plus(qualityScore.times(w.quality))
        .plus(priceScore.times(w.price)),
    );

    const round = (v: Decimal) => v.toDecimalPlaces(2);

    await db.supplierScorecard.upsert({
      where: { supplierId_fiscalPeriodId: { supplierId: supplier.id, fiscalPeriodId } },
      update: {
        priceScore: round(priceScore).toString(),
        qualityScore: round(qualityScore).toString(),
        deliveryScore: round(deliveryScore).toString(),
        overallScore: round(overallScore).toString(),
        onTimeDeliveryRate: onTime?.toString() ?? null,
        defectRate: defectRate?.toString() ?? null,
        avgPriceVariance: variancePct?.toString() ?? null,
      },
      create: {
        supplierId: supplier.id,
        fiscalPeriodId,
        priceScore: round(priceScore).toString(),
        qualityScore: round(qualityScore).toString(),
        deliveryScore: round(deliveryScore).toString(),
        overallScore: round(overallScore).toString(),
        onTimeDeliveryRate: onTime?.toString() ?? null,
        defectRate: defectRate?.toString() ?? null,
        avgPriceVariance: variancePct?.toString() ?? null,
      },
    });

    frozen.push({
      supplierId: supplier.id,
      code: supplier.code,
      priceScore: round(priceScore),
      qualityScore: round(qualityScore),
      deliveryScore: round(deliveryScore),
      overallScore: round(overallScore),
      onTimeDeliveryRate: onTime,
      defectRate,
      avgPriceVariance: variancePct,
    });
  }

  await writeAudit(db, {
    action: "SUPPLIER_SCORECARDS_FROZEN",
    entityName: "FiscalPeriod",
    entityId: fiscalPeriodId,
    ctx,
    after: {
      period: `${period.year}-${String(period.month).padStart(2, "0")}`,
      suppliers: frozen.length,
      weights: {
        delivery: w.delivery.toString(),
        quality: w.quality.toString(),
        price: w.price.toString(),
      },
    },
  });

  return {
    period: `${period.year}-${String(period.month).padStart(2, "0")}`,
    scored: frozen.length,
    skipped: suppliers.length - frozen.length,
    scorecards: frozen.sort((a, b) => Number(b.overallScore.minus(a.overallScore))),
  };
}

/**
 * The frozen history, newest period first.
 *
 * The trend is the point: a supplier's direction of travel matters more than
 * where they happen to stand this month.
 */
export async function scorecardHistory(supplierId?: string | null) {
  const rows = await db.supplierScorecard.findMany({
    where: supplierId ? { supplierId } : {},
    include: {
      supplier: { select: { id: true, code: true, nameAr: true, nameEn: true } },
      fiscalPeriod: { select: { year: true, month: true, status: true } },
    },
    orderBy: [{ fiscalPeriod: { year: "desc" } }, { fiscalPeriod: { month: "desc" } }],
  });

  const bySupplier = new Map<
    string,
    {
      supplierId: string;
      code: string;
      nameAr: string;
      nameEn: string;
      periods: {
        period: string;
        year: number;
        month: number;
        priceScore: string;
        qualityScore: string;
        deliveryScore: string;
        overallScore: string;
        onTimeDeliveryRate: string | null;
        defectRate: string | null;
        avgPriceVariance: string | null;
      }[];
    }
  >();

  for (const row of rows) {
    const at = bySupplier.get(row.supplier.id) ?? {
      supplierId: row.supplier.id,
      code: row.supplier.code,
      nameAr: row.supplier.nameAr,
      nameEn: row.supplier.nameEn,
      periods: [],
    };
    at.periods.push({
      period: `${row.fiscalPeriod.year}-${String(row.fiscalPeriod.month).padStart(2, "0")}`,
      year: row.fiscalPeriod.year,
      month: row.fiscalPeriod.month,
      priceScore: row.priceScore.toString(),
      qualityScore: row.qualityScore.toString(),
      deliveryScore: row.deliveryScore.toString(),
      overallScore: row.overallScore.toString(),
      onTimeDeliveryRate: row.onTimeDeliveryRate?.toString() ?? null,
      defectRate: row.defectRate?.toString() ?? null,
      avgPriceVariance: row.avgPriceVariance?.toString() ?? null,
    });
    bySupplier.set(row.supplier.id, at);
  }

  return [...bySupplier.values()]
    .map((s) => {
      const latest = s.periods[0] ?? null;
      const previous = s.periods[1] ?? null;
      return {
        ...s,
        latest,
        // Which way they are going, which is the thing a single score hides.
        movement:
          latest && previous
            ? dec(latest.overallScore).minus(dec(previous.overallScore))
            : null,
      };
    })
    .sort((a, b) =>
      Number(dec(b.latest?.overallScore ?? 0).minus(dec(a.latest?.overallScore ?? 0))),
    );
}

/** Periods that can be scored, newest first. */
export async function scorablePeriods() {
  const periods = await db.fiscalPeriod.findMany({
    orderBy: [{ year: "desc" }, { month: "desc" }],
    take: 24,
    include: { _count: { select: { supplierScores: true } } },
  });

  return periods.map((p) => ({
    id: p.id,
    label: `${p.year}-${String(p.month).padStart(2, "0")}`,
    year: p.year,
    month: p.month,
    status: p.status,
    scored: p._count.supplierScores,
  }));
}
