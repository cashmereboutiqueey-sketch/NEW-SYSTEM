import "server-only";
import { db } from "./db";
import { dec } from "./money";
import { simulate, compare, type Baseline, type Assumptions } from "@/core/scenario";
import { writeAudit, type AuditContext } from "./audit";

/**
 * What-if, drawn from a real month.
 *
 * The baseline is measured, never typed: the conversion pool comes from posted
 * accounts, the capacity from the minute-rate period, the discount from what
 * was actually given away. Only the assumptions are hypothetical, and each one
 * is recorded with its result so a scenario can be re-read months later and
 * still mean something.
 */

export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioError";
  }
}

/** Reads a month's real figures to simulate against. */
export async function buildBaseline(fiscalPeriodId?: string): Promise<{
  baseline: Baseline;
  periodId: string;
  periodLabel: string;
}> {
  const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });
  const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });

  const rate = fiscalPeriodId
    ? await db.minuteRatePeriod.findFirst({
        where: { entityId: factory.id, fiscalPeriodId },
        include: { fiscalPeriod: true },
      })
    : await db.minuteRatePeriod.findFirst({
        where: { entityId: factory.id },
        include: { fiscalPeriod: true },
        orderBy: { calculatedAt: "desc" },
      });

  if (!rate) {
    throw new ScenarioError(
      "There is no calculated minute rate to simulate against. Work one out first.",
    );
  }

  const period = rate.fiscalPeriod;
  const from = period.startDate;
  const to = period.endDate;

  const [orders, snapshot, brandFixedRows, marketing, styleAvg] = await Promise.all([
    db.salesOrder.findMany({
      where: { entityId: brand.id, orderDate: { gte: from, lte: to } },
      include: { lines: true },
    }),
    db.costSnapshot.findFirst({
      where: { minuteRatePeriodId: rate.id },
      orderBy: { createdAt: "desc" },
    }),
    db.$queryRaw<{ total: string }[]>`
      SELECT COALESCE(SUM(l."debit") - SUM(l."credit"), 0)::text AS total
      FROM "journal_lines" l
      JOIN "journal_entries" e ON e."id" = l."journalEntryId"
      JOIN "accounts" a ON a."id" = l."accountId"
      WHERE a."includeInBrandFixedPool" = true
        AND e."status" = 'POSTED'
        AND l."entityId" = ${brand.id}
        AND e."postingDate" BETWEEN ${from} AND ${to}
    `,
    db.campaignSpend.aggregate({
      where: { spendDate: { gte: from, lte: to } },
      _sum: { amount: true },
    }),
    db.style.aggregate({ _avg: { retailPrice: true, totalSmvMinutes: true } }),
  ]);

  const lines = orders.flatMap((o) => o.lines);
  const unitsSold = lines.reduce((s, l) => s + l.quantity, 0);
  const cogs = lines.reduce((s, l) => s.plus(dec(l.lineCost)), dec(0));

  // Weighted by units, so one heavily discounted order does not set the tone
  // for the month.
  const discountRate =
    unitsSold > 0
      ? lines
          .reduce((s, l) => s.plus(dec(l.discountPct).times(l.quantity)), dec(0))
          .div(unitsSold)
      : dec(0);

  const retailPrice =
    unitsSold > 0
      ? lines.reduce((s, l) => s.plus(dec(l.retailPrice).times(l.quantity)), dec(0)).div(unitsSold)
      : dec(styleAvg._avg.retailPrice ?? 0);

  const settings = await db.setting.findMany({
    where: {
      key: {
        in: [
          "brand.packagingPerUnit",
          "brand.shippingPerUnit",
          "brand.returnRate",
          "factory.margin.default",
        ],
      },
    },
  });
  const setting = (key: string, fallback: string) =>
    dec(settings.find((s) => s.key === key)?.value ?? fallback);

  return {
    periodId: period.id,
    periodLabel: `${period.year}-${String(period.month).padStart(2, "0")}`,
    baseline: {
      conversionCost: dec(rate.netCostPool),
      // Material is what the sold garments actually cost, which is the figure
      // the ledger relieved rather than a purchasing total.
      materialCost: cogs,
      grossAvailableMinutes: dec(rate.grossAvailableMinutes),
      utilisationRate: dec(rate.utilisationRate),
      efficiencyRate: dec(rate.efficiencyRate),
      smvPerUnit: snapshot ? dec(snapshot.smvMinutes) : dec(styleAvg._avg.totalSmvMinutes ?? 33),
      unitsSold,
      retailPrice,
      discountRate,
      returnRate: setting("brand.returnRate", "0.08"),
      factoryMarginPct: snapshot
        ? dec(snapshot.factoryMarginPct)
        : setting("factory.margin.default", "0.18"),
      brandFixedCosts: dec(brandFixedRows[0]?.total ?? 0),
      marketingSpend: dec(marketing._sum.amount ?? 0),
      variableSellingCostPerUnit: setting("brand.packagingPerUnit", "0").plus(
        setting("brand.shippingPerUnit", "0"),
      ),
    },
  };
}

