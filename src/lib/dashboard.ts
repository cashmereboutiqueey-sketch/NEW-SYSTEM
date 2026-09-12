import "server-only";
import { db } from "./db";
import { cashConversionCycle, gmroi } from "@/core/working-capital";
import { agingProfile, type Lot } from "@/core/fifo";
import { groupProfitAndLoss } from "./consolidation";
import { apAging } from "./reports";
import { dec, safeDiv } from "./money";

/**
 * The owner's cockpit, assembled from the ledger and the stock records.
 *
 * Every tile here is derived, never stored, and each one can be opened on the
 * screen that owns it. A figure with nowhere to drill into is a figure nobody
 * can act on.
 */
export async function ownerDashboard(fiscalPeriodId: string | null = null) {
  const [factory, brand] = await Promise.all([
    db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } }),
    db.entity.findFirstOrThrow({ where: { kind: "BRAND" } }),
  ]);

  const group = await groupProfitAndLoss(fiscalPeriodId);

  // --- cash and near-cash --------------------------------------------
  const [cashRow] = await db.$queryRaw<{ balance: string }[]>`
    SELECT COALESCE(SUM(l."debit") - SUM(l."credit"), 0)::text AS balance
    FROM "journal_lines" l
    JOIN "journal_entries" e ON e."id" = l."journalEntryId"
    JOIN "accounts" a ON a."id" = l."accountId"
    WHERE e."status" = 'POSTED' AND a."reportingCategory" IN ('CASH', 'CASH_CLEARING')
  `;

  const [payableRow] = await db.$queryRaw<{ balance: string }[]>`
    SELECT COALESCE(SUM(l."credit") - SUM(l."debit"), 0)::text AS balance
    FROM "journal_lines" l
    JOIN "journal_entries" e ON e."id" = l."journalEntryId"
    JOIN "accounts" a ON a."id" = l."accountId"
    WHERE e."status" = 'POSTED' AND a."code" = '2110'
  `;

  // Past due across every open supplier item — deliveries as well as
  // expenses, which is where most of a factory's payables actually are.
  const payablesAging = await apAging();
  const overdueTotal = payablesAging.buckets.d1_30
    .plus(payablesAging.buckets.d31_60)
    .plus(payablesAging.buckets.d61_90)
    .plus(payablesAging.buckets.d90plus);

  // --- the factory's minute rate --------------------------------------
  const rate = await db.minuteRatePeriod.findFirst({
    where: { entityId: factory.id },
    include: { fiscalPeriod: true },
    orderBy: [{ fiscalPeriod: { year: "desc" } }, { fiscalPeriod: { month: "desc" } }],
  });

  // --- stock ------------------------------------------------------------
  // Summed in the database rather than by loading every lot: the answer is
  // three numbers, and the lot table grows with every receipt.
  const stateRows = await db.$queryRaw<{ state: string; value: string }[]>`
    SELECT "state"::text AS state,
           COALESCE(SUM("remainingQty" * "unitCost"), 0)::text AS value
    FROM "inventory_lots"
    WHERE "remainingQty" > 0
    GROUP BY "state"
  `;
  const stateValue = (state: string) =>
    dec(stateRows.find((r) => r.state === state)?.value ?? 0);

  const rawValue = stateValue("RAW_MATERIAL");
  // Returns held for repair are still finished goods on the books.
  const fgValue = stateValue("FINISHED_GOODS").plus(stateValue("AWAITING_REPAIR"));

  // Work in progress comes from the ledger. Issuing to a run posts the
  // material into WIP without creating a lot for it — a half-sewn dress is
  // not a thing on a shelf — so counting WIP lots showed nothing while the
  // books carried every metre on the cutting table.
  const [wipRow] = await db.$queryRaw<{ balance: string }[]>`
    SELECT COALESCE(SUM(l."debit") - SUM(l."credit"), 0)::text AS balance
    FROM "journal_lines" l
    JOIN "journal_entries" e ON e."id" = l."journalEntryId"
    JOIN "accounts" a ON a."id" = l."accountId"
    WHERE e."status" = 'POSTED' AND a."reportingCategory" = 'INVENTORY_WIP'
  `;
  const wipValue = dec(wipRow.balance);

  // The same figure rebuilt run by run: material issued to each open order,
  // less what its garments have relieved at standard. A closed run has had its
  // remainder cleared to variance, so only open ones carry any. If this and the
  // ledger disagree, something reached WIP without a run behind it.
  const [openRunsRow] = await db.$queryRaw<{ value: string }[]>`
    SELECT COALESCE(SUM(issued.value - COALESCE(po."actualQty", 0) * cs."materialCost"), 0)::text AS value
    FROM "production_orders" po
    JOIN "cost_snapshots" cs ON cs."id" = po."costSnapshotId"
    JOIN (
      SELECT "productionOrderId", SUM("actualQty" * "unitCost") AS value
      FROM "material_issues"
      GROUP BY "productionOrderId"
    ) issued ON issued."productionOrderId" = po."id"
    WHERE po."status" IN ('CONFIRMED', 'IN_PRODUCTION')
  `;
  const wipByRun = dec(openRunsRow.value);

  const stockValue = rawValue.plus(wipValue).plus(fgValue);

  const brandFgLots: Lot[] = (
    await db.inventoryLot.findMany({
      where: { remainingQty: { gt: 0 }, state: "FINISHED_GOODS", entityId: brand.id },
      select: { id: true, receivedDate: true, sequence: true, remainingQty: true, unitCost: true },
    })
  ).map((l) => ({
    id: l.id, receivedDate: l.receivedDate, sequence: l.sequence,
    remainingQty: l.remainingQty.toString(), unitCost: l.unitCost.toString(),
  }));
  const aging = agingProfile(brandFgLots, new Date());
  const deadStock = aging["90+"].value;

  // --- cash conversion cycle -------------------------------------------
  // Days come from settings until enough history exists to measure them; the
  // capital figure they produce is only as good as those assumptions, which is
  // why the dashboard shows the inputs beside the answer.
  const settingsRows = await db.setting.findMany({
    where: { key: { startsWith: "ccc." } },
  });
  const settingOf = (key: string, fallback: string) =>
    settingsRows.find((s) => s.key === key)?.value ?? fallback;

  const monthlyCogs = dec(group.groupCogs);
  const ccc = cashConversionCycle(
    {
      rawMaterialDays: settingOf("ccc.rawMaterialDays", "30"),
      productionLeadDays: settingOf("ccc.productionLeadDays", "21"),
      finishedGoodsDays: settingOf("ccc.finishedGoodsDays", "45"),
      collectionDays: settingOf("ccc.collectionDays", "14"),
      supplierCreditDays: settingOf("ccc.supplierCreditDays", "35"),
    },
    monthlyCogs,
  );

  // --- sales -------------------------------------------------------------
  // Net of returns, and taken from the ledger rather than the order totals.
  // An order's total is what was sold on the day; a dress sold and then
  // brought back was still counted there, at full revenue and full margin,
  // after the money had gone back to the customer.
  //
  //   net sales = goods revenue − discounts − returns
  //   cost      = brand cost of goods, less what returns put back
  const [salesRow] = await db.$queryRaw<{ revenue: string; discounts: string; returns: string; cogs: string }[]>`
    SELECT
      COALESCE(SUM(CASE WHEN a."code" IN ('4110','4120','4130','4140','4150')
                        THEN l."credit" - l."debit" END), 0)::text AS revenue,
      COALESCE(SUM(CASE WHEN a."code" = '4200' THEN l."debit" - l."credit" END), 0)::text AS discounts,
      COALESCE(SUM(CASE WHEN a."code" = '4210' THEN l."debit" - l."credit" END), 0)::text AS returns,
      COALESCE(SUM(CASE WHEN a."code" = '5300' THEN l."debit" - l."credit" END), 0)::text AS cogs
    FROM "journal_lines" l
    JOIN "journal_entries" e ON e."id" = l."journalEntryId"
    JOIN "accounts" a ON a."id" = l."accountId"
    WHERE e."status" = 'POSTED' AND a."code" IN ('4110','4120','4130','4140','4150','4200','4210','5300')
  `;
  const salesReturns = dec(salesRow.returns);
  const salesRevenue = dec(salesRow.revenue).minus(dec(salesRow.discounts)).minus(salesReturns);
  const salesCogs = dec(salesRow.cogs);

  const [unitsRow] = await db.$queryRaw<{ orders: number; sold: string; returned: string }[]>`
    SELECT
      (SELECT COUNT(*)::int FROM "sales_orders" WHERE "status" <> 'CANCELLED') AS orders,
      (SELECT COALESCE(SUM(sl."quantity"), 0)::text
         FROM "sales_order_lines" sl
         JOIN "sales_orders" so ON so."id" = sl."salesOrderId"
        WHERE so."status" <> 'CANCELLED') AS sold,
      (SELECT COALESCE(SUM("quantity"), 0)::text FROM "returns") AS returned
  `;
  const unitsSold = Number(unitsRow.sold) - Number(unitsRow.returned);

  const [marketingRow] = await db.$queryRaw<{ spend: string }[]>`
    SELECT COALESCE(SUM(l."debit") - SUM(l."credit"), 0)::text AS spend
    FROM "journal_lines" l
    JOIN "journal_entries" e ON e."id" = l."journalEntryId"
    JOIN "accounts" a ON a."id" = l."accountId"
    WHERE e."status" = 'POSTED' AND a."reportingCategory" = 'MARKETING'
  `;

  const grossMargin = salesRevenue.minus(salesCogs);
  const marketingSpend = dec(marketingRow.spend);

  return {
    cash: dec(cashRow.balance),
    payables: dec(payableRow.balance),
    overduePayables: overdueTotal,

    minuteRate: rate
      ? {
          period: `${rate.fiscalPeriod.year}-${String(rate.fiscalPeriod.month).padStart(2, "0")}`,
          actual: rate.actualMinuteRate.toString(),
          fullCapacity: rate.fullCapacityMinuteRate.toString(),
          idlePenalty: rate.idlePenaltyPerMinute.toString(),
          idleMinutes: rate.idleMinutes.toString(),
          status: rate.status,
        }
      : null,

    stock: {
      raw: rawValue,
      wip: wipValue,
      /** WIP rebuilt from open runs; differs from `wip` only if something is wrong. */
      wipByRun,
      finishedGoods: fgValue,
      total: stockValue,
    },
    aging,
    deadStock,

    ccc,
    monthlyCogs,

    sales: {
      revenue: salesRevenue,
      cogs: salesCogs,
      grossMargin,
      grossMarginPct: safeDiv(grossMargin, salesRevenue),
      returns: salesReturns,
      unitsSold,
      orders: unitsRow.orders,
    },

    marketing: {
      spend: marketingSpend,
      profitAfterMarketing: grossMargin.minus(marketingSpend),
      // Return on ad spend measured against margin, not revenue: revenue-based
      // ROAS can look healthy on a product that loses money per unit.
      contributionRoas: safeDiv(grossMargin, marketingSpend),
    },

    group: {
      factoryProfit: group.factoryProfit,
      brandProfit: group.brandProfit,
      groupProfit: group.groupProfit,
      unrealised: group.closingUnrealised,
      intercompanyMatched: group.intercompany.matched,
    },

    gmroi: gmroi(grossMargin, fgValue),
  };
}
