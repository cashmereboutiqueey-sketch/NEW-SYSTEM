import "server-only";
import { db } from "./db";
import { dec, safeDiv, type Decimal } from "./money";
import { agingProfile, AGE_BUCKETS, type AgeBucket } from "@/core/fifo";
import {
  cashConversionCycle, contribution, breakEven, gmroi, sellThrough,
} from "@/core/working-capital";

/**
 * The reports that answer "where is the money", as opposed to "what did we
 * earn".
 *
 * Everything here is derived from what is already recorded — posted journals,
 * lots, orders. Nothing is estimated or configured except where a figure
 * genuinely cannot be observed, and those are named as assumptions on the
 * screen rather than buried.
 */

/** How many days of stock are sitting still, measured rather than assumed. */
async function inventoryDays(entityId: string, monthlyCogs: Decimal) {
  const lots = await db.inventoryLot.findMany({
    where: { entityId, remainingQty: { gt: 0 } },
    select: { state: true, remainingQty: true, unitCost: true },
  });

  const valueOf = (state: string) =>
    lots
      .filter((l) => l.state === state)
      .reduce((s, l) => s.plus(dec(l.remainingQty).times(dec(l.unitCost))), dec(0));

  const daily = monthlyCogs.div(30);
  const days = (value: Decimal) => (daily.isZero() ? dec(0) : value.div(daily));

  return {
    rawValue: valueOf("RAW_MATERIAL"),
    wipValue: valueOf("WIP"),
    finishedValue: valueOf("FINISHED_GOODS"),
    rawDays: days(valueOf("RAW_MATERIAL")),
    wipDays: days(valueOf("WIP")),
    finishedDays: days(valueOf("FINISHED_GOODS")),
  };
}

/**
 * The cash conversion cycle, with each leg measured from the records.
 *
 * Stock days come from what is actually on hand against the cost of sales
 * running through it. Collection days come from orders whose payment is still
 * pending. Supplier credit comes from the terms actually agreed with the
 * suppliers being used, weighted by what is owed to each — an average across
 * all suppliers would flatter a business that buys most of its fabric on cash
 * terms from one of them.
 */
export async function cashCycle(entityId: string, monthsBack = 3) {
  const since = new Date();
  since.setMonth(since.getMonth() - monthsBack);

  const [orders, entity] = await Promise.all([
    db.salesOrder.findMany({
      where: { entityId, orderDate: { gte: since } },
      include: { payments: true },
    }),
    db.entity.findUniqueOrThrow({ where: { id: entityId } }),
  ]);

  const cogs = orders.reduce((s, o) => s.plus(dec(o.cogsAmount)), dec(0));

  // Averaged over the months that actually contain trading, not over the whole
  // window. A business two months old divided by twelve looks like it turns
  // over nothing, and every day-count built on that comes out absurd.
  const firstOrder = orders.reduce<Date | null>(
    (earliest, o) => (!earliest || o.orderDate < earliest ? o.orderDate : earliest),
    null,
  );
  const monthsOfTrading = firstOrder
    ? Math.max(
        1,
        Math.min(
          monthsBack,
          Math.round((Date.now() - firstOrder.getTime()) / (30 * 86_400_000)) || 1,
        ),
      )
    : monthsBack;
  const monthlyCogs = cogs.div(monthsOfTrading);

  const stock = await inventoryDays(entityId, monthlyCogs);

  // Money already earned and not yet in hand — chiefly cash on delivery
  // waiting on the courier to remit.
  const uncollected = orders
    .flatMap((o) => o.payments.filter((p) => p.status === "PENDING"))
    .reduce((s, p) => s.plus(dec(p.amount)), dec(0));
  const dailyRevenue = orders.reduce((s, o) => s.plus(dec(o.netAmount)), dec(0)).div(
    Math.max(1, monthsBack * 30),
  );
  const collectionDays = dailyRevenue.isZero() ? dec(0) : uncollected.div(dailyRevenue);

  // Weighted by what is actually owed, so terms on a supplier nothing is owed
  // to do not drag the average.
  const open = await db.expense.findMany({
    where: { entityId, status: { in: ["UNPAID", "PARTIALLY_PAID"] }, supplierId: { not: null } },
    include: { supplier: true },
  });
  const owed = open.reduce((s, e) => s.plus(dec(e.amount).minus(dec(e.paidAmount))), dec(0));
  const weightedCredit = owed.isZero()
    ? dec(0)
    : open
        .reduce(
          (s, e) =>
            s.plus(
              dec(e.amount)
                .minus(dec(e.paidAmount))
                .times(dec(e.supplier?.creditDays ?? 0)),
            ),
          dec(0),
        )
        .div(owed);

  const result = cashConversionCycle(
    {
      rawMaterialDays: stock.rawDays,
      productionLeadDays: stock.wipDays,
      finishedGoodsDays: stock.finishedDays,
      collectionDays,
      supplierCreditDays: weightedCredit,
    },
    monthlyCogs,
  );

  return {
    entityName: { en: entity.nameEn, ar: entity.nameAr },
    monthlyCogs,
    monthsOfTrading,
    legs: {
      rawMaterialDays: stock.rawDays,
      productionLeadDays: stock.wipDays,
      finishedGoodsDays: stock.finishedDays,
      collectionDays,
      supplierCreditDays: weightedCredit,
    },
    values: {
      raw: stock.rawValue,
      wip: stock.wipValue,
      finished: stock.finishedValue,
      uncollected,
      owedToSuppliers: owed,
    },
    ...result,
  };
}

