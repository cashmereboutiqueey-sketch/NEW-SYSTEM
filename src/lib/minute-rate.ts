import "server-only";
import { db } from "./db";
import { writeAudit, type AuditContext } from "./audit";
import { calculateMinuteRate } from "@/core/minute-rate";
import { dec } from "./money";

/**
 * Builds a `MinuteRatePeriod` from what is actually in the books.
 *
 * The cost pool is read from the general ledger — every posted debit to an
 * account flagged `includeInMinuteRate` — rather than from the expense table.
 * That way payroll, depreciation and accruals all reach the pool no matter
 * which subledger produced them, and the pool always reconciles to the P&L.
 *
 * Materials and finance costs are excluded by their account flags. Fabric is
 * costed directly into each style, so letting it into the minute rate would
 * charge it to every garment a second time.
 */

export class MinuteRateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MinuteRateError";
  }
}

export type MinuteRateBreakdown = {
  accountCode: string;
  accountName: string;
  amount: string;
  lineCount: number;
};

/**
 * Reads the conversion cost pool for one entity and period, broken down by
 * account so the resulting rate can be drilled into.
 *
 * Credits are subtracted, not ignored: a reversal or a credit note against a
 * conversion account genuinely reduces the pool, and dropping it would leave
 * the rate overstated with no visible cause.
 */
export async function readCostPool(
  entityId: string,
  fiscalPeriodId: string,
): Promise<{ total: string; components: MinuteRateBreakdown[] }> {
  const rows = await db.$queryRaw<
    { code: string; nameEn: string; nameAr: string; amount: string; lineCount: bigint }[]
  >`
    SELECT a."code", a."nameEn", a."nameAr",
           COALESCE(SUM(l."debit") - SUM(l."credit"), 0)::text AS amount,
           COUNT(*) AS "lineCount"
    FROM "journal_lines" l
    JOIN "journal_entries" e ON e."id" = l."journalEntryId"
    JOIN "accounts" a ON a."id" = l."accountId"
    WHERE e."status" = 'POSTED'
      AND e."fiscalPeriodId" = ${fiscalPeriodId}
      AND l."entityId" = ${entityId}
      AND a."includeInMinuteRate" = true
    GROUP BY a."code", a."nameEn", a."nameAr"
    ORDER BY a."code"
  `;

  const components = rows.map((r) => ({
    accountCode: r.code,
    accountName: r.nameEn,
    // Normalised through Decimal so components and the total are formatted
    // the same way; Postgres returns numerics with trailing zeros.
    amount: dec(r.amount).toString(),
    lineCount: Number(r.lineCount),
  }));

  const total = components
    .reduce((sum, c) => sum.plus(dec(c.amount)), dec(0))
    .toString();

  return { total, components };
}

/**
 * Calculates and stores the minute rate for one entity and period.
 *
 * A locked period is never recomputed: production orders costed against it
 * hold its rate permanently, and rewriting it would retroactively change
 * margins that have already been reported.
 */
