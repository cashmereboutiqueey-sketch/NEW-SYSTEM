import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { receiveMaterial, unreconciledLots } from "./inventory";
import {
  recordCount,
  approveStockAdjustment,
  rejectStockAdjustment,
  approvalThreshold,
} from "./stocktake";

/**
 * Counting stock, against a real database.
 *
 * Two findings from the production audit are covered here:
 *
 *   - a count that found extra stock was recorded as an unsigned difference
 *     and replayed as stock going missing (C13);
 *   - a large difference was "approved" by whatever name the counter picked on
 *     their own form, with the approval right checked against the counter
 *     (H02).
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let factoryId: string;
let locationId: string;
let materialId: string;
let counterId: string;
let approverId: string;
let day: Date;
let limit: number;

const UNIT_COST = 100;

beforeAll(async () => {
  factoryId = (await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } })).id;
  locationId = (await db.location.findFirstOrThrow({ where: { code: "LOC-FAC" } })).id;
  materialId = (await db.material.findFirstOrThrow({ where: { type: "FABRIC" } })).id;
  counterId = (await db.user.findFirstOrThrow({ where: { email: "owner@cashmere.eg" } })).id;
  approverId = (await db.user.findFirstOrThrow({ where: { email: "accountant@cashmere.eg" } })).id;
  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" }, orderBy: { startDate: "asc" },
  });
  day = new Date(period.startDate);
  limit = Number(await approvalThreshold());
});

async function wipe() {
  await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
  await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
  try {
    await db.commandReceipt.deleteMany({});
    await db.stockAdjustmentRequest.deleteMany({});
    await db.inventoryMovement.deleteMany({});
    await db.inventoryLot.deleteMany({});
    await db.journalLine.deleteMany({});
    await db.journalEntry.deleteMany({});
    await db.auditLog.deleteMany({});
    await db.documentSequence.deleteMany({});
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
  }
}

beforeEach(wipe);
// Whatever a count did, the lot's balance must be what its movements say.
afterEach(async () => {
  expect(await unreconciledLots()).toEqual([]);
});
afterAll(async () => { await wipe(); await db.$disconnect(); });

/** A lot whose value makes `units` of difference exactly `units × 100`. */
async function lot(quantity = 1000): Promise<string> {
  const r = await receiveMaterial(
    {
      materialId, locationId, entityId: factoryId,
      quantity: String(quantity), unitCost: String(UNIT_COST), receivedDate: day,
    },
    { userId: counterId },
  );
  return r.lotId;
}

const count = (lotId: string, countedQty: number) =>
  recordCount(
    { lotId, countedQty: String(countedQty), reason: "monthly count", countDate: day },
    { userId: counterId },
  );

/** Units of difference that stay under the approval limit. */
const small = () => Math.max(1, Math.floor(limit / UNIT_COST / 2));
/** Units of difference that go over it. */
const large = () => Math.floor(limit / UNIT_COST) + 5;

describe("the direction of a count", () => {
  it("records a shortfall as stock going out", async () => {
    const lotId = await lot();
    await count(lotId, 1000 - small());

    const m = await db.inventoryMovement.findFirstOrThrow({ where: { lotId, type: "ADJUSTMENT" } });
    expect(m.direction).toBe("OUT");
    expect(Number((await db.inventoryLot.findUniqueOrThrow({ where: { id: lotId } })).remainingQty))
      .toBe(1000 - small());
  });

  it("records stock found on the shelf as stock coming in", async () => {
    // The audit's case: an unsigned difference replayed as a loss.
    const lotId = await lot();
    await count(lotId, 1000 + small());

    const m = await db.inventoryMovement.findFirstOrThrow({ where: { lotId, type: "ADJUSTMENT" } });
    expect(m.direction).toBe("IN");
    expect(Number((await db.inventoryLot.findUniqueOrThrow({ where: { id: lotId } })).remainingQty))
      .toBe(1000 + small());
  });
});

