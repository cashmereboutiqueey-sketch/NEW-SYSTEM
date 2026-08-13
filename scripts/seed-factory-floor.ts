/**
 * A week on the shop floor: offcuts and shifts.
 *
 * The scrap and line-efficiency screens were built to read tables nothing ever
 * wrote, so both could only say "nothing recorded yet". This puts a realistic
 * week through the new write paths, which is also the only way to see that the
 * ledger picks the scrap up.
 *
 *   npx tsx --conditions=react-server scripts/seed-factory-floor.ts
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { recordScrap } from "../src/lib/scrap";
import { logStage } from "../src/lib/stage-logs";
import { recordInspection, recordRework } from "../src/lib/quality";
import { recordProductivity } from "../src/lib/operators";

const owner = await db.user.findFirstOrThrow({ where: { role: "OWNER" } });
const ctx = { userId: owner.id, reason: null };

const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });
const store = await db.location.findFirstOrThrow({ where: { code: "LOC-FAC" } });

const period = await db.fiscalPeriod.findFirstOrThrow({
  where: { status: "OPEN" },
  orderBy: { startDate: "asc" },
});
const start = new Date(period.startDate);
const dayAt = (n: number) => new Date(start.getTime() + n * 86_400_000);

/* ─────────────────────────── stages on the routing ──────────────────────── */

// Operations carried a line and a sequence but never a stage, so nothing could
// say what "the standard minutes for sewing" were. Spread the existing routing
// across the real stages: the first operation cuts, the last packs, the rest
// sew.
const styles = await db.style.findMany({
  include: { operations: { orderBy: { sequence: "asc" } } },
});

let routed = 0;
for (const style of styles) {
  const ops = style.operations;
  if (ops.length === 0) continue;

  for (const [i, op] of ops.entries()) {
    const stage =
      i === 0 ? "CUTTING" : i === ops.length - 1 ? "PACKING" : i === ops.length - 2 ? "FINISHING" : "SEWING";
    await db.styleOperation.update({ where: { id: op.id }, data: { stage } });
    routed += 1;
  }
}
console.log(`── routing: ${routed} operations across ${styles.length} styles now carry a stage`);

/* ───────────────────────────────── scrap ────────────────────────────────── */

const onHand = await db.inventoryLot.findMany({
  where: { entityId: factory.id, state: "RAW_MATERIAL", remainingQty: { gt: 2 }, locationId: store.id },
  include: { material: true },
  orderBy: { receivedDate: "asc" },
});

const fabrics = [...new Map(onHand.filter((l) => l.material).map((l) => [l.materialId!, l])).values()];

const plan: { disposition: "DISCARDED" | "SOLD" | "USED_FOR_SAMPLING" | "RETURNED_TO_STOCK"; qty: number; salvage: number; note: string }[] = [
  { disposition: "DISCARDED", qty: 2.5, salvage: 0, note: "بواقي القص" },
  { disposition: "SOLD", qty: 3, salvage: 180, note: "اتباعت لتاجر خردة" },
  { disposition: "USED_FOR_SAMPLING", qty: 1.2, salvage: 0, note: "عينة للعميل" },
  { disposition: "RETURNED_TO_STOCK", qty: 4, salvage: 0, note: "قطعة سليمة رجعت الرف" },
];

console.log("\n── scrap");
let scrapped = 0;
for (const [i, fabric] of fabrics.slice(0, 4).entries()) {
  const step = plan[i % plan.length];
  if (Number(fabric.remainingQty) < step.qty) continue;

  try {
    const result = await recordScrap(
      {
        materialId: fabric.materialId!,
        locationId: store.id,
        entityId: factory.id,
        disposition: step.disposition,
        quantity: step.qty,
        salvageValue: step.salvage,
        scrapDate: dayAt(i + 1),
        notes: step.note,
      },
      ctx,
    );
    scrapped += 1;
    console.log(
      `   ${fabric.material!.code.padEnd(16)} ${step.disposition.padEnd(18)} ` +
        `book ${Number(result.bookValue).toFixed(2).padStart(9)}  back ${Number(result.salvageValue).toFixed(2).padStart(7)}` +
        `  loss ${Number(result.netLoss).toFixed(2).padStart(9)}  ${result.journalEntryNumber ?? "(no journal)"}`,
    );
  } catch (error) {
    console.log(`   ${fabric.material!.code}: ${(error as Error).message}`);
  }
}
console.log(`   ${scrapped} record(s)`);

/* ───────────────────────────────── shifts ───────────────────────────────── */

const runs = await db.productionOrder.findMany({
  where: { status: { in: ["CONFIRMED", "IN_PRODUCTION", "COMPLETED"] } },
  include: { style: { include: { operations: true } } },
  orderBy: { orderDate: "desc" },
  take: 3,
});

const lines = await db.productionLine.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } });

