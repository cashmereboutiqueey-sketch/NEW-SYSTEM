import "server-only";
import { db } from "./db";
import { cashConversionCycle, gmroi } from "@/core/working-capital";
import { agingProfile, type Lot } from "@/core/fifo";
import { groupProfitAndLoss } from "./consolidation";
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

  const overdue = await db.expense.findMany({
    where: { status: { in: ["UNPAID", "PARTIALLY_PAID"] }, dueDate: { lt: new Date() } },
    select: { amount: true, paidAmount: true },
  });
  const overdueTotal = overdue.reduce(
    (s, e) => s.plus(dec(e.amount).minus(dec(e.paidAmount))), dec(0),
  );

  // --- the factory's minute rate --------------------------------------
  const rate = await db.minuteRatePeriod.findFirst({
    where: { entityId: factory.id },
    include: { fiscalPeriod: true },
    orderBy: [{ fiscalPeriod: { year: "desc" } }, { fiscalPeriod: { month: "desc" } }],
  });

  // --- stock ------------------------------------------------------------
  const lots = await db.inventoryLot.findMany({
    where: { remainingQty: { gt: 0 } },
    select: {
      id: true, state: true, entityId: true, receivedDate: true, sequence: true,
      remainingQty: true, unitCost: true,
    },
  });

  const valueOf = (filter: (l: (typeof lots)[number]) => boolean) =>
    lots.filter(filter).reduce(
      (s, l) => s.plus(dec(l.remainingQty).times(dec(l.unitCost))), dec(0),
    );

  const rawValue = valueOf((l) => l.state === "RAW_MATERIAL");
  const wipValue = valueOf((l) => l.state === "WIP");
  const fgValue = valueOf((l) => l.state === "FINISHED_GOODS");
  const stockValue = rawValue.plus(wipValue).plus(fgValue);

  const brandFgLots: Lot[] = lots
    .filter((l) => l.state === "FINISHED_GOODS" && l.entityId === brand.id)
    .map((l) => ({
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
  const orders = await db.salesOrder.findMany({
    where: { status: { not: "CANCELLED" } },
    select: { netAmount: true, cogsAmount: true, source: true, lines: { select: { quantity: true } } },
  });
  const salesRevenue = orders.reduce((s, o) => s.plus(dec(o.netAmount)), dec(0));
  const salesCogs = orders.reduce((s, o) => s.plus(dec(o.cogsAmount)), dec(0));
  const unitsSold = orders.reduce(
    (s, o) => s + o.lines.reduce((t, l) => t + l.quantity, 0), 0,
  );

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

    stock: { raw: rawValue, wip: wipValue, finishedGoods: fgValue, total: stockValue },
    aging,
    deadStock,

    ccc,
    monthlyCogs,

    sales: {
      revenue: salesRevenue,
      cogs: salesCogs,
      grossMargin,
      grossMarginPct: safeDiv(grossMargin, salesRevenue),
      unitsSold,
      orders: orders.length,
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
