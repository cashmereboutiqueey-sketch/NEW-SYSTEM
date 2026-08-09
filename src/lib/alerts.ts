import "server-only";
import { db } from "./db";
import { dec, safeDiv, type Decimal } from "./money";
import { writeAudit, type AuditContext } from "./audit";
import { cashForecast } from "./cash-flow";
import { materialRequirements } from "./mrp";
import { lineEfficiencyReport } from "./factory-floor";
import type { Prisma } from "@/generated/prisma/client";

/**
 * The system tells you, rather than you going to look.
 *
 * Each rule reads what is already recorded and raises an alert when a
 * threshold it owns is crossed. Thresholds live in the rule row, never in this
 * file — a shop that runs at 8% waste should be able to say so without a
 * deploy.
 *
 * Every alert carries a dedupe key describing the *condition*, not the moment
 * it was noticed. The same problem seen on three consecutive mornings is one
 * alert that is still open, not three. That is the difference between a system
 * people read and one they learn to ignore.
 */

export class AlertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlertError";
  }
}

type Finding = {
  dedupeKey: string;
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
  subjectType?: string;
  subjectId?: string;
  metrics?: Prisma.InputJsonValue;
};

type Params = Record<string, number | string | undefined>;

const num = (p: Params, key: string, fallback: number): number => {
  const value = p[key];
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const pct = (d: Decimal | number | null | undefined) =>
  d == null ? "—" : `${(Number(d) * 100).toFixed(1)}%`;

/* ─────────────────────────────────────────────────────────── the rules */

async function wasteDrift(p: Params): Promise<Finding[]> {
  const threshold = num(p, "thresholdPct", 0.02);

  const styles = await db.style.findMany({
    where: { isActive: true, actualWasteRateTrailing: { not: null } },
  });

  return styles
    .filter((s) =>
      dec(s.actualWasteRateTrailing!).minus(dec(s.plannedWasteRate)).greaterThan(threshold),
    )
    .map((s) => {
      const drift = dec(s.actualWasteRateTrailing!).minus(dec(s.plannedWasteRate));
      return {
        // Keyed on the style, not the date: the same style still drifting
        // tomorrow is the same problem.
        dedupeKey: `waste:${s.id}`,
        titleEn: `${s.code} is wasting more fabric than planned`,
        titleAr: `${s.nameAr}: الهالك أعلى من المخطط`,
        bodyEn: `Planned ${pct(s.plannedWasteRate)}, actually running at ${pct(s.actualWasteRateTrailing)} — ${pct(drift)} over. Costing still uses the planned rate, so this is eating margin quietly rather than showing up in the price.`,
        bodyAr: `المخطط ${pct(s.plannedWasteRate)} والفعلي ${pct(s.actualWasteRateTrailing)} — بزيادة ${pct(drift)}. التكلفة لسه بتستخدم النسبة المخططة، يعني الفرق ده بياكل الهامش من غير ما يظهر في السعر.`,
        subjectType: "Style",
        subjectId: s.id,
        metrics: {
          planned: s.plannedWasteRate.toString(),
          actual: s.actualWasteRateTrailing!.toString(),
          drift: drift.toString(),
        },
      };
    });
}

async function idleCapacity(p: Params): Promise<Finding[]> {
  const minIdle = num(p, "minIdleMinutes", 50_000);

  const periods = await db.minuteRatePeriod.findMany({
    where: { status: { not: "LOCKED" } },
    include: { fiscalPeriod: true, entity: true },
  });

  return periods
    .filter((period) => dec(period.idleMinutes).greaterThan(minIdle))
    .map((period) => {
      const label = `${period.fiscalPeriod.year}-${String(period.fiscalPeriod.month).padStart(2, "0")}`;
      const cost = dec(period.idleMinutes).times(dec(period.idlePenaltyPerMinute));
      return {
        dedupeKey: `idle:${period.id}`,
        titleEn: `${Math.round(Number(period.idleMinutes)).toLocaleString()} idle minutes in ${label}`,
        titleAr: `${Math.round(Number(period.idleMinutes)).toLocaleString()} دقيقة عاطلة في ${label}`,
        bodyEn: `Costing ${cost.toDecimalPlaces(2)} whether or not anything is made in them. Every minute sold as external CMT above ${dec(period.fullCapacityMinuteRate).toDecimalPlaces(4)} EGP lowers the rate the Brand itself pays.`,
        bodyAr: `بتكلّف ${cost.toDecimalPlaces(2)} سواء اشتغلت أو لأ. كل دقيقة تتباع تصنيع للغير فوق ${dec(period.fullCapacityMinuteRate).toDecimalPlaces(4)} جنيه بتنزّل تكلفة الدقيقة اللي البراند بيدفعها.`,
        subjectType: "MinuteRatePeriod",
        subjectId: period.id,
        metrics: { idleMinutes: period.idleMinutes.toString(), cost: cost.toString() },
      };
    });
}

async function lowStock(p: Params): Promise<Finding[]> {
  const buffer = num(p, "coverDaysBuffer", 7);
  const plan = await materialRequirements();

  // Only the ones already too late to reorder comfortably: a shortfall with
  // three months of runway is a purchasing task, not an alert.
  return plan.suggestions
    .filter((s) => s.shortfall.greaterThan(0) && s.urgency !== "PLANNED")
    .map((line) => ({
      dedupeKey: `stock:${line.materialId}`,
      titleEn: `${line.materialCode} runs out before a delivery could arrive`,
      titleAr: `${line.materialNameAr}: هينفد قبل ما التوريدة توصل`,
      bodyEn: `Short by ${line.shortfall.toDecimalPlaces(2)} ${line.uom}. Lead time is ${line.leadTimeDays} days and the order needed placing by ${line.orderBy ? line.orderBy.toISOString().slice(0, 10) : "already"}; ${buffer} days of buffer on top makes it tighter still.`,
      bodyAr: `ناقص ${line.shortfall.toDecimalPlaces(2)} ${line.uom}. مدة التوريد ${line.leadTimeDays} يوم وكان لازم الطلب يتعمل قبل ${line.orderBy ? line.orderBy.toISOString().slice(0, 10) : "دلوقتي"}؛ وزيادة ${buffer} يوم احتياطي بتضيّق الوقت أكتر.`,
      subjectType: "Material",
      subjectId: line.materialId,
      metrics: {
        shortfall: line.shortfall.toString(),
        leadTimeDays: line.leadTimeDays,
        urgency: line.urgency,
      },
    }));
}

async function deadStockRule(p: Params): Promise<Finding[]> {
  const days = num(p, "days", 90);
  const cutoff = new Date(Date.now() - days * 86_400_000);

  const lots = await db.inventoryLot.groupBy({
    by: ["variantId"],
    where: {
      state: "FINISHED_GOODS",
      remainingQty: { gt: 0 },
      receivedDate: { lt: cutoff },
      variantId: { not: null },
    },
    _sum: { remainingQty: true },
  });
  if (lots.length === 0) return [];

  const variants = await db.variant.findMany({
    where: { id: { in: lots.map((l) => l.variantId!) } },
    include: { style: true, colorCode: true, sizeCode: true },
  });

  return lots.map((lot) => {
    const v = variants.find((x) => x.id === lot.variantId);
    const qty = dec(lot._sum.remainingQty ?? 0);
    return {
      dedupeKey: `dead:${lot.variantId}`,
      titleEn: `${v?.sku ?? "SKU"} has been unsold for over ${days} days`,
      titleAr: `${v?.style.nameAr ?? "صنف"}: واقف أكتر من ${days} يوم`,
      bodyEn: `${qty} still on hand. Capital sitting still costs the same as capital at work — mark it down, move it to the other branch, or accept it is not going to sell.`,
      bodyAr: `لسه فيه ${qty} قطعة. الكاش النايم بيتكلّف زي الكاش الشغال — نزّل سعره، حوّله للفرع التاني، أو اعترف إنه مش هيتباع.`,
      subjectType: "Variant",
      subjectId: lot.variantId ?? undefined,
      metrics: { quantity: qty.toString(), days },
    };
  });
}

async function supplierPriceHike(p: Params): Promise<Finding[]> {
  const threshold = num(p, "thresholdPct", 0.1);

  const materials = await db.material.findMany({
    where: { isActive: true },
    include: {
      priceHistory: { orderBy: { effectiveFrom: "desc" }, take: 2 },
      supplier: true,
    },
  });

  return materials
    .filter((m) => m.priceHistory.length >= 2)
    .map((m) => {
      const [latest, previous] = m.priceHistory;
      const rise = safeDiv(
        dec(latest.effectiveCost).minus(dec(previous.effectiveCost)),
        dec(previous.effectiveCost),
      );
      return { m, latest, previous, rise };
    })
    .filter((x) => x.rise != null && x.rise.greaterThan(threshold))
    .map(({ m, latest, previous, rise }) => ({
      // Keyed on the price row, so a further rise later raises a new alert
      // rather than being swallowed by the old one.
      dedupeKey: `price:${latest.id}`,
      titleEn: `${m.code} went up ${pct(rise)}`,
      titleAr: `${m.nameAr}: السعر طلع ${pct(rise)}`,
      bodyEn: `From ${dec(previous.effectiveCost).toDecimalPlaces(2)} to ${dec(latest.effectiveCost).toDecimalPlaces(2)} landed${m.supplier ? `, at ${m.supplier.nameEn}` : ""}. Styles costed before this keep their old snapshot; anything costed from now on carries the new price.`,
      bodyAr: `من ${dec(previous.effectiveCost).toDecimalPlaces(2)} لـ ${dec(latest.effectiveCost).toDecimalPlaces(2)}${m.supplier ? ` عند ${m.supplier.nameAr}` : ""}. الموديلات المسعّرة قبل كده محتفظة بلقطتها، واللي هيتسعّر من دلوقتي هياخد السعر الجديد.`,
      subjectType: "Material",
      subjectId: m.id,
      metrics: {
        from: previous.effectiveCost.toString(),
        to: latest.effectiveCost.toString(),
        rise: rise!.toString(),
      },
    }));
}

async function marginBelowArmsLength(p: Params): Promise<Finding[]> {
  const snapshots = await db.costSnapshot.findMany({
    where: { marginBelowArmsLength: true },
    include: { style: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  const minimum = num(p, "minimumMarginPct", 0.12);

  return snapshots.map((s) => ({
    dedupeKey: `arms-length:${s.id}`,
    titleEn: `${s.style.code} was costed below arm's length`,
    titleAr: `${s.style.nameAr}: سعر التحويل أقل من العادل`,
    bodyEn: `Margin of ${pct(s.factoryMarginPct)} against a floor of ${pct(minimum)}. Discounting the transfer price does not save money — it moves the factory's loss into the Brand's books and stops the group view telling you anything.`,
    bodyAr: `الهامش ${pct(s.factoryMarginPct)} والحد الأدنى ${pct(minimum)}. تخفيض سعر التحويل مابيوفرش حاجة — بينقل خسارة المصنع لدفاتر البراند وبيخلّي حسابات المجموعة مش بتقول حاجة مفيدة.`,
    subjectType: "CostSnapshot",
    subjectId: s.id,
    metrics: { margin: s.factoryMarginPct.toString(), minimum },
  }));
}

async function cashShortfall(p: Params): Promise<Finding[]> {
  const horizonDays = num(p, "horizonDays", 30);
  const weeks = Math.max(1, Math.ceil(horizonDays / 7));

  const entities = await db.entity.findMany({ where: { kind: { in: ["FACTORY", "BRAND"] } } });
  const findings: Finding[] = [];

  for (const entity of entities) {
    const forecast = await cashForecast(entity.id, weeks);
    if (!forecast.firstShortfall) continue;

    const week = forecast.firstShortfall;
    findings.push({
      // The week, so next month's shortfall is a fresh alert.
      dedupeKey: `cash:${entity.id}:${week.weekStart.toISOString().slice(0, 10)}`,
      titleEn: `${entity.nameEn} runs short of cash in ${horizonDays} days`,
      titleAr: `${entity.nameAr}: عجز نقدي متوقع خلال ${horizonDays} يوم`,
      bodyEn: `Balance reaches ${week.closingBalance.toDecimalPlaces(2)} in the week of ${week.weekStart.toISOString().slice(0, 10)}. These are obligations already on the books, not projected sales.`,
      bodyAr: `الرصيد بيوصل ${week.closingBalance.toDecimalPlaces(2)} في أسبوع ${week.weekStart.toISOString().slice(0, 10)}. دي التزامات مسجّلة فعلًا، مش توقّع مبيعات.`,
      subjectType: "Entity",
      subjectId: entity.id,
      metrics: {
        balance: week.closingBalance.toString(),
        week: week.weekStart.toISOString().slice(0, 10),
      },
    });
  }

  return findings;
}

async function reworkRate(p: Params): Promise<Finding[]> {
  const threshold = num(p, "thresholdPct", 0.05);

  const orders = await db.productionOrder.findMany({
    where: { status: "COMPLETED", actualQty: { gt: 0 } },
    include: { reworkRecords: true, style: true },
    orderBy: { actualFinish: "desc" },
    take: 100,
  });

  return orders
    .map((order) => {
      const reworked = order.reworkRecords.reduce((s, r) => s + r.quantity, 0);
      const rate = safeDiv(dec(reworked), dec(order.actualQty ?? 0));
      const cost = order.reworkRecords.reduce(
        (s, r) => s.plus(dec(r.labourCost)).plus(dec(r.materialCost)),
        dec(0),
      );
      return { order, reworked, rate, cost };
    })
    .filter((x) => x.rate != null && x.rate.greaterThan(threshold))
    .map(({ order, reworked, rate, cost }) => ({
      dedupeKey: `rework:${order.id}`,
      titleEn: `${order.orderNumber} needed ${pct(rate)} rework`,
      titleAr: `${order.orderNumber}: إعادة تشغيل ${pct(rate)}`,
      bodyEn: `${reworked} of ${order.actualQty} garments went back, costing ${cost.toDecimalPlaces(2)} in minutes and material that earned nothing.`,
      bodyAr: `${reworked} قطعة من ${order.actualQty} رجعت للإصلاح، وكلّفت ${cost.toDecimalPlaces(2)} دقايق وخامات مجابتش عائد.`,
      subjectType: "ProductionOrder",
      subjectId: order.id,
      metrics: { reworked, rate: rate!.toString(), cost: cost.toString() },
    }));
}

async function lineEfficiencyDrop(p: Params): Promise<Finding[]> {
  const target = num(p, "targetPct", 0.7);
  const report = await lineEfficiencyReport(30);

  return report.lines
    .filter((l) => l.efficiency != null && l.efficiency.lessThan(target) && l.id !== "unassigned")
    .map((l) => ({
      dedupeKey: `line:${l.id}`,
      titleEn: `${l.nameEn} is running at ${pct(l.efficiency)}`,
      titleAr: `${l.nameAr}: بيشتغل بكفاءة ${pct(l.efficiency)}`,
      bodyEn: `Target is ${pct(target)}. ${l.clocked.minus(l.earned).toDecimalPlaces(0)} minutes were paid for and not earned over the last month — that is wages against no output, not a costing problem.`,
      bodyAr: `المستهدف ${pct(target)}. فيه ${l.clocked.minus(l.earned).toDecimalPlaces(0)} دقيقة اتدفعت ومااتكسبتش الشهر اللي فات — دي أجور من غير إنتاج، مش مشكلة تسعير.`,
      subjectType: "ProductionLine",
      subjectId: l.id,
      metrics: { efficiency: l.efficiency!.toString(), target },
    }));
}

async function moqShortfall(): Promise<Finding[]> {
  const plan = await materialRequirements();

  return plan.suggestions
    .filter((s) => s.roundedUpBecause === "MOQ")
    .map((line) => ({
      dedupeKey: `moq:${line.materialId}`,
      titleEn: `${line.materialCode} has to be bought above what the plan needs`,
      titleAr: `${line.materialNameAr}: لازم تشتري أكتر من اللي الخطة محتاجاه`,
      bodyEn: `The plan is short by ${line.shortfall.toDecimalPlaces(2)} ${line.uom} but the supplier's minimum forces ${line.suggestedQty.toDecimalPlaces(2)}. Either carry the difference, or hold the run until another style needs the same cloth.`,
      bodyAr: `الخطة ناقصها ${line.shortfall.toDecimalPlaces(2)} ${line.uom} بس الحد الأدنى للمورد بيفرض ${line.suggestedQty.toDecimalPlaces(2)}. يا تشيل الفرق، يا تأجّل التشغيلة لحد ما موديل تاني يحتاج نفس القماش.`,
      subjectType: "Material",
      subjectId: line.materialId,
      metrics: {
        shortfall: line.shortfall.toString(),
        mustBuy: line.suggestedQty.toString(),
      },
    }));
}

const EVALUATORS: Record<string, (p: Params) => Promise<Finding[]>> = {
  WASTE_DRIFT: wasteDrift,
  IDLE_CAPACITY: idleCapacity,
  LOW_STOCK: lowStock,
  DEAD_STOCK: deadStockRule,
  SUPPLIER_PRICE_HIKE: supplierPriceHike,
  MARGIN_BELOW_ARMS_LENGTH: marginBelowArmsLength,
  CASH_SHORTFALL: cashShortfall,
  REWORK_RATE: reworkRate,
  LINE_EFFICIENCY_DROP: lineEfficiencyDrop,
  MOQ_SHORTFALL: moqShortfall,
};

/* ────────────────────────────────────────────────────────── running them */

/**
 * Runs every enabled rule and records what it found.
 *
 * A condition already open is left alone: re-raising it would reset the
 * acknowledgement someone made yesterday and bury the new problems under the
 * old ones. A condition that has gone away is resolved, so the list shrinks by
 * itself rather than needing to be tidied.
 */
export async function evaluateAlerts(ctx: AuditContext): Promise<{
  raised: number;
  resolved: number;
  stillOpen: number;
  failed: { code: string; message: string }[];
}> {
  const rules = await db.alertRule.findMany({ where: { isEnabled: true } });

  let raised = 0;
  let resolved = 0;
  let stillOpen = 0;
  const failed: { code: string; message: string }[] = [];

  for (const rule of rules) {
    const evaluate = EVALUATORS[rule.code];
    if (!evaluate) continue;

    let findings: Finding[];
    try {
      findings = await evaluate((rule.parameters ?? {}) as Params);
    } catch (error) {
      // One rule that cannot read its data must not stop the other ten. The
      // failure is reported rather than swallowed.
      failed.push({
        code: rule.code,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const found = new Set(findings.map((f) => f.dedupeKey));

    for (const finding of findings) {
      const existing = await db.alert.findUnique({
        where: { alertRuleId_dedupeKey: { alertRuleId: rule.id, dedupeKey: finding.dedupeKey } },
      });

      if (existing && existing.status !== "RESOLVED") {
        // Still true. Refresh the wording and figures, leave the
        // acknowledgement where it is.
        await db.alert.update({
          where: { id: existing.id },
          data: {
            titleEn: finding.titleEn,
            titleAr: finding.titleAr,
            bodyEn: finding.bodyEn,
            bodyAr: finding.bodyAr,
            metrics: finding.metrics ?? undefined,
          },
        });
        stillOpen++;
        continue;
      }

      await db.alert.upsert({
        where: { alertRuleId_dedupeKey: { alertRuleId: rule.id, dedupeKey: finding.dedupeKey } },
        create: {
          alertRuleId: rule.id,
          severity: rule.severity,
          status: "OPEN",
          dedupeKey: finding.dedupeKey,
          titleEn: finding.titleEn,
          titleAr: finding.titleAr,
          bodyEn: finding.bodyEn,
          bodyAr: finding.bodyAr,
          subjectType: finding.subjectType ?? null,
          subjectId: finding.subjectId ?? null,
          metrics: finding.metrics ?? undefined,
        },
        // A condition that had been resolved and has come back is a new
        // problem, so it reopens rather than staying quietly closed.
        update: {
          status: "OPEN",
          severity: rule.severity,
          resolvedAt: null,
          acknowledgedAt: null,
          acknowledgedByUserId: null,
          titleEn: finding.titleEn,
          titleAr: finding.titleAr,
          bodyEn: finding.bodyEn,
          bodyAr: finding.bodyAr,
          metrics: finding.metrics ?? undefined,
        },
      });
      raised++;
    }

    // Anything this rule raised before and no longer finds has gone away.
    const stale = await db.alert.findMany({
      where: { alertRuleId: rule.id, status: { not: "RESOLVED" } },
      select: { id: true, dedupeKey: true },
    });
    const gone = stale.filter((a) => !found.has(a.dedupeKey));
    if (gone.length > 0) {
      await db.alert.updateMany({
        where: { id: { in: gone.map((a) => a.id) } },
        data: { status: "RESOLVED", resolvedAt: new Date() },
      });
      resolved += gone.length;
    }

    await db.alertRule.update({ where: { id: rule.id }, data: { lastRunAt: new Date() } });
  }

  await db.$transaction(async (tx) => {
    await writeAudit(tx, {
      action: "ALERTS_EVALUATED",
      entityName: "AlertRule",
      entityId: "all",
      after: { rules: rules.length, raised, resolved, stillOpen, failed },
      ctx,
    });
  });

  return { raised, resolved, stillOpen, failed };
}

/** Open alerts, worst first. */
export async function openAlerts() {
  return db.alert.findMany({
    where: { status: { in: ["OPEN", "ACKNOWLEDGED", "SNOOZED"] } },
    include: { alertRule: true, acknowledgedBy: true },
    orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
  });
}

export async function acknowledgeAlert(
  input: { alertId: string; snoozeDays?: number },
  ctx: AuditContext,
): Promise<void> {
  const alert = await db.alert.findUnique({ where: { id: input.alertId } });
  if (!alert) throw new AlertError("That alert no longer exists.");

  const snoozedUntil =
    input.snoozeDays && input.snoozeDays > 0
      ? new Date(Date.now() + input.snoozeDays * 86_400_000)
      : null;

  await db.$transaction(async (tx) => {
    await tx.alert.update({
      where: { id: alert.id },
      data: {
        status: snoozedUntil ? "SNOOZED" : "ACKNOWLEDGED",
        acknowledgedAt: new Date(),
        acknowledgedByUserId: ctx.userId,
        snoozedUntil,
      },
    });
    await writeAudit(tx, {
      action: snoozedUntil ? "ALERT_SNOOZED" : "ALERT_ACKNOWLEDGED",
      entityName: "Alert",
      entityId: alert.id,
      before: { status: alert.status },
      after: { status: snoozedUntil ? "SNOOZED" : "ACKNOWLEDGED", snoozedUntil },
      ctx,
    });
  });
}
