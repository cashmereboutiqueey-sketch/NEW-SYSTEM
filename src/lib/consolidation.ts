import "server-only";
import { db } from "./db";
import {
  consolidate,
  unrealisedProfitInStock,
  intercompanyReconciliation,
  type EntityResult,
} from "@/core/consolidation";
import { dec } from "./money";

/**
 * Group reporting, read from the posted ledger.
 *
 * Nothing here writes. Consolidation is a *view* over the two sets of books —
 * the elimination entries are computed for presentation, never posted into
 * either entity, because neither entity's own accounts are wrong.
 */

/** Sums posted movement on a set of accounts for one entity and period. */
async function movement(
  entityId: string,
  fiscalPeriodId: string | null,
  filter: { codes?: string[]; type?: string; intercompany?: boolean },
): Promise<string> {
  const rows = await db.$queryRaw<{ total: string }[]>`
    SELECT COALESCE(SUM(l."debit") - SUM(l."credit"), 0)::text AS total
    FROM "journal_lines" l
    JOIN "journal_entries" e ON e."id" = l."journalEntryId"
    JOIN "accounts" a ON a."id" = l."accountId"
    WHERE e."status" = 'POSTED'
      AND l."entityId" = ${entityId}
      AND (${fiscalPeriodId}::text IS NULL OR e."fiscalPeriodId" = ${fiscalPeriodId})
      AND (${filter.codes ?? null}::text[] IS NULL OR a."code" = ANY(${filter.codes ?? null}::text[]))
      AND (${filter.type ?? null}::text IS NULL OR a."type"::text = ${filter.type ?? null})
      AND (${filter.intercompany ?? null}::boolean IS NULL OR a."isIntercompany" = ${filter.intercompany ?? null})
  `;
  return rows[0].total;
}

async function readEntityResult(
  entityId: string,
  fiscalPeriodId: string | null,
): Promise<EntityResult> {
  // Revenue accounts carry credit balances, so the sign is flipped to read as
  // a positive figure.
  const allRevenue = dec(await movement(entityId, fiscalPeriodId, { type: "REVENUE" })).negated();
  const icRevenue = dec(
    await movement(entityId, fiscalPeriodId, { type: "REVENUE", intercompany: true }),
  ).negated();

  const allCogs = dec(await movement(entityId, fiscalPeriodId, { type: "COGS" }));
  const icCogs = dec(
    await movement(entityId, fiscalPeriodId, { type: "COGS", intercompany: true }),
  );

  const expenses = dec(await movement(entityId, fiscalPeriodId, { type: "EXPENSE" }));

  return {
    // Contra-revenue (discounts, returns) is already netted in by the sum.
    externalRevenue: allRevenue.minus(icRevenue).toString(),
    intercompanyRevenue: icRevenue.toString(),
    externalCogs: allCogs.minus(icCogs).toString(),
    intercompanyCogs: icCogs.toString(),
    operatingExpenses: expenses.toString(),
  };
}

/**
 * Brand stock that came from the factory, as it stood at a moment: every lot
 * carrying a transfer margin, with the quantity its own movements say it held
 * then. `before` excludes the day itself, for an opening balance.
 */
async function transferredStockAsOf(
  brandId: string,
  at: { onOrBefore: Date } | { before: Date } | null,
) {
  const onOrBefore = at && "onOrBefore" in at ? at.onOrBefore : null;
  const before = at && "before" in at ? at.before : null;
  return db.$queryRaw<
    { lotId: string; lotNumber: string; sku: string | null; styleCode: string | null; qty: string; margin: string }[]
  >`
    SELECT l."id" AS "lotId", l."lotNumber", v."sku", s."code" AS "styleCode",
           q.qty::text AS qty, l."transferMarginPerUnit"::text AS margin
    FROM "inventory_lots" l
    JOIN (
      SELECT m."lotId",
             SUM(CASE WHEN m."direction" = 'IN' THEN m."quantity" ELSE -m."quantity" END) AS qty
      FROM "inventory_movements" m
      WHERE (${onOrBefore}::date IS NULL OR m."movementDate" <= ${onOrBefore}::date)
        AND (${before}::date IS NULL OR m."movementDate" < ${before}::date)
      GROUP BY m."lotId"
    ) q ON q."lotId" = l."id"
    LEFT JOIN "variants" v ON v."id" = l."variantId"
    LEFT JOIN "styles" s ON s."id" = v."styleId"
    WHERE l."entityId" = ${brandId}
      AND l."state" = 'FINISHED_GOODS'
      AND l."transferMarginPerUnit" IS NOT NULL
      AND q.qty > 0
    ORDER BY l."lotNumber"
  `;
}

export async function groupProfitAndLoss(fiscalPeriodId: string | null = null) {
  const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });
  const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });

  const [factoryResult, brandResult] = await Promise.all([
    readEntityResult(factory.id, fiscalPeriodId),
    readEntityResult(brand.id, fiscalPeriodId),
  ]);

  // Factory margin still inside Brand stock, at the start and at the end of
  // the period, rebuilt from each lot's movements rather than read from what
  // is on the shelf today. Using today's stock made last month's group profit
  // change every time a garment sold this month, and with the opening fixed at
  // zero the whole balance was deferred again in every period it was viewed.
  //
  // For all time, there is no opening, and the closing is as of now.
  const period = fiscalPeriodId
    ? await db.fiscalPeriod.findUniqueOrThrow({ where: { id: fiscalPeriodId } })
    : null;
  const [openingLots, closingLots] = await Promise.all([
    period ? transferredStockAsOf(brand.id, { before: period.startDate }) : Promise.resolve([]),
    transferredStockAsOf(brand.id, period ? { onOrBefore: period.endDate } : null),
  ]);

  const deferred = (lots: { qty: string; margin: string }[]) =>
    unrealisedProfitInStock(lots.map((l) => ({ remainingQty: l.qty, transferMarginPerUnit: l.margin })));
  const openingUnrealised = deferred(openingLots);
  const closingUnrealised = deferred(closingLots);

  const result = consolidate(factoryResult, brandResult, {
    opening: openingUnrealised,
    closing: closingUnrealised,
  });

  const icReceivable = dec(await movement(factory.id, fiscalPeriodId, { codes: ["1250"] }));
  const icPayable = dec(await movement(brand.id, fiscalPeriodId, { codes: ["2150"] })).negated();

  return {
    factory: factoryResult,
    brand: brandResult,
    ...result,
    openingUnrealised,
    closingUnrealised,
    /** The closing balance, lot by lot, as it stood at the end of the period. */
    unrealisedByLot: closingLots.map((l) => ({
      lotNumber: l.lotNumber,
      styleCode: l.styleCode ?? "—",
      sku: l.sku ?? "—",
      remainingQty: dec(l.qty).toString(),
      marginPerUnit: dec(l.margin).toString(),
      deferred: dec(l.qty).times(dec(l.margin)).toString(),
    })),
    intercompany: {
      receivable: icReceivable.toString(),
      payable: icPayable.toString(),
      ...intercompanyReconciliation(icReceivable, icPayable),
    },
  };
}