/** Runs a set of assumptions and stores what came out. */
export async function runScenario(
  input: {
    name: string;
    descriptionEn?: string | null;
    descriptionAr?: string | null;
    assumptions: Assumptions;
    fiscalPeriodId?: string;
  },
  ctx: AuditContext,
): Promise<{ scenarioId: string; periodLabel: string }> {
  if (!input.name.trim()) throw new ScenarioError("A scenario needs a name to be worth keeping.");

  const { baseline, periodId, periodLabel } = await buildBaseline(input.fiscalPeriodId);

  const before = simulate(baseline);
  const after = simulate(baseline, input.assumptions);
  const rows = compare(before, after);

  const scenario = await db.$transaction(async (tx) => {
    const created = await tx.scenario.create({
      data: {
        name: input.name.trim(),
        descriptionEn: input.descriptionEn ?? null,
        descriptionAr: input.descriptionAr ?? null,
        createdByUserId: ctx.userId,
        assumptions: input.assumptions as never,
        baselinePeriodId: periodId,
        results: {
          create: rows.map((r, i) => ({
            metricKey: r.metricKey,
            labelEn: r.labelEn,
            labelAr: r.labelAr,
            baseline: r.baseline.toDecimalPlaces(4).toString(),
            simulated: r.simulated.toDecimalPlaces(4).toString(),
            delta: r.delta.toDecimalPlaces(4).toString(),
            deltaPct: r.deltaPct ? r.deltaPct.toDecimalPlaces(6).toString() : null,
            unit: r.unit,
            sortOrder: i,
          })),
        },
      },
    });

    await writeAudit(tx, {
      action: "SCENARIO_RUN",
      entityName: "Scenario",
      entityId: created.id,
      after: {
        name: created.name,
        period: periodLabel,
        assumptions: input.assumptions,
        groupProfitBefore: before.groupProfit.toString(),
        groupProfitAfter: after.groupProfit.toString(),
      },
      ctx,
    });

    return created;
  });

  return { scenarioId: scenario.id, periodLabel };
}

export async function recentScenarios(limit = 20) {
  return db.scenario.findMany({
    include: {
      results: { orderBy: { sortOrder: "asc" } },
      createdBy: true,
    },
    orderBy: [{ isPinned: "desc" }, { createdAt: "desc" }],
    take: limit,
  });
}

export async function deleteScenario(scenarioId: string, ctx: AuditContext): Promise<void> {
  const scenario = await db.scenario.findUnique({ where: { id: scenarioId } });
  if (!scenario) throw new ScenarioError("That scenario has already gone.");

  await db.$transaction(async (tx) => {
    await tx.scenario.delete({ where: { id: scenarioId } });
    await writeAudit(tx, {
      action: "SCENARIO_DELETED",
      entityName: "Scenario",
      entityId: scenarioId,
      before: { name: scenario.name, assumptions: scenario.assumptions },
      ctx,
    });
  });
}
