import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { createCuttingTicket, cuttingReport, openTickets, CuttingError } from "./cutting";

/**
 * The cutting ticket.
 *
 * Material issues already carried a cuttingTicketId and nothing ever created a
 * ticket, so the column was always null. It matters because the cutting table
 * is the only place fabric utilisation can be measured: a bill of materials
 * says what a garment should take, and the lay says what it really took.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let styleId: string;
let orderId: string;
let materialId: string;
let ownerId: string;
let day: Date;

const ctx = () => ({ userId: ownerId, reason: null });

beforeAll(async () => {
  ownerId = (await db.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  materialId = (await db.material.findFirstOrThrow({ where: { type: "FABRIC" } })).id;

  const style = await db.style.findFirstOrThrow({
    where: { bomLines: { some: { material: { type: "FABRIC" } } } },
    orderBy: { code: "asc" },
  });
  styleId = style.id;

  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" },
    orderBy: { startDate: "asc" },
  });
  day = new Date(period.startDate);
});

beforeEach(async () => {
  await db.materialIssue.deleteMany({});
  await db.cuttingTicket.deleteMany({});
  await db.productionOrder.deleteMany({});
  await db.documentSequence.deleteMany({});

  orderId = (
    await db.productionOrder.create({
      data: {
        orderNumber: `PO-CUT-${Math.random().toString(36).slice(2, 10)}`,
        styleId, status: "IN_PRODUCTION",
        plannedQty: 200, orderDate: day,
      },
    })
  ).id;
});

afterAll(async () => {
  await db.materialIssue.deleteMany({});
  await db.cuttingTicket.deleteMany({});
  await db.productionOrder.deleteMany({});
  await db.$disconnect();
});

const ticket = (over: Partial<Parameters<typeof createCuttingTicket>[0]> = {}) =>
  createCuttingTicket(
    {
      productionOrderId: orderId,
      cutDate: day,
      piecesCut: 200,
      markerLengthM: 9.4,
      plies: 50,
      ...over,
    },
    ctx(),
  );

/** Cloth actually issued against a ticket. */
async function issued(cuttingTicketId: string, actualQty: number) {
  await db.materialIssue.create({
    data: {
      productionOrderId: orderId,
      cuttingTicketId,
      materialId,
      issueDate: day,
      standardQty: String(actualQty),
      actualQty: String(actualQty),
      varianceQty: "0",
      actualWasteRate: "0",
      unitCost: "100",
      varianceValue: "0",
    },
  });
}

describe("what was laid on the table", () => {
  it("works out the fabric laid from the marker and the plies", async () => {
    const result = await ticket({ markerLengthM: 9.4, plies: 50 });

    // 9.4 metres of marker under fifty layers.
    expect(Number(result.fabricLaid)).toBeCloseTo(470, 4);
  });

  it("does not invent a lay when only half of it is known", async () => {
    const result = await ticket({ markerLengthM: 9.4, plies: null });
    expect(result.fabricLaid).toBeNull();
  });

  it("numbers the ticket", async () => {
    const result = await ticket();
    expect(result.ticketNumber).toMatch(/^CUT-/);
  });

  it("refuses a ticket that cut nothing", async () => {
    await expect(ticket({ piecesCut: 0 })).rejects.toThrow();
  });

  it("refuses a run that does not exist", async () => {
    await expect(ticket({ productionOrderId: "nope" })).rejects.toThrow(CuttingError);
  });
});

describe("what came off it", () => {
  it("measures metres a garment against what the costing allowed", async () => {
    const result = await ticket({ piecesCut: 200, markerLengthM: 10, plies: 50 });
    // 500 metres laid, 200 pieces: 2.5 metres each.
    await issued(result.cuttingTicketId, 500);

    const report = await cuttingReport();
    const row = report.rows.find((r) => r.id === result.cuttingTicketId)!;

    expect(Number(row.actualPerPiece)).toBeCloseTo(2.5, 4);
    expect(row.standardPerPiece).not.toBeNull();
    expect(row.utilisation).not.toBeNull();
  });

  it("prefers what was actually issued over what the lay suggests", async () => {
    // The lay says 500; the store says 540 really left. The store is the one
    // that reconciles against inventory.
    const result = await ticket({ piecesCut: 200, markerLengthM: 10, plies: 50 });
    await issued(result.cuttingTicketId, 540);

    const report = await cuttingReport();
    const row = report.rows.find((r) => r.id === result.cuttingTicketId)!;

    expect(Number(row.fabricLaid)).toBe(500);
    expect(Number(row.fabricIssued)).toBe(540);
    expect(Number(row.actualPerPiece)).toBeCloseTo(2.7, 4);
  });

  it("falls back to the lay when nothing has been issued yet", async () => {
    const result = await ticket({ piecesCut: 200, markerLengthM: 10, plies: 50 });

    const report = await cuttingReport();
    const row = report.rows.find((r) => r.id === result.cuttingTicketId)!;

    expect(row.fabricIssued).toBeNull();
    expect(Number(row.actualPerPiece)).toBeCloseTo(2.5, 4);
  });

  it("counts the tickets that used more cloth than the costing allowed", async () => {
    const generous = await ticket({ piecesCut: 10, markerLengthM: 100, plies: 10 });
    await issued(generous.cuttingTicketId, 1000); // 100 metres a garment

    const report = await cuttingReport();

    // Well over any sane standard, and that is margin leaving the building a
    // metre at a time.
    expect(report.totals.overStandard).toBeGreaterThan(0);
    expect(Number(report.totals.averageUtilisation)).toBeGreaterThan(1);
  });

  it("measures nothing rather than guessing when the lay is unknown", async () => {
    const result = await ticket({ markerLengthM: null, plies: null });

    const report = await cuttingReport();
    const row = report.rows.find((r) => r.id === result.cuttingTicketId)!;

    expect(row.actualPerPiece).toBeNull();
    expect(row.utilisation).toBeNull();
  });

  it("is empty and does not fall over before anything is cut", async () => {
    const report = await cuttingReport();
    expect(report.rows).toHaveLength(0);
    expect(report.totals.averageUtilisation).toBeNull();
  });
});

describe("issuing against a ticket", () => {
  it("links the cloth to the lay it was cut on", async () => {
    const result = await ticket();
    await issued(result.cuttingTicketId, 470);

    const report = await cuttingReport();
    const row = report.rows.find((r) => r.id === result.cuttingTicketId)!;

    // The column existed from the first migration and was always null,
    // because nothing ever created a ticket to point it at.
    expect(row.issues).toBe(1);
  });

  it("offers the tickets a run can be issued against", async () => {
    const result = await ticket();

    const open = await openTickets(orderId);
    expect(open.map((t) => t.id)).toContain(result.cuttingTicketId);
  });
});
