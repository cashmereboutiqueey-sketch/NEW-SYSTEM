import "server-only";
import { db } from "./db";
import { dec, safeDiv, type Decimal } from "./money";
import { lineEfficiency } from "@/core/production";

/**
 * What the shop floor is actually doing.
 *
 * Utilisation and efficiency are kept apart throughout, because they are
 * different problems with different cures. Utilisation is whether the line had
 * work — that is a sales problem. Efficiency is what the line did with the
 * hours it was paid for — that is a floor problem. A line can run at 100%
 * efficiency and still stand idle half the month.
 */

/** Booked minutes against available minutes, per period. */
export async function capacityPicture(entityId: string) {
  const periods = await db.minuteRatePeriod.findMany({
    where: { entityId },
    include: { fiscalPeriod: true },
    orderBy: { calculatedAt: "desc" },
    take: 12,
  });

  // Bookings carry the period id without a relation, so they are read
  // separately and matched up here.
  const allBookings = await db.capacityBooking.findMany({
    where: { fiscalPeriodId: { in: periods.map((p) => p.fiscalPeriodId) } },
    include: {
      productionOrder: { include: { style: true } },
      cmtOrder: { include: { client: true } },
    },
  });

  return periods.map((period) => {
    const bookings = allBookings.filter((b) => b.fiscalPeriodId === period.fiscalPeriodId);
    const booked = bookings.reduce((s, b) => s.plus(dec(b.minutes)), dec(0));
    const gross = dec(period.grossAvailableMinutes);

    return {
      id: period.id,
      status: period.status,
      label: `${period.fiscalPeriod.year}-${String(period.fiscalPeriod.month).padStart(2, "0")}`,
      operators: period.operators,
      workingDays: dec(period.workingDays),
      hoursPerDay: dec(period.hoursPerDay),
      utilisationRate: dec(period.utilisationRate),
      efficiencyRate: dec(period.efficiencyRate),
      grossMinutes: gross,
      productiveMinutes: dec(period.productiveMinutes),
      bookedMinutes: booked,
      idleMinutes: dec(period.idleMinutes),
      // Against gross, not productive: the question is how much of the factory
      // the orders on the books actually fill.
      bookedShare: safeDiv(booked, gross),
      freeMinutes: gross.minus(booked),
      actualMinuteRate: dec(period.actualMinuteRate),
      fullCapacityMinuteRate: dec(period.fullCapacityMinuteRate),
      idlePenaltyPerMinute: dec(period.idlePenaltyPerMinute),
      costPool: dec(period.netCostPool),
      bookings: bookings.map((b) => ({
        id: b.id,
        source: b.source,
        minutes: dec(b.minutes),
        labelEn: b.productionOrder
          ? `${b.productionOrder.orderNumber} · ${b.productionOrder.style.nameEn}`
          : b.cmtOrder
            ? `${b.cmtOrder.orderNumber} · ${b.cmtOrder.client.name}`
            : (b.notes ?? "—"),
        labelAr: b.productionOrder
          ? `${b.productionOrder.orderNumber} · ${b.productionOrder.style.nameAr}`
          : b.cmtOrder
            ? `${b.cmtOrder.orderNumber} · ${b.cmtOrder.client.name}`
            : (b.notes ?? "—"),
      })),
    };
  });
}

/**
 * Efficiency by line and by stage.
 *
 * Earned minutes over minutes clocked. Where the two diverge is where the run
 * is being lost, and naming the stage is the difference between "the order was
 * late" and "the sewing line ran at 62%".
 */
