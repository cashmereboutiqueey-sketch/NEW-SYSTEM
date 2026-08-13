import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import {
  recordProductivity, operatorProductivity, clockedFromAttendance, OperatorError,
} from "./operators";

/**
 * What one operator produced against the time they were paid for.
 *
 * Half measured, half entered, and the record says which. Clocked minutes come
 * from the attendance the biometric device already produced, so nobody decides
 * retrospectively how long somebody was on the floor.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let operatorId: string;
let bareOperatorId: string;
let employeeId: string;
let ownerId: string;
let day: Date;

beforeAll(async () => {
  ownerId = (await db.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;

  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" },
    orderBy: { startDate: "asc" },
  });
  day = new Date(period.startDate);

  // Everything this file needs, it makes. Leaning on whatever the demo
  // happens to hold passes alone and fails in a full run, because other files
  // legitimately clear employees and operators as they go — which is exactly
  // how this first failed.
  const tag = Math.random().toString(36).slice(2, 8);

  const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });
  const employee = await db.employee.create({
    data: {
      code: `EMP-OPS-${tag}`,
      name: "عاملة تحت الاختبار",
      entityId: factory.id,
      hiredAt: day,
      baseSalary: "6000",
      payFrequency: "MONTHLY",
      status: "ACTIVE",
    },
  });
  employeeId = employee.id;

  // One operator the HR system knows, and one it does not.
  operatorId = (
    await db.operator.create({
      data: { code: `OP-HR-${tag}`, name: "عاملة بملف", employeeId },
    })
  ).id;

  bareOperatorId = (
    await db.operator.create({
      data: { code: `OP-BARE-${tag}`, name: "عاملة من غير ملف" },
    })
  ).id;
});

beforeEach(async () => {
  await db.operatorProductivity.deleteMany({});
  await db.attendanceDay.deleteMany({ where: { employeeId, workDate: day } });
});

afterAll(async () => {
  await db.operatorProductivity.deleteMany({});
  await db.attendanceDay.deleteMany({ where: { employeeId } });
  // Take back exactly what was created, so the demo is as it was found.
  await db.operator.deleteMany({ where: { id: { in: [operatorId, bareOperatorId] } } });
  await db.employee.deleteMany({ where: { id: employeeId } });
  await db.$disconnect();
});

/** A day the device recorded. */
async function attended(workedMinutes: number, overtimeMinutes = 0, absent = false) {
  await db.attendanceDay.upsert({
    where: { employeeId_workDate: { employeeId, workDate: day } },
    update: {
      workedMinutes: String(workedMinutes),
      overtimeMinutes: String(overtimeMinutes),
      isAbsent: absent,
    },
    create: {
      employeeId, workDate: day,
      workedMinutes: String(workedMinutes),
      overtimeMinutes: String(overtimeMinutes),
      isAbsent: absent,
    },
  });
}

const record = (smvProduced: number, over: Record<string, unknown> = {}) =>
  recordProductivity(
    { operatorId, logDate: day, smvProduced, ...over },
    { userId: ownerId, reason: null },
  );

describe("the clocked minutes are measured, not chosen", () => {
  it("takes them from the attendance the device recorded", async () => {
    await attended(480);

    const result = await record(400);

    expect(result.clockedFromAttendance).toBe(true);
    expect(Number(result.clockedMinutes)).toBe(480);
    expect(Number(result.efficiency)).toBeCloseTo(400 / 480, 6);
  });

  it("counts approved overtime, because those minutes were paid for", async () => {
    await attended(480, 60);

    // Leaving overtime out would flatter anybody who stayed late.
    expect(Number(await clockedFromAttendance(operatorId, day))).toBe(540);
  });

  it("ignores anything typed when attendance knows the answer", async () => {
    await attended(480);

    const result = await record(400, { clockedMinutes: 200 });

    // 200 would have made this operator look 140% efficient.
    expect(Number(result.clockedMinutes)).toBe(480);
    expect(result.clockedFromAttendance).toBe(true);
  });

  it("reports nothing rather than zero for a day off", async () => {
    await attended(0, 0, true);

    // Zero would read as "stood idle all day", which is a different claim.
    expect(await clockedFromAttendance(operatorId, day)).toBeNull();
  });

  it("refuses to guess when there is no attendance at all", async () => {
    await expect(record(400)).rejects.toThrow(OperatorError);
  });

  it("lets the minutes be typed for an operator with no HR record", async () => {
    const result = await recordProductivity(
      { operatorId: bareOperatorId, logDate: day, smvProduced: 300, clockedMinutes: 480 },
      { userId: ownerId, reason: null },
    );

    // And says so, because a figure somebody chose is a different kind of
    // number from one a device recorded.
    expect(result.clockedFromAttendance).toBe(false);
    expect(Number(result.clockedMinutes)).toBe(480);
  });
});

describe("correcting a miscount", () => {
  it("replaces the day rather than adding a second one", async () => {
    await attended(480);
    await record(400);
    await record(430); // recounted the bundles

    const rows = await db.operatorProductivity.findMany({ where: { operatorId } });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].smvProduced)).toBe(430);
  });
});

describe("the ranking", () => {
  it("weights by minutes rather than averaging the daily rates", async () => {
    await attended(480);
    await record(240); // 50% over a long day

    const second = new Date(day.getTime() + 86_400_000);
    await db.attendanceDay.upsert({
      where: { employeeId_workDate: { employeeId, workDate: second } },
      update: { workedMinutes: "60" },
      create: { employeeId, workDate: second, workedMinutes: "60" },
    });
    await recordProductivity(
      { operatorId, logDate: second, smvProduced: 60 }, // 100% over a short one
      { userId: ownerId, reason: null },
    );

    const report = await operatorProductivity();
    const ours = report.operators.find((o) => o.operatorId === operatorId)!;

    // 300 earned over 540 clocked is 55.6%, not the 75% a plain average of
    // 50% and 100% would report.
    expect(Number(ours.efficiency)).toBeCloseTo(300 / 540, 6);
    expect(ours.days).toBe(2);

    await db.attendanceDay.deleteMany({ where: { employeeId, workDate: second } });
  });

  it("keeps the best and worst day, so a steady operator is not read as a lucky one", async () => {
    await attended(480);
    await record(400);

    const report = await operatorProductivity();
    const ours = report.operators.find((o) => o.operatorId === operatorId)!;

    expect(Number(ours.best)).toBeCloseTo(400 / 480, 6);
    expect(Number(ours.worst)).toBeCloseTo(400 / 480, 6);
  });

  it("is empty and does not fall over before anybody is logged", async () => {
    const report = await operatorProductivity();
    expect(report.operators).toHaveLength(0);
    expect(report.totals.efficiency).toBeNull();
  });
});