/**
 * Return on the money tied up in stock, by collection.
 *
 * Gross margin over average stock at cost. A collection with a fat margin that
 * nobody buys scores worse than a thin-margin one that turns over, which is
 * the entire point of looking at it this way rather than at margin alone.
 */
export async function gmroiByCollection(entityId: string) {
  const collections = await db.collection.findMany({
    include: {
      styles: {
        include: {
          variants: {
            include: {
              inventoryLots: { where: { entityId, remainingQty: { gt: 0 } } },
              salesOrderLines: { include: { salesOrder: true } },
            },
          },
        },
      },
    },
  });

  return collections
    .map((collection) => {
      let revenue = dec(0);
      let cost = dec(0);
      let unitsSold = 0;
      let stockValue = dec(0);
      let unitsInStock = dec(0);

      for (const style of collection.styles) {
        for (const variant of style.variants) {
          for (const line of variant.salesOrderLines) {
            if (line.salesOrder.entityId !== entityId) continue;
            revenue = revenue.plus(dec(line.lineTotal));
            cost = cost.plus(dec(line.lineCost));
            unitsSold += line.quantity;
          }
          for (const lot of variant.inventoryLots) {
            stockValue = stockValue.plus(dec(lot.remainingQty).times(dec(lot.unitCost)));
            unitsInStock = unitsInStock.plus(dec(lot.remainingQty));
          }
        }
      }

      const grossMargin = revenue.minus(cost);

      return {
        id: collection.id,
        nameEn: collection.nameEn,
        nameAr: collection.nameAr,
        season: collection.season,
        revenue,
        cost,
        grossMargin,
        marginPct: safeDiv(grossMargin, revenue),
        stockValue,
        unitsInStock,
        unitsSold,
        // Null rather than a large number when there is no stock left: an
        // empty collection has no capital in it to earn a return on.
        gmroi: gmroi(grossMargin, stockValue),
      };
    })
    .filter((c) => c.unitsSold > 0 || c.stockValue.greaterThan(0))
    .sort((a, b) => Number(b.grossMargin.minus(a.grossMargin)));
}

/**
 * What share of each run has actually sold, and what is left.
 *
 * Measured against what was produced, not against what reached the shop: a run
 * that lost three garments on the road still cost the money to make them.
 */