console.log("\n── shifts");
let logged = 0;
for (const [r, run] of runs.entries()) {
  const stages = ["CUTTING", "SEWING", "FINISHING", "PACKING"] as const;

  for (const [s, stage] of stages.entries()) {
    const covered = run.style.operations.some((o) => o.stage === stage);
    if (!covered) continue;

    const standard = run.style.operations
      .filter((o) => o.stage === stage)
      .reduce((t, o) => t + Number(o.smvMinutes), 0);

    // A real week: a few pieces lost at each stage, and the line running
    // somewhere near but not at standard.
    const qtyIn = Math.max(20, run.plannedQty - s * 3);
    const qtyOut = Math.max(10, qtyIn - (s === 1 ? 4 : 1));
    const efficiency = [0.88, 0.71, 0.94, 0.83][s % 4];
    const clocked = Math.round((standard * qtyOut) / efficiency);

    try {
      const result = await logStage(
        {
          productionOrderId: run.id,
          lineId: lines[(r + s) % Math.max(lines.length, 1)]?.id ?? null,
          stage,
          logDate: dayAt(r * 2 + s),
          qtyIn,
          qtyOut,
          operatorsCount: 8 + s,
          clockedMinutes: clocked,
        },
        ctx,
      );
      logged += 1;
      console.log(
        `   ${run.orderNumber.padEnd(22)} ${stage.padEnd(10)} ${String(qtyOut).padStart(4)} out  ` +
          `earned ${Number(result.earnedMinutes).toFixed(0).padStart(6)}  clocked ${clocked.toString().padStart(6)}  ` +
          `${(Number(result.efficiency) * 100).toFixed(1)}%`,
      );
    } catch (error) {
      console.log(`   ${run.orderNumber} ${stage}: ${(error as Error).message}`);
    }
  }
}
console.log(`   ${logged} shift(s)`);

/* ────────────────────────── inspections and rework ──────────────────────── */

console.log("\n── quality");
const factoryEntity = factory;
let inspected = 0;
let fixed = 0;

for (const [i, run] of runs.entries()) {
  const made = run.actualQty ?? run.plannedQty;
  if (made <= 0) continue;

  // A realistic week: most pass, a handful go back, one or two are a write-off.
  const rework = Math.max(1, Math.round(made * [0.06, 0.03, 0.11][i % 3]));
  const rejected = Math.max(0, Math.round(made * 0.01));
  const passed = made - rework - rejected;

  try {
    const result = await recordInspection(
      {
        productionOrderId: run.id,
        stage: "QC",
        inspectionDate: dayAt(i + 2),
        inspectedQty: made,
        passedQty: passed,
        reworkQty: rework,
        rejectedQty: rejected,
        defectNotes: ["خياطة مش مظبوطة", "بقع على القماش", "مقاس غلط"][i % 3],
      },
      ctx,
    );
    inspected += 1;
    console.log(
      `   ${run.orderNumber.padEnd(22)} inspected ${String(made).padStart(4)}  ` +
        `back ${String(rework).padStart(3)}  rejected ${String(rejected).padStart(3)}  ` +
        `defect ${(Number(result.defectRate) * 100).toFixed(1)}%`,
    );

    const fix = await recordRework(
      {
        productionOrderId: run.id,
        entityId: factoryEntity.id,
        lineId: lines[i % Math.max(lines.length, 1)]?.id ?? null,
        type: (["RESEWING", "REPRESSING", "REPACKING"] as const)[i % 3],
        // Not all of it comes back the same week — that gap is the point of
        // the "outstanding" column.
        quantity: Math.max(1, rework - 2),
        minutesPerUnit: [14, 4, 6][i % 3],
        // Named, not priced: FIFO decides what the buttons cost.
        material:
          i % 3 === 2 && fabrics[0]
            ? { materialId: fabrics[0].materialId!, locationId: store.id, quantity: 0.5 }
            : null,
        reworkDate: dayAt(i + 3),
        reason: "إصلاح بعد الفحص",
      },
      ctx,
    );
    fixed += 1;
    console.log(
      `   ${" ".repeat(22)} rework ${Number(fix.totalMinutes).toFixed(0).padStart(6)} min  ` +
        `cost ${Number(fix.totalCost).toFixed(2).padStart(9)}  ${fix.journalEntryNumber}`,
    );
  } catch (error) {
    console.log(`   ${run.orderNumber}: ${(error as Error).message}`);
  }
}
console.log(`   ${inspected} inspection(s), ${fixed} rework record(s)`);

/* ────────────────────────── operator productivity ───────────────────────── */

console.log("\n── operators");
const operators = await db.operator.findMany({
  where: { isActive: true },
  orderBy: { code: "asc" },
  take: 8,
});

let people = 0;
for (const [i, operator] of operators.entries()) {
  // Two days each, at a spread of efficiencies a real floor would show.
  for (const d of [0, 1]) {
    const when = dayAt(d + 1);
    const clocked = 480;
    const efficiency = [0.92, 0.78, 0.61, 0.88, 0.95, 0.70, 0.83, 0.55][(i + d) % 8];

    try {
      await recordProductivity(
        {
          operatorId: operator.id,
          logDate: when,
          smvProduced: Math.round(clocked * efficiency),
          // Most operators here have no HR record, so the minutes are typed —
          // and the record says so.
          clockedMinutes: clocked,
        },
        ctx,
      );
      people += 1;
    } catch (error) {
      console.log(`   ${operator.code}: ${(error as Error).message}`);
    }
  }
}
console.log(`   ${people} operator-day(s) across ${operators.length} operators`);

await db.$disconnect();