export async function lineEfficiencyReport(sinceDays = 90) {
  const since = new Date();
  since.setDate(since.getDate() - sinceDays);

  const logs = await db.productionStageLog.findMany({
    where: { logDate: { gte: since } },
    include: {
      line: true,
      productionOrder: { include: { style: true } },
    },
    orderBy: { logDate: "desc" },
  });

  const byLine = new Map<
    string,
    {
      id: string;
      nameEn: string;
      nameAr: string;
      earned: Decimal;
      clocked: Decimal;
      qtyOut: number;
      qtyIn: number;
      entries: number;
    }
  >();

  const byStage = new Map<
    string,
    { stage: string; earned: Decimal; clocked: Decimal; qtyIn: number; qtyOut: number }
  >();

  for (const log of logs) {
    const lineKey = log.lineId ?? "unassigned";
    const line = byLine.get(lineKey) ?? {
      id: lineKey,
      nameEn: log.line?.nameEn ?? "Unassigned",
      nameAr: log.line?.nameAr ?? "بدون خط",
      earned: dec(0),
      clocked: dec(0),
      qtyOut: 0,
      qtyIn: 0,
      entries: 0,
    };
    line.earned = line.earned.plus(dec(log.earnedMinutes));
    line.clocked = line.clocked.plus(dec(log.clockedMinutes));
    line.qtyOut += log.qtyOut;
    line.qtyIn += log.qtyIn;
    line.entries++;
    byLine.set(lineKey, line);

    const stage = byStage.get(log.stage) ?? {
      stage: log.stage,
      earned: dec(0),
      clocked: dec(0),
      qtyIn: 0,
      qtyOut: 0,
    };
    stage.earned = stage.earned.plus(dec(log.earnedMinutes));
    stage.clocked = stage.clocked.plus(dec(log.clockedMinutes));
    stage.qtyIn += log.qtyIn;
    stage.qtyOut += log.qtyOut;
    byStage.set(log.stage, stage);
  }

  return {
    lines: [...byLine.values()]
      .map((l) => ({
        ...l,
        efficiency: lineEfficiency(l.earned, l.clocked),
        // Pieces lost between going into the stage and coming out of it.
        dropOut: l.qtyIn - l.qtyOut,
        yieldRate: l.qtyIn > 0 ? dec(l.qtyOut).div(l.qtyIn) : null,
      }))
      .sort((a, b) => Number((a.efficiency ?? dec(0)).minus(b.efficiency ?? dec(0)))),
    stages: [...byStage.values()]
      .map((s) => ({
        ...s,
        efficiency: lineEfficiency(s.earned, s.clocked),
        dropOut: s.qtyIn - s.qtyOut,
      }))
      .sort((a, b) => Number((a.efficiency ?? dec(0)).minus(b.efficiency ?? dec(0)))),
    recent: logs.slice(0, 60).map((log) => ({
      id: log.id,
      date: log.logDate,
      stage: log.stage,
      lineEn: log.line?.nameEn ?? "—",
      lineAr: log.line?.nameAr ?? "—",
      orderNumber: log.productionOrder.orderNumber,
      styleEn: log.productionOrder.style.nameEn,
      styleAr: log.productionOrder.style.nameAr,
      qtyIn: log.qtyIn,
      qtyOut: log.qtyOut,
      operators: log.operatorsCount,
      clocked: dec(log.clockedMinutes),
      earned: dec(log.earnedMinutes),
      efficiency: dec(log.efficiencyRate),
    })),
    totals: {
      earned: [...byLine.values()].reduce((s, l) => s.plus(l.earned), dec(0)),
      clocked: [...byLine.values()].reduce((s, l) => s.plus(l.clocked), dec(0)),
    },
  };
}

/**
 * Offcuts and what became of them.
 *
 * Recovery rate is the figure worth watching: fabric sold on is a cost partly
 * recouped, fabric in the bin is the whole thing lost.
 */
export async function scrapReport(sinceDays = 180) {
  const since = new Date();
  since.setDate(since.getDate() - sinceDays);

  const records = await db.scrapRecord.findMany({
    where: { scrapDate: { gte: since } },
    include: {
      material: { include: { uom: true } },
      productionOrder: { include: { style: true } },
    },
    orderBy: { scrapDate: "desc" },
  });

  const byDisposition = new Map<
    string,
    {
      disposition: string;
      quantity: Decimal;
      bookValue: Decimal;
      salvage: Decimal;
      netLoss: Decimal;
    }
  >();

  for (const r of records) {
    const entry = byDisposition.get(r.disposition) ?? {
      disposition: r.disposition,
      quantity: dec(0),
      bookValue: dec(0),
      salvage: dec(0),
      netLoss: dec(0),
    };
    entry.quantity = entry.quantity.plus(dec(r.quantity));
    entry.bookValue = entry.bookValue.plus(dec(r.bookValue));
    entry.salvage = entry.salvage.plus(dec(r.salvageValue));
    entry.netLoss = entry.netLoss.plus(dec(r.netLoss));
    byDisposition.set(r.disposition, entry);
  }

  const bookValue = records.reduce((s, r) => s.plus(dec(r.bookValue)), dec(0));
  const salvage = records.reduce((s, r) => s.plus(dec(r.salvageValue)), dec(0));

  return {
    bookValue,
    salvage,
    netLoss: records.reduce((s, r) => s.plus(dec(r.netLoss)), dec(0)),
    recoveryRate: safeDiv(salvage, bookValue),
    byDisposition: [...byDisposition.values()].sort((a, b) =>
      Number(b.netLoss.minus(a.netLoss)),
    ),
    rows: records.map((r) => ({
      id: r.id,
      date: r.scrapDate,
      materialCode: r.material.code,
      materialEn: r.material.nameEn,
      materialAr: r.material.nameAr,
      uom: r.material.uom.code,
      disposition: r.disposition,
      quantity: dec(r.quantity),
      bookValue: dec(r.bookValue),
      salvageValue: dec(r.salvageValue),
      netLoss: dec(r.netLoss),
      orderNumber: r.productionOrder?.orderNumber ?? null,
      styleEn: r.productionOrder?.style.nameEn ?? null,
      styleAr: r.productionOrder?.style.nameAr ?? null,
      notes: r.notes,
    })),
  };
}