export async function sellThroughByStyle(entityId: string) {
  const styles = await db.style.findMany({
    where: { isActive: true },
    include: {
      collection: true,
      productionOrders: { where: { status: "COMPLETED" } },
      variants: {
        include: {
          inventoryLots: { where: { entityId, remainingQty: { gt: 0 } } },
          salesOrderLines: { include: { salesOrder: true } },
        },
      },
    },
  });

  return styles
    .map((style) => {
      const produced = style.productionOrders.reduce((s, o) => s + (o.actualQty ?? 0), 0);

      let sold = 0;
      let revenue = dec(0);
      let cost = dec(0);
      let onHand = dec(0);
      let onHandValue = dec(0);
      let firstSale: Date | null = null;

      for (const variant of style.variants) {
        for (const line of variant.salesOrderLines) {
          if (line.salesOrder.entityId !== entityId) continue;
          sold += line.quantity;
          revenue = revenue.plus(dec(line.lineTotal));
          cost = cost.plus(dec(line.lineCost));
          if (!firstSale || line.salesOrder.orderDate < firstSale) {
            firstSale = line.salesOrder.orderDate;
          }
        }
        for (const lot of variant.inventoryLots) {
          onHand = onHand.plus(dec(lot.remainingQty));
          onHandValue = onHandValue.plus(dec(lot.remainingQty).times(dec(lot.unitCost)));
        }
      }

      const daysOnSale = firstSale
        ? Math.max(1, Math.floor((Date.now() - firstSale.getTime()) / 86_400_000))
        : null;

      return {
        id: style.id,
        code: style.code,
        nameEn: style.nameEn,
        nameAr: style.nameAr,
        collectionEn: style.collection?.nameEn ?? null,
        collectionAr: style.collection?.nameAr ?? null,
        retailPrice: style.retailPrice,
        produced,
        sold,
        onHand,
        onHandValue,
        revenue,
        grossMargin: revenue.minus(cost),
        sellThrough: sellThrough(sold, produced),
        daysOnSale,
        /** Units a day, so a slow style with a long run is not flattered. */
        rateOfSale: daysOnSale ? dec(sold).div(daysOnSale) : null,
      };
    })
    .filter((s) => s.produced > 0 || s.sold > 0)
    .sort((a, b) => Number((b.sellThrough ?? dec(0)).minus(a.sellThrough ?? dec(0))));
}

/** Stock by how long it has been sitting, and what it cost. */
export async function deadStock(entityId: string, asOf: Date = new Date()) {
  const lots = await db.inventoryLot.findMany({
    where: { entityId, remainingQty: { gt: 0 } },
    include: {
      material: true,
      variant: { include: { style: true, colorCode: true, sizeCode: true } },
      location: true,
    },
    orderBy: { receivedDate: "asc" },
  });

  const profile = agingProfile(
    lots.map((l) => ({
      id: l.id,
      receivedDate: l.receivedDate,
      sequence: l.sequence,
      remainingQty: l.remainingQty.toString(),
      unitCost: l.unitCost.toString(),
    })),
    asOf,
  );

  const rows = lots
    .map((lot) => {
      const days = Math.floor((asOf.getTime() - lot.receivedDate.getTime()) / 86_400_000);
      return {
        id: lot.id,
        lotNumber: lot.lotNumber,
        state: lot.state,
        nameEn: lot.variant
          ? `${lot.variant.style.nameEn} · ${lot.variant.colorCode.nameEn} · ${lot.variant.sizeCode.code}`
          : (lot.material?.nameEn ?? "—"),
        nameAr: lot.variant
          ? `${lot.variant.style.nameAr} · ${lot.variant.colorCode.nameAr} · ${lot.variant.sizeCode.code}`
          : (lot.material?.nameAr ?? "—"),
        code: lot.variant?.sku ?? lot.material?.code ?? "—",
        locationEn: lot.location?.nameEn ?? "—",
        locationAr: lot.location?.nameAr ?? "—",
        quantity: dec(lot.remainingQty),
        value: dec(lot.remainingQty).times(dec(lot.unitCost)),
        receivedDate: lot.receivedDate,
        days,
        isDeadStock: lot.isDeadStock,
      };
    })
    .sort((a, b) => b.days - a.days);

  const total = rows.reduce((s, r) => s.plus(r.value), dec(0));
  const stale = rows.filter((r) => r.days > 90).reduce((s, r) => s.plus(r.value), dec(0));

  return {
    buckets: AGE_BUCKETS.map((bucket: AgeBucket) => ({
      bucket,
      quantity: profile[bucket].quantity,
      value: profile[bucket].value,
    })),
    rows,
    total,
    stale,
    staleShare: safeDiv(stale, total),
  };
}

/**
 * What discounting actually cost, by style.
 *
 * Discounts are posted to their own contra-revenue account rather than netted
 * into the sale price, which is what makes this answerable at all.
 */