export async function calculatePeriodMinuteRate(
  input: { entityId: string; fiscalPeriodId: string; cmtRevenueCredit?: string },
  ctx: AuditContext,
): Promise<{ minuteRatePeriodId: string; actualMinuteRate: string | null }> {
  return db.$transaction(async (tx) => {
    const existing = await tx.minuteRatePeriod.findUnique({
      where: {
        entityId_fiscalPeriodId: {
          entityId: input.entityId,
          fiscalPeriodId: input.fiscalPeriodId,
        },
      },
    });

    if (existing?.status === "LOCKED") {
      throw new MinuteRateError(
        "This period's minute rate is locked. Recalculating it would change margins already reported against it.",
      );
    }

    const capacity = await tx.capacityConfig.findFirst({
      // The factory-wide row, not a per-line one.
      where: { entityId: input.entityId, fiscalPeriodId: input.fiscalPeriodId, lineId: null },
    });
    if (!capacity) {
      throw new MinuteRateError(
        "No factory-wide capacity configuration exists for this period. Set operators, working days, hours, utilisation and efficiency first.",
      );
    }

    const pool = await readCostPool(input.entityId, input.fiscalPeriodId);

    const result = calculateMinuteRate(
      {
        operators: capacity.operators,
        workingDays: capacity.workingDays.toString(),
        hoursPerDay: capacity.hoursPerDay.toString(),
        utilisationRate: capacity.utilisationRate.toString(),
        efficiencyRate: capacity.efficiencyRate.toString(),
      },
      {
        grossCostPool: pool.total,
        cmtRevenueCredit: input.cmtRevenueCredit ?? "0",
      },
    );

    // Stored as inputs copied in, not referenced, so the row stays meaningful
    // even if the capacity configuration is later edited.
    const data = {
      entityId: input.entityId,
      fiscalPeriodId: input.fiscalPeriodId,
      status: "PROVISIONAL" as const,
      operators: capacity.operators,
      workingDays: capacity.workingDays,
      hoursPerDay: capacity.hoursPerDay,
      utilisationRate: capacity.utilisationRate,
      efficiencyRate: capacity.efficiencyRate,
      totalConversionCost: result.grossCostPool.toString(),
      cmtRevenueCredit: result.cmtRevenueCredit.toString(),
      netCostPool: result.netCostPool.toString(),
      grossAvailableMinutes: result.grossAvailableMinutes.toString(),
      productiveMinutes: result.productiveMinutes.toString(),
      actualMinuteRate: result.actualMinuteRate?.toString() ?? "0",
      fullCapacityMinuteRate: result.fullCapacityMinuteRate?.toString() ?? "0",
      idlePenaltyPerMinute: result.idlePenaltyPerMinute?.toString() ?? "0",
      idleMinutes: result.idleMinutes.toString(),
      calculatedAt: new Date(),
    };

    const period = existing
      ? await tx.minuteRatePeriod.update({ where: { id: existing.id }, data })
      : await tx.minuteRatePeriod.create({ data });

    // Components are replaced wholesale — they are a snapshot of this
    // calculation, not an accumulating log.
    await tx.minuteRateComponent.deleteMany({ where: { minuteRatePeriodId: period.id } });
    if (pool.components.length > 0) {
      await tx.minuteRateComponent.createMany({
        data: pool.components.map((c) => ({
          minuteRatePeriodId: period.id,
          costCategoryCode: c.accountCode,
          costCategoryName: c.accountName,
          amount: c.amount,
          expenseCount: c.lineCount,
        })),
      });
    }

    await writeAudit(tx, {
      action: existing ? "MINUTE_RATE_RECALCULATED" : "MINUTE_RATE_CALCULATED",
      entityName: "MinuteRatePeriod",
      entityId: period.id,
      before: existing
        ? { actualMinuteRate: existing.actualMinuteRate.toString() }
        : undefined,
      after: {
        netCostPool: result.netCostPool.toString(),
        productiveMinutes: result.productiveMinutes.toString(),
        actualMinuteRate: result.actualMinuteRate?.toString() ?? null,
        fullCapacityMinuteRate: result.fullCapacityMinuteRate?.toString() ?? null,
        components: pool.components.length,
      },
      ctx,
    });

    return {
      minuteRatePeriodId: period.id,
      actualMinuteRate: result.actualMinuteRate?.toString() ?? null,
    };
  });
}

/**
 * Seals a period's rate. After this, production orders costed against it can
 * never have their basis rewritten.
 */
export async function lockMinuteRatePeriod(
  minuteRatePeriodId: string,
  ctx: AuditContext,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const period = await tx.minuteRatePeriod.findUnique({ where: { id: minuteRatePeriodId } });
    if (!period) throw new MinuteRateError("Minute rate period not found.");
    if (period.status === "LOCKED") throw new MinuteRateError("This period is already locked.");

    await tx.minuteRatePeriod.update({
      where: { id: minuteRatePeriodId },
      data: { status: "LOCKED", lockedAt: new Date() },
    });

    await writeAudit(tx, {
      action: "MINUTE_RATE_LOCKED",
      entityName: "MinuteRatePeriod",
      entityId: minuteRatePeriodId,
      before: { status: period.status },
      after: { status: "LOCKED", actualMinuteRate: period.actualMinuteRate.toString() },
      ctx,
    });
  });
}
