import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { logStage, StageLogError, loggableRuns, standardMinutesFor } from "./stage-logs";
import { lineEfficiencyReport } from "./factory-floor";

/**
 * What a line did with the hours it was paid for.
 *
 * Earned minutes over clocked minutes. Earned is never typed in — it is qtyOut
 * times the standard minutes for the stage, taken from the style's own
 * operations. A hand-entered efficiency measures the person entering it.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let styleId: string;
let orderId: string;
let lineId: string;
let ownerId: string;
let day: Date;

const ctx = { userId: null as string | null, reason: null };

beforeAll(async () => {
  // A style with a routing, not merely the first one alphabetically. Earned
  // minutes come from the operations, so a style with none makes every
  // assertion below compare zero against zero and pass for the wrong reason —
  // or, once real garments were imported and one of them sorted first, fail
  // for a reason that has nothing to do with stage logging.
  const style = await db.style.findFirstOrThrow({
    where: { operations: { some: {} } },
    orderBy: { code: "asc" },
  });
  styleId = style.id;
  lineId = (await db.productionLine.findFirstOrThrow({ where: { isActive: true } })).id;
  ownerId = (await db.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;

  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" },
    orderBy: { startDate: "asc" },
  });
  day = new Date(period.startDate);
});

beforeEach(async () => {
  await db.productionStageLog.deleteMany({});
  await db.productionOrder.deleteMany({});
  // Every operation goes back to having no stage, so each test says exactly
  // which routing it is testing against.
  await db.styleOperation.updateMany({ data: { stage: null } });

  const order = await db.productionOrder.create({
    data: {
      orderNumber: `PO-STG-${Math.random().toString(36).slice(2, 10)}`,
      styleId, status: "IN_PRODUCTION",
      plannedQty: 100, orderDate: day,
    },
  });
  orderId = order.id;
});

afterAll(async () => {
  await db.productionStageLog.deleteMany({});
  await db.productionOrder.deleteMany({});
  await db.styleOperation.updateMany({ data: { stage: null } });
  await db.$disconnect();
});

/** Give the style a routing: some of its operations belong to a stage. */
async function route(stage: "CUTTING" | "SEWING" | "FINISHING" | "QC" | "PACKING", take = 2) {
  const operations = await db.styleOperation.findMany({
    where: { styleId },
    orderBy: { sequence: "asc" },
    take,
  });
  await db.styleOperation.updateMany({
    where: { id: { in: operations.map((o) => o.id) } },
    data: { stage },
  });
  return operations.reduce((t, o) => t + Number(o.smvMinutes), 0);
}

const log = (over: Partial<Parameters<typeof logStage>[0]> = {}) =>
  logStage(
    {
      productionOrderId: orderId,
      lineId,
      stage: "SEWING",
      logDate: day,
      qtyIn: 100,
      qtyOut: 90,
      operatorsCount: 12,
      clockedMinutes: 4000,
      ...over,
    },
    { userId: ownerId, reason: null },
  );

describe("earned minutes come from the routing, not from a keyboard", () => {
  it("values what came off the line at the standard for that stage", async () => {
    const standard = await route("SEWING");

    const result = await log({ qtyOut: 90, clockedMinutes: 4000 });

    expect(Number(result.standardMinutesPerUnit)).toBeCloseTo(standard, 4);
    expect(Number(result.earnedMinutes)).toBeCloseTo(standard * 90, 4);
  });

  it("divides earned by clocked to get the efficiency", async () => {
    const standard = await route("SEWING");
    const result = await log({ qtyOut: 90, clockedMinutes: 4000 });

    expect(Number(result.efficiency)).toBeCloseTo((standard * 90) / 4000, 6);
  });

  it("counts only the operations belonging to the stage being logged", async () => {
    await route("SEWING", 2);
    await route("FINISHING", 1); // reassigns the first operation

    const sewing = await standardMinutesFor(styleId, "SEWING");
    const finishing = await standardMinutesFor(styleId, "FINISHING");

    // The reassignment moved one operation out of sewing and into finishing.
    expect(Number(sewing)).toBeGreaterThan(0);
    expect(Number(finishing)).toBeGreaterThan(0);
    expect(Number(sewing)).not.toBe(Number(finishing));
  });
});