export async function markdownAnalysis(entityId: string) {
  const lines = await db.salesOrderLine.findMany({
    where: { salesOrder: { entityId } },
    include: {
      salesOrder: true,
      variant: { include: { style: { include: { collection: true } } } },
    },
  });

  const byStyle = new Map<
    string,
    {
      id: string;
      code: string;
      nameEn: string;
      nameAr: string;
      units: number;
      discountedUnits: number;
      grossRevenue: Decimal;
      netRevenue: Decimal;
      cost: Decimal;
      deepestDiscount: Decimal;
    }
  >();

  for (const line of lines) {
    const style = line.variant.style;
    const entry = byStyle.get(style.id) ?? {
      id: style.id,
      code: style.code,
      nameEn: style.nameEn,
      nameAr: style.nameAr,
      units: 0,
      discountedUnits: 0,
      grossRevenue: dec(0),
      netRevenue: dec(0),
      cost: dec(0),
      deepestDiscount: dec(0),
    };

    const discount = dec(line.discountPct);
    entry.units += line.quantity;
    if (discount.greaterThan(0)) entry.discountedUnits += line.quantity;
    entry.grossRevenue = entry.grossRevenue.plus(dec(line.retailPrice).times(line.quantity));
    entry.netRevenue = entry.netRevenue.plus(dec(line.lineTotal));
    entry.cost = entry.cost.plus(dec(line.lineCost));
    if (discount.greaterThan(entry.deepestDiscount)) entry.deepestDiscount = discount;

    byStyle.set(style.id, entry);
  }

  return [...byStyle.values()]
    .map((s) => {
      const givenAway = s.grossRevenue.minus(s.netRevenue);
      const marginAfter = s.netRevenue.minus(s.cost);
      const marginBefore = s.grossRevenue.minus(s.cost);
      return {
        ...s,
        givenAway,
        marginAfter,
        marginBefore,
        marginPctAfter: safeDiv(marginAfter, s.netRevenue),
        // What share of the margin the discount consumed. Above 1 means the
        // discount cost more than the style earned.
        marginEaten: safeDiv(givenAway, marginBefore),
        discountedShare: s.units > 0 ? dec(s.discountedUnits).div(s.units) : dec(0),
      };
    })
    .filter((s) => s.units > 0)
    .sort((a, b) => Number(b.givenAway.minus(a.givenAway)));
}

/**
 * How each supplier actually performs, against what they promised.
 *
 * Price, lateness and quality in one place. A cheap supplier who delivers two
 * weeks late and 8% rejected is not cheap, and that only becomes visible when
 * the three are read together.
 */
export async function supplierScorecard() {
  const suppliers = await db.supplier.findMany({
    where: { isActive: true },
    include: {
      purchaseOrders: {
        include: {
          lines: true,
          receipts: { include: { lines: true } },
        },
      },
    },
    orderBy: { nameEn: "asc" },
  });

  return suppliers
    .map((supplier) => {
      let ordered = dec(0);
      let received = dec(0);
      let rejected = dec(0);
      let priceVariance = dec(0);
      let receiptCount = 0;
      let lateReceipts = 0;
      let totalLateDays = 0;

      for (const order of supplier.purchaseOrders) {
        for (const line of order.lines) ordered = ordered.plus(dec(line.quantity));

        for (const receipt of order.receipts) {
          receiptCount++;
          for (const line of receipt.lines) {
            received = received.plus(dec(line.acceptedQty));
            rejected = rejected.plus(dec(line.rejectedQty));
            priceVariance = priceVariance.plus(dec(line.priceVariance));
          }
          if (order.expectedDate) {
            const late = Math.floor(
              (receipt.receivedDate.getTime() - order.expectedDate.getTime()) / 86_400_000,
            );
            if (late > 0) {
              lateReceipts++;
              totalLateDays += late;
            }
          }
        }
      }

      const presented = received.plus(rejected);

      return {
        id: supplier.id,
        code: supplier.code,
        nameEn: supplier.nameEn,
        nameAr: supplier.nameAr,
        creditDays: supplier.creditDays,
        orders: supplier.purchaseOrders.length,
        receipts: receiptCount,
        ordered,
        received,
        rejected,
        rejectRate: safeDiv(rejected, presented),
        priceVariance,
        onTimeRate: receiptCount > 0 ? dec(receiptCount - lateReceipts).div(receiptCount) : null,
        averageLateDays: lateReceipts > 0 ? dec(totalLateDays).div(lateReceipts) : dec(0),
      };
    })
    .filter((s) => s.orders > 0);
}