describe("a large difference waits for somebody else", () => {
  it("posts nothing when the count is recorded", async () => {
    const lotId = await lot();
    const journalsBefore = await db.journalEntry.count();

    const result = await count(lotId, 1000 - large());

    expect(result.direction).toBe("PENDING");
    expect(Number((await db.inventoryLot.findUniqueOrThrow({ where: { id: lotId } })).remainingQty))
      .toBe(1000);
    expect(await db.inventoryMovement.count({ where: { lotId, type: "ADJUSTMENT" } })).toBe(0);
    expect(await db.journalEntry.count()).toBe(journalsBefore);
    expect((await db.stockAdjustmentRequest.findUniqueOrThrow({ where: { id: result.requestId! } })).status)
      .toBe("PENDING");
  });

  it("will not let the counter approve their own count", async () => {
    const lotId = await lot();
    const { requestId } = await count(lotId, 1000 - large());

    await expect(
      approveStockAdjustment({ requestId: requestId! }, { userId: counterId }),
    ).rejects.toThrow(/cannot also approve/i);
    expect(Number((await db.inventoryLot.findUniqueOrThrow({ where: { id: lotId } })).remainingQty))
      .toBe(1000);
  });

  it("posts once somebody else approves it, and records who", async () => {
    const lotId = await lot();
    const { requestId } = await count(lotId, 1000 - large());

    const approved = await approveStockAdjustment({ requestId: requestId! }, { userId: approverId });

    expect(approved.outcome).toBe("POSTED");
    expect(Number((await db.inventoryLot.findUniqueOrThrow({ where: { id: lotId } })).remainingQty))
      .toBe(1000 - large());
    const request = await db.stockAdjustmentRequest.findUniqueOrThrow({ where: { id: requestId! } });
    expect(request.status).toBe("APPROVED");
    expect(request.decidedByUserId).toBe(approverId);

    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "STOCK_ADJUSTED", entityId: lotId } });
    expect((audit.after as { approvedBy: string }).approvedBy).toBe(approverId);
  });

  it("refuses a difference that is out of date because the stock moved", async () => {
    const lotId = await lot();
    const { requestId } = await count(lotId, 1000 - large());

    // Somebody counts the same shelf again, and it moves by a small amount.
    await count(lotId, 1000 - small());

    const approved = await approveStockAdjustment({ requestId: requestId! }, { userId: approverId });
    expect(approved.outcome).toBe("STALE");
    expect(Number((await db.inventoryLot.findUniqueOrThrow({ where: { id: lotId } })).remainingQty))
      .toBe(1000 - small());
    expect((await db.stockAdjustmentRequest.findUniqueOrThrow({ where: { id: requestId! } })).status)
      .toBe("REJECTED");
  });

  it("can be sent back without posting", async () => {
    const lotId = await lot();
    const { requestId } = await count(lotId, 1000 - large());

    await rejectStockAdjustment(
      { requestId: requestId!, reason: "Count the top shelf too" },
      { userId: approverId },
    );
    const request = await db.stockAdjustmentRequest.findUniqueOrThrow({ where: { id: requestId! } });
    expect(request.status).toBe("REJECTED");
    expect(request.decisionNote).toMatch(/top shelf/);
    expect(Number((await db.inventoryLot.findUniqueOrThrow({ where: { id: lotId } })).remainingQty))
      .toBe(1000);
  });

  it("approves only once when two approvals race", async () => {
    const lotId = await lot();
    const { requestId } = await count(lotId, 1000 - large());

    const outcomes = await Promise.allSettled([
      approveStockAdjustment({ requestId: requestId! }, { userId: approverId }),
      approveStockAdjustment({ requestId: requestId! }, { userId: approverId }),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(await db.inventoryMovement.count({ where: { lotId, type: "ADJUSTMENT" } })).toBe(1);
  });
});
