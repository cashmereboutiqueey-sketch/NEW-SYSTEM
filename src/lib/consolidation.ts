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

export async function groupProfitAndLoss(fiscalPeriodId: string | null = null) {
  const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });
  const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });

  const [factoryResult, brandResult] = await Promise.all([
    readEntityResult(factory.id, fiscalPeriodId),
    readEntityResult(brand.id, fiscalPeriodId),
  ]);

  // Every Brand lot that came from a transfer and is still on the shelf.
  const brandLots = await db.inventoryLot.findMany({
    where: {
      entityId: brand.id,
      state: "FINISHED_GOODS",
      remainingQty: { gt: 0 },
      transferMarginPerUnit: { not: null },
    },
    include: { variant: { include: { style: true } } },
  });

  const closingUnrealised = unrealisedProfitInStock(
    brandLots.map((l) => ({
      remainingQty: l.remainingQty.toString(),
      transferMarginPerUnit: l.transferMarginPerUnit?.toString() ?? null,
    })),
  );

  // Opening is not yet stored per period, so the first period reports the full
  // closing balance as this period's deferral. Once a period is closed the
  // stored balance becomes the next period's opening.
  const opening = dec(0);

  const result = consolidate(factoryResult, brandResult, {
    opening,
    closing: closingUnrealised,
  });

  const icReceivable = dec(await movement(factory.id, fiscalPeriodId, { codes: ["1250"] }));
  const icPayable = dec(await movement(brand.id, fiscalPeriodId, { codes: ["2150"] })).negated();

  return {
    factory: factoryResult,
    brand: brandResult,
    ...result,
    closingUnrealised,
    unrealisedByLot: brandLots.map((l) => ({
      lotNumber: l.lotNumber,
      styleCode: l.variant?.style.code ?? "—",
      sku: l.variant?.sku ?? "—",
      remainingQty: l.remainingQty.toString(),
      marginPerUnit: l.transferMarginPerUnit?.toString() ?? "0",
      deferred: dec(l.remainingQty).times(dec(l.transferMarginPerUnit ?? 0)).toString(),
    })),
    intercompany: {
      receivable: icReceivable.toString(),
      payable: icPayable.toString(),
      ...intercompanyReconciliation(icReceivable, icPayable),
    },
  };
}
