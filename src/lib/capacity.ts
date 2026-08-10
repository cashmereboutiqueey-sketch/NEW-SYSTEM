import "server-only";
import { db } from "./db";
import { dec } from "./money";
import { writeAudit, type AuditContext } from "./audit";

/**
 * The capacity configuration — the input the whole costing spine rests on.
 *
 * Operators, days, hours, utilisation and efficiency together decide how many
 * productive minutes a month has, and therefore what a minute costs and what
 * every garment costs. Getting these wrong moves every price in the business,
 * which is why each change is written to the audit log with its old value
 * beside the new one.
 *
 * A period whose minute rate is locked cannot be re-configured: the rate has
 * already priced production orders, and changing its inputs afterwards would
 * silently restate margins that have been reported.
 */

export class CapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapacityError";
  }
}

export async function setCapacity(
  input: {
    entityId: string;
    fiscalPeriodId: string;
    operators: number;
    workingDays: string;
    hoursPerDay: string;
    utilisationRate: string;
    efficiencyRate: string;
    notes?: string | null;
  },
  ctx: AuditContext,
): Promise<{ capacityConfigId: string; grossMinutes: string; productiveMinutes: string }> {
  const operators = Math.trunc(input.operators);
  const workingDays = dec(input.workingDays);
  const hoursPerDay = dec(input.hoursPerDay);
  const utilisation = dec(input.utilisationRate);
  const efficiency = dec(input.efficiencyRate);

  if (operators <= 0) throw new CapacityError("A factory needs at least one operator.");
  if (workingDays.lessThanOrEqualTo(0) || workingDays.greaterThan(31)) {
    throw new CapacityError("Working days must be between 1 and 31.");
  }
  if (hoursPerDay.lessThanOrEqualTo(0) || hoursPerDay.greaterThan(24)) {
    throw new CapacityError("Hours per day must be between 1 and 24.");
  }
  for (const [name, rate] of [
    ["Utilisation", utilisation],
    ["Efficiency", efficiency],
  ] as const) {
    if (rate.lessThanOrEqualTo(0) || rate.greaterThan(1)) {
      // Stored as a fraction. Someone typing 85 instead of 0.85 would divide
      // the minute rate by a hundred and make every garment look free.
      throw new CapacityError(`${name} is a fraction between 0 and 1 — 85% is 0.85, not 85.`);
    }
  }

  const locked = await db.minuteRatePeriod.findFirst({
    where: { entityId: input.entityId, fiscalPeriodId: input.fiscalPeriodId, status: "LOCKED" },
  });
  if (locked) {
    throw new CapacityError(
      "This period's minute rate is locked. Changing its inputs now would restate margins already reported against it.",
    );
  }

  const existing = await db.capacityConfig.findFirst({
    where: { entityId: input.entityId, fiscalPeriodId: input.fiscalPeriodId, lineId: null },
  });

  const data = {
    operators,
    workingDays: workingDays.toString(),
    hoursPerDay: hoursPerDay.toString(),
    utilisationRate: utilisation.toString(),
    efficiencyRate: efficiency.toString(),
    notes: input.notes ?? null,
  };

  const config = await db.$transaction(async (tx) => {
    const saved = existing
      ? await tx.capacityConfig.update({ where: { id: existing.id }, data })
      : await tx.capacityConfig.create({
          data: {
            ...data,
            entityId: input.entityId,
            fiscalPeriodId: input.fiscalPeriodId,
            lineId: null,
          },
        });

    await writeAudit(tx, {
      action: existing ? "CAPACITY_CHANGED" : "CAPACITY_SET",
      entityName: "CapacityConfig",
      entityId: saved.id,
      before: existing
        ? {
            operators: existing.operators,
            workingDays: existing.workingDays.toString(),
            hoursPerDay: existing.hoursPerDay.toString(),
            utilisationRate: existing.utilisationRate.toString(),
            efficiencyRate: existing.efficiencyRate.toString(),
          }
        : undefined,
      after: data,
      ctx,
    });

    return saved;
  });

  const gross = dec(operators).times(workingDays).times(hoursPerDay).times(60);

  return {
    capacityConfigId: config.id,
    grossMinutes: gross.toString(),
    productiveMinutes: gross.times(utilisation).times(efficiency).toString(),
  };
}

/** Periods that can still be configured, with whatever is set on them now. */
export async function configurablePeriods(entityId: string) {
  const periods = await db.fiscalPeriod.findMany({
    orderBy: [{ year: "desc" }, { month: "desc" }],
    take: 18,
  });

  const [configs, rates] = await Promise.all([
    db.capacityConfig.findMany({
      where: { entityId, fiscalPeriodId: { in: periods.map((p) => p.id) }, lineId: null },
    }),
    db.minuteRatePeriod.findMany({
      where: { entityId, fiscalPeriodId: { in: periods.map((p) => p.id) } },
    }),
  ]);

  return periods.map((period) => {
    const config = configs.find((c) => c.fiscalPeriodId === period.id);
    const rate = rates.find((r) => r.fiscalPeriodId === period.id);

    return {
      fiscalPeriodId: period.id,
      label: `${period.year}-${String(period.month).padStart(2, "0")}`,
      periodStatus: period.status,
      rateStatus: rate?.status ?? null,
      // A locked rate seals its inputs too, or the two stop agreeing.
      editable: rate?.status !== "LOCKED" && period.status !== "CLOSED",
      operators: config?.operators ?? null,
      workingDays: config ? dec(config.workingDays) : null,
      hoursPerDay: config ? dec(config.hoursPerDay) : null,
      utilisationRate: config ? dec(config.utilisationRate) : null,
      efficiencyRate: config ? dec(config.efficiencyRate) : null,
      notes: config?.notes ?? null,
    };
  });
}