/**
 * Break-even per style, from the Brand's own numbers.
 *
 * Contribution is worked out per garment: what it sells for after discount and
 * returns, less what it cost to buy from the factory and everything variable
 * that goes out of the door with it.
 *
 * `allocatedFixedCosts` is Brand fixed cost only. Factory overhead is already
 * inside the transfer price, so charging it again here would count it twice —
 * the single easiest way to make a healthy style look unviable.
 */
export async function breakEvenByStyle(entityId: string, monthsBack = 3) {
  const since = new Date();
  since.setMonth(since.getMonth() - monthsBack);

  const [fixedRows, styles, marketing, brandSettings] = await Promise.all([
    db.$queryRaw<{ total: string }[]>`
      SELECT COALESCE(SUM(l."debit") - SUM(l."credit"), 0)::text AS total
      FROM "journal_lines" l
      JOIN "journal_entries" e ON e."id" = l."journalEntryId"
      JOIN "accounts" a ON a."id" = l."accountId"
      WHERE a."includeInBrandFixedPool" = true
        AND e."status" = 'POSTED'
        AND l."entityId" = ${entityId}
        AND e."postingDate" >= ${since}
    `,
    db.style.findMany({
      where: { isActive: true, retailPrice: { not: null } },
      include: {
        costSnapshots: { orderBy: { createdAt: "desc" }, take: 1 },
        variants: {
          include: { salesOrderLines: { include: { salesOrder: true } } },
        },
      },
    }),
    db.campaignSpend.aggregate({
      where: { spendDate: { gte: since } },
      _sum: { amount: true },
    }),
    db.setting.findMany({
      where: { key: { in: ["brand.packagingPerUnit", "brand.shippingPerUnit", "brand.returnRate"] } },
    }),
  ]);

  const setting = (key: string, fallback: string) =>
    dec(brandSettings.find((s) => s.key === key)?.value ?? fallback);

  const fixedPool = dec(fixedRows[0]?.total ?? 0);
  const monthlyFixed = monthsBack > 0 ? fixedPool.div(monthsBack) : fixedPool;

  // Marketing is spread across everything sold, since a campaign rarely names
  // one style. Stated on the screen so nobody mistakes it for a measurement.
  const totalUnitsSold = styles.reduce(
    (s, style) =>
      s +
      style.variants.reduce(
        (t, v) => t + v.salesOrderLines.reduce((u, l) => u + l.quantity, 0),
        0,
      ),
    0,
  );
  const marketingPerUnit =
    totalUnitsSold > 0 ? dec(marketing._sum.amount ?? 0).div(totalUnitsSold) : dec(0);

  const packaging = setting("brand.packagingPerUnit", "0");
  const shipping = setting("brand.shippingPerUnit", "0");
  const returnRate = setting("brand.returnRate", "0");

  const rows = styles
    .map((style) => {
      const snapshot = style.costSnapshots[0];
      if (!snapshot) return null;

      const lines = style.variants.flatMap((v) =>
        v.salesOrderLines.filter((l) => l.salesOrder.entityId === entityId),
      );
      const units = lines.reduce((s, l) => s + l.quantity, 0);

      // The discount actually given, weighted by units, rather than a guess.
      const weightedDiscount =
        units > 0
          ? lines
              .reduce((s, l) => s.plus(dec(l.discountPct).times(l.quantity)), dec(0))
              .div(units)
          : dec(0);

      const economics = {
        retailPrice: style.retailPrice!,
        discountRate: weightedDiscount,
        returnRate,
        transferPrice: snapshot.transferPrice,
        packaging,
        shipping,
        paymentFee: dec(0),
        marketingPerUnit,
        returnHandlingCost: dec(0),
      };

      const c = contribution(economics);
      const share = totalUnitsSold > 0 ? dec(units).div(totalUnitsSold) : dec(0);
      const allocated = monthlyFixed.times(share);

      return {
        id: style.id,
        code: style.code,
        nameEn: style.nameEn,
        nameAr: style.nameAr,
        retailPrice: dec(style.retailPrice!),
        transferPrice: dec(snapshot.transferPrice),
        discountRate: weightedDiscount,
        unitsSold: units,
        allocatedFixed: allocated,
        ...c,
        result: breakEven(c.contributionMargin, allocated),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  return {
    monthlyFixed,
    marketingPerUnit,
    packaging,
    shipping,
    returnRate,
    totalUnitsSold,
    rows: rows.sort((a, b) => Number(b.contributionMargin.minus(a.contributionMargin))),
  };
}

/**
 * How a collection did — through the eyes of whichever side is asking.
 *
 * The two sides of the house own the same garment at different moments and
 * they do not mean the same thing by "how did it do":
 *
 *   The Factory made it. Its revenue on the collection is what it invoiced the
 *   Brand at transfer price; its cost is what the run actually cost to cut and
 *   sew. It cares how many were produced, and how the cost per piece moved
 *   between runs.
 *
 *   The Brand bought it at that transfer price — so the Factory's revenue is
 *   the Brand's cost — and sold it in the shop. Its revenue is the till, its
 *   margin is retail less transfer, and what is left unsold is its problem
 *   rather than the Factory's.
 *
 * Reporting one set of numbers for both is how a collection ends up looking
 * profitable on a margin the Factory earned and the Brand paid for. Both are
 * true; they are answers to different questions.
 */
export async function collectionPerformance(
  entityId: string,
  kind: "FACTORY" | "BRAND",
) {
  const [collections, transfers] = await Promise.all([
    db.collection.findMany({
      orderBy: [{ year: "desc" }, { code: "asc" }],
      include: {
        styles: {
          include: {
            productionOrders: { where: { status: "COMPLETED" } },
            variants: {
              include: {
                inventoryLots: { where: { entityId, remainingQty: { gt: 0 } } },
                salesOrderLines: { include: { salesOrder: true } },
              },
            },
          },
        },
      },
    }),
    // What crossed the house, read separately rather than nested. A movement
    // hangs off the lot it landed in, and that lot is usually sold out by the
    // time anybody asks how the collection did — nesting it under the stock
    // still on hand would report the Factory as having transferred nothing.
    db.inventoryMovement.findMany({
      where: { referenceType: "TRANSFER_INVOICE", type: "RECEIPT" },
      select: {
        quantity: true,
        totalCost: true,
        lot: {
          select: {
            transferMarginPerUnit: true,
            variant: { select: { styleId: true } },
          },
        },
      },
    }),
  ]);

  const transferredByStyle = new Map<
    string,
    { units: Decimal; revenue: Decimal; margin: Decimal }
  >();
  for (const movement of transfers) {
    const styleId = movement.lot.variant?.styleId;
    if (!styleId) continue;
    const at = transferredByStyle.get(styleId) ?? {
      units: dec(0), revenue: dec(0), margin: dec(0),
    };
    at.units = at.units.plus(dec(movement.quantity));
    at.revenue = at.revenue.plus(dec(movement.totalCost));
    at.margin = at.margin.plus(
      dec(movement.lot.transferMarginPerUnit ?? 0).times(dec(movement.quantity)),
    );
    transferredByStyle.set(styleId, at);
  }

  const rows = collections.map((collection) => {
    const styles = collection.styles.map((style) => {
      const produced = style.productionOrders.reduce((n, o) => n + (o.actualQty ?? 0), 0);
      const productionCost = style.productionOrders.reduce(
        (t, o) => t.plus(dec(o.actualTotalCost ?? o.plannedTotalCost ?? 0)),
        dec(0),
      );

      let soldUnits = 0;
      let retailRevenue = dec(0);
      let retailCost = dec(0);
      let onHand = dec(0);
      let onHandValue = dec(0);

      const moved = transferredByStyle.get(style.id);
      const transferredUnits = moved?.units ?? dec(0);
      const transferRevenue = moved?.revenue ?? dec(0);
      const transferMargin = moved?.margin ?? dec(0);

      for (const variant of style.variants) {
        for (const line of variant.salesOrderLines) {
          if (line.salesOrder.entityId !== entityId) continue;
          soldUnits += line.quantity;
          retailRevenue = retailRevenue.plus(dec(line.lineTotal));
          retailCost = retailCost.plus(dec(line.lineCost));
        }
        for (const lot of variant.inventoryLots) {
          onHand = onHand.plus(dec(lot.remainingQty));
          onHandValue = onHandValue.plus(dec(lot.remainingQty).times(dec(lot.unitCost)));
        }
      }

      // What this side earned, and what it gave up to earn it.
      const revenue = kind === "FACTORY" ? transferRevenue : retailRevenue;
      const cost =
        kind === "FACTORY" ? transferRevenue.minus(transferMargin) : retailCost;
      const units = kind === "FACTORY" ? Number(transferredUnits) : soldUnits;
      const grossMargin = revenue.minus(cost);

      // What this side had to work with, which is not the same number on both.
      // The Factory answers for everything it made. The Brand answers only for
      // what actually reached it — judging the shop on garments that never
      // arrived reports a sell-through failure against whoever lost them.
      const base = kind === "FACTORY" ? produced : Number(transferredUnits);

      return {
        id: style.id,
        code: style.code,
        nameAr: style.nameAr,
        nameEn: style.nameEn,
        imageName: style.imageName,
        retailPrice: style.retailPrice ? dec(style.retailPrice) : null,
        produced,
        productionCost,
        // Cost per piece off the line: the number that says whether the second
        // run of a style was cheaper than the first.
        costPerPiece: produced > 0 ? productionCost.div(produced) : null,
        transferred: transferredUnits,
        base,
        units,
        revenue,
        cost,
        grossMargin,
        marginPct: safeDiv(grossMargin, revenue),
        onHand,
        onHandValue,
        sellThrough: sellThrough(units, base),
      };
    });

    const sum = (pick: (s: (typeof styles)[number]) => Decimal) =>
      styles.reduce((t, s) => t.plus(pick(s)), dec(0));

    const revenue = sum((s) => s.revenue);
    const cost = sum((s) => s.cost);
    const grossMargin = revenue.minus(cost);
    const produced = styles.reduce((n, s) => n + s.produced, 0);
    const units = styles.reduce((n, s) => n + s.units, 0);
    const base = styles.reduce((n, s) => n + s.base, 0);

    // Best is by what it earned, not by what it sold: twenty cheap pieces
    // moving is not a better result than four expensive ones, and ranking on
    // units is how a collection gets repeated on its least profitable style.
    const traded = styles.filter((s) => s.units > 0 || s.produced > 0);
    const best = [...traded].sort((a, b) => Number(b.grossMargin.minus(a.grossMargin)))[0] ?? null;
    const mostProduced = [...traded].sort((a, b) => b.produced - a.produced)[0] ?? null;
    const worst =
      [...traded]
        .filter((s) => s.base > 0)
        .sort((a, b) =>
          Number((a.sellThrough ?? dec(0)).minus(b.sellThrough ?? dec(0))),
        )[0] ?? null;

    return {
      id: collection.id,
      code: collection.code,
      nameAr: collection.nameAr,
      nameEn: collection.nameEn,
      season: collection.season,
      year: collection.year,
      isActive: collection.isActive,
      styleCount: collection.styles.length,
      produced,
      units,
      /** What this side had to sell on: made, for the Factory; received, for the Brand. */
      base,
      transferred: sum((s) => s.transferred),
      revenue,
      cost,
      grossMargin,
      marginPct: safeDiv(grossMargin, revenue),
      onHand: sum((s) => s.onHand),
      onHandValue: sum((s) => s.onHandValue),
      productionCost: sum((s) => s.productionCost),
      sellThrough: sellThrough(units, base),
      best,
      mostProduced,
      worst,
      styles: [...styles].sort((a, b) => Number(b.grossMargin.minus(a.grossMargin))),
    };
  });

  // Collections nobody has made or sold anything from are noise on a report
  // about performance. They are still reachable from the styles screen.
  return rows
    .filter((c) => c.units > 0 || c.produced > 0 || c.onHandValue.greaterThan(0))
    .sort((a, b) => Number(b.grossMargin.minus(a.grossMargin)));
}