describe("what it refuses", () => {
  it("refuses a stage the routing does not cover", async () => {
    await route("SEWING");

    // Nothing is assigned to packing, so there is no standard to measure the
    // line against. Defaulting to zero would report 0% and blame the line for
    // a gap in the routing.
    await expect(log({ stage: "PACKING" })).rejects.toThrow(/no operations assigned/i);
  });

  it("refuses more pieces out than went in", async () => {
    await route("SEWING");
    await expect(log({ qtyIn: 80, qtyOut: 90 })).rejects.toThrow();
  });

  it("refuses a shift with no minutes clocked", async () => {
    await route("SEWING");
    await expect(log({ clockedMinutes: 0 })).rejects.toThrow();
  });

  it("refuses a run that does not exist", async () => {
    await route("SEWING");
    await expect(log({ productionOrderId: "nope" })).rejects.toThrow(StageLogError);
  });

  it("records nothing when it refuses", async () => {
    await route("SEWING");
    await expect(log({ stage: "PACKING" })).rejects.toThrow();
    expect(await db.productionStageLog.count()).toBe(0);
  });
});

describe("the report the screen was always ready to show", () => {
  it("fills in once a shift is logged", async () => {
    await route("SEWING");
    await log({ qtyOut: 90, clockedMinutes: 4000 });

    const report = await lineEfficiencyReport();
    expect(report.lines.length).toBeGreaterThan(0);

    const ours = report.lines.find((l) => l.id === lineId)!;
    expect(ours.qtyOut).toBe(90);
    expect(Number(ours.clocked)).toBe(4000);
  });

  it("counts the pieces that went in and never came out", async () => {
    await route("SEWING");
    await log({ qtyIn: 100, qtyOut: 90 });

    const report = await lineEfficiencyReport();
    const ours = report.lines.find((l) => l.id === lineId)!;

    // Ten garments went into the stage and did not come out of it. That is
    // the number a floor manager is looking for.
    expect(ours.dropOut).toBe(10);
    expect(Number(ours.yieldRate)).toBeCloseTo(0.9, 6);
  });

  it("adds a second shift to the first rather than replacing it", async () => {
    await route("SEWING");
    await log({ qtyIn: 50, qtyOut: 45, clockedMinutes: 2000 });
    await log({ qtyIn: 50, qtyOut: 48, clockedMinutes: 2000 });

    const report = await lineEfficiencyReport();
    const ours = report.lines.find((l) => l.id === lineId)!;

    expect(ours.qtyOut).toBe(93);
    expect(Number(ours.clocked)).toBe(4000);
    expect(ours.entries).toBe(2);
  });

  it("keeps a shift with no line under its own heading", async () => {
    await route("SEWING");
    await log({ lineId: null });

    const report = await lineEfficiencyReport();
    // Unassigned work is still work: hiding it would flatter the average of
    // the lines that are named.
    expect(report.lines.find((l) => l.id === "unassigned")).toBeDefined();
  });
});

describe("what the form can offer", () => {
  it("offers only the stages the routing actually covers", async () => {
    await route("SEWING");

    const runs = await loggableRuns();
    const ours = runs.find((r) => r.id === orderId)!;

    expect(ours.stages.map((s) => s.stage)).toEqual(["SEWING"]);
    expect(Number(ours.stages[0].standardMinutes)).toBeGreaterThan(0);
  });

  it("says how many operations still have no stage, so the fix is obvious", async () => {
    await route("SEWING", 1);

    const runs = await loggableRuns();
    const ours = runs.find((r) => r.id === orderId)!;

    // The fix is on the style, not on the logging screen, and saying so beats
    // an empty dropdown.
    expect(ours.unroutedOperations).toBeGreaterThan(0);
  });
});
