import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import ExcelJS from "exceljs";
import { receiveFinishedGoods } from "./inventory";
import { createSale } from "./sales";
import {
  importCourierZones, readyToShip, createShipmentBatches, manifestWorkbook,
  parseCourierReport, applyCourierReport, shipmentsNeedingAttention, courierOwesUs,
  updateDestination, mgStatus, MG_EXPRESS, ShippingError,
} from "./shipping";

/**
 * Handing parcels to MG Express, and reading its report back.
 *
 * The courier has no API, so the tests hold the two sheets to the courier's
 * own shape: the manifest must be its import template exactly, and its orders
 * report must be read whatever order its columns come in.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let brandId: string;
let channelId: string;
let locationId: string;
let variantId: string;
let userId: string;
let day: Date;

const ctx = () => ({ userId, reason: null });

beforeAll(async () => {
  brandId = (await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } })).id;
  channelId = (await db.salesChannel.findFirstOrThrow()).id;
  locationId = (await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } })).id;
  variantId = (await db.variant.findFirstOrThrow({ orderBy: { sku: "asc" } })).id;
  userId = (await db.user.findFirstOrThrow({ where: { email: "owner@cashmere.eg" } })).id;
  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" }, orderBy: { startDate: "asc" },
  });
  day = new Date(period.startDate);
});

async function wipe() {
  await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
  await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
  try {
    await db.shipment.deleteMany({});
    await db.shipmentBatch.deleteMany({});
    await db.commandReceipt.deleteMany({});
    await db.salesPayment.deleteMany({});
    await db.salesOrderLine.deleteMany({});
    await db.salesOrder.deleteMany({});
    await db.courierZone.deleteMany({});
    await db.tillCashEvent.deleteMany({});
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

/**
 * Three of the courier's areas, with made-up prices. The real ones are the
 * shop's commercial terms and stay out of a public repository.
 */
async function givenZones() {
  await importCourierZones(
    {
      courier: MG_EXPRESS,
      zones: [
        { governorate: "القاهرة", region: "مدينة نصر", price: 41 },
        { governorate: "الاسكندرية", region: "سموحة", price: 32 },
        { governorate: "الاسكندرية", region: "برج العرب", price: 37 },
      ],
      branchFor: (g) => (["القاهرة", "الجيزة", "القليوبية"].includes(g) ? "5" : "1"),
    },
    ctx(),
  );
  const zone = async (region: string) =>
    (await db.courierZone.findFirstOrThrow({ where: { region } })).id;
  return { cairo: await zone("مدينة نصر"), smouha: await zone("سموحة") };
}

beforeEach(async () => {
  await wipe();
  await receiveFinishedGoods(
    {
      variantId, locationId, entityId: brandId,
      quantity: "50", unitCost: "400", materialUnitCost: "300", receivedDate: day,
    },
    { userId: null, reason: null },
  );
});

afterAll(async () => { await wipe(); await db.$disconnect(); });

/** A social order paid on delivery: 2 × 880 plus 45 shipping. */
async function codOrder(courierZoneId: string | null, over: { address?: string | null; phone?: string | null } = {}) {
  return createSale(
    {
      source: "MODERATOR",
      channelId, entityId: brandId, locationId,
      orderDate: day,
      shippingAmount: 45,
      lines: [{ variantId, quantity: 2, retailPrice: 880, discountPct: 0 }],
      payments: [{ method: "COD", amount: 1805, fee: 0, collected: false }],
      destination: {
        recipientName: "منى أحمد",
        phone: over.phone === undefined ? "01001234567" : over.phone,
        secondPhone: "01229876543",
        courierZoneId,
        addressLine: over.address === undefined ? "١٢ شارع فوزي معاذ، الدور التالت" : over.address,
      },
    },
    ctx(),
  );
}

describe("the courier's areas", () => {
  it("loads the price list, and deactivates an area the courier dropped rather than deleting it", async () => {
    await givenZones();
    expect(await db.courierZone.count({ where: { isActive: true } })).toBe(3);

    // A new list without Borg El Arab, and Smouha repriced.
    const result = await importCourierZones(
      {
        courier: MG_EXPRESS,
        zones: [
          { governorate: "القاهرة", region: "مدينة نصر", price: 41 },
          { governorate: "الاسكندرية", region: "سموحة", price: 34 },
        ],
        branchFor: () => "1",
      },
      ctx(),
    );

    expect(result.deactivated).toBe(1);
    expect(await db.courierZone.count()).toBe(3);
    const smouha = await db.courierZone.findFirstOrThrow({ where: { region: "سموحة" } });
    expect(Number(smouha.price)).toBe(34);
  });

  it("takes the governorate from the area, not from what was typed", async () => {
    const { smouha } = await givenZones();
    const sale = await codOrder(smouha);

    const order = await db.salesOrder.findUniqueOrThrow({ where: { id: sale.salesOrderId } });
    expect(order.governorate).toBe("الاسكندرية");
    expect(order.city).toBe("سموحة");
    expect(order.addressLine).toContain("فوزي معاذ");
  });
});

describe("the day's sheet", () => {
  it("lists what is ready, with what the driver collects", async () => {
    const { smouha } = await givenZones();
    const sale = await codOrder(smouha);

    const ready = (await readyToShip()).find((o) => o.id === sale.salesOrderId)!;
    expect(Number(ready.codAmount)).toBe(1805);
    expect(ready.problems).toEqual([]);
    expect(ready.pieces).toBe(2);
  });

  it("says what is missing rather than letting the courier's import reject the row", async () => {
    await givenZones();
    const sale = await codOrder(null, { address: null });

    const ready = (await readyToShip()).find((o) => o.id === sale.salesOrderId)!;
    expect(ready.problems).toEqual(["no delivery area", "no street address"]);
    await expect(
      createShipmentBatches({ salesOrderIds: [sale.salesOrderId] }, ctx()),
    ).rejects.toThrow(/cannot go yet: no delivery area, no street address/);
  });

  it("makes one sheet per branch, because the courier's import takes one branch a file", async () => {
    const { cairo, smouha } = await givenZones();
    const a = await codOrder(cairo);
    const b = await codOrder(smouha);

    const { batches } = await createShipmentBatches(
      { salesOrderIds: [a.salesOrderId, b.salesOrderId] },
      ctx(),
    );

    expect(batches.map((x) => x.branch).sort()).toEqual(["1", "5"]);
    const order = await db.salesOrder.findUniqueOrThrow({ where: { id: a.salesOrderId } });
    expect(order.status).toBe("SHIPPED");
  });

  it("will not put the same order on a second sheet", async () => {
    const { smouha } = await givenZones();
    const sale = await codOrder(smouha);
    await createShipmentBatches({ salesOrderIds: [sale.salesOrderId] }, ctx());

    await expect(
      createShipmentBatches({ salesOrderIds: [sale.salesOrderId] }, ctx()),
    ).rejects.toThrow(ShippingError);
    expect((await readyToShip()).some((o) => o.id === sale.salesOrderId)).toBe(false);
  });

  it("writes the courier's own template exactly, one row a parcel", async () => {
    const { smouha } = await givenZones();
    const sale = await codOrder(smouha);
    const { batches } = await createShipmentBatches({ salesOrderIds: [sale.salesOrderId] }, ctx());

    const { fileName, data } = await manifestWorkbook(batches[0].batchId);
    expect(fileName).toMatch(/^MG-Express_SHP-.*\.xlsx$/);

    const book = new ExcelJS.Workbook();
    await book.xlsx.load(data as unknown as ArrayBuffer);
    const sheet = book.worksheets[0];
    const values = (n: number) => (sheet.getRow(n).values as unknown[]).slice(1);

    expect(values(1)).toEqual([
      "م", "CustName", "Company", "subComp", "Cost", "Weight", "Parcode", "Phone", "SecPhone",
      "City", "Region", "address", "createdDate", "Notes", "Replacing", "OrderContent", "PiecesNum", "EmpName",
    ]);
    expect(values(2)[1]).toBe("المرسل اليه");

    const row = sheet.getRow(3);
    expect(row.getCell(2).value).toBe("منى أحمد");
    expect(row.getCell(5).value).toBe(1805);
    expect(row.getCell(7).value).toBe(sale.orderNumber);
    expect(row.getCell(8).value).toBe("01001234567");
    expect(row.getCell(10).value).toBe("الاسكندرية");
    expect(row.getCell(11).value).toBe("سموحة");
    expect(row.getCell(17).value).toBe(2);
  });
});

describe("completing an order's details", () => {
  it("lets somebody pick the courier's area for an order that arrived without one", async () => {
    const { smouha } = await givenZones();
    const sale = await codOrder(null);
    expect((await readyToShip()).find((o) => o.id === sale.salesOrderId)!.problems).toEqual(["no delivery area"]);

    await updateDestination({ salesOrderId: sale.salesOrderId, courierZoneId: smouha }, ctx());

    const ready = (await readyToShip()).find((o) => o.id === sale.salesOrderId)!;
    expect(ready.problems).toEqual([]);
    expect(ready.governorate).toBe("الاسكندرية");
    // What was not sent is left as it was.
    expect(ready.phone).toBe("01001234567");
  });

  it("will not move a parcel that is already on the courier's sheet", async () => {
    const { smouha, cairo } = await givenZones();
    const sale = await codOrder(smouha);
    await createShipmentBatches({ salesOrderIds: [sale.salesOrderId] }, ctx());

    await expect(
      updateDestination({ salesOrderId: sale.salesOrderId, courierZoneId: cairo }, ctx()),
    ).rejects.toThrow(/already gone to the courier/);
  });
});

describe("reading the courier's report", () => {
  /** The courier's orders report, in the order its portal puts the columns. */
  async function report(rows: string[][]): Promise<Buffer> {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("report");
    sheet.addRow(["رقم الطلب", "رقم الشحنة", "التاريخ", "المرسل اليه", "العنوان", "الحالة", "تكلفة الاوردر", "المدفوع", "المستحق للعميل", "مرات الشحن", "رد المتابعة", "الشحن", "الدفع للعميل"]);
    for (const r of rows) sheet.addRow(r);
    return Buffer.from(await book.xlsx.writeBuffer());
  }

  async function shipped(zone: string) {
    const sale = await codOrder(zone);
    await createShipmentBatches({ salesOrderIds: [sale.salesOrderId] }, ctx());
    return sale;
  }

  it("knows the courier's statuses, however the report spells them", () => {
    expect(mgStatus("المسلمة ودفع كامل")).toBe("DELIVERED");
    expect(mgStatus("  المسلمة ومرتجع جزئى ")).toBe("NEEDS_REVIEW");
    expect(mgStatus("أوردر بيك أب")).toBe("IN_TRANSIT");
    expect(mgStatus("مرتجع ولم يدفع الشحن")).toBe("RETURNED");
    expect(mgStatus("شيء جديد")).toBeNull();
  });

  it("marks a delivered parcel delivered, and remembers what the courier owes", async () => {
    const { smouha } = await givenZones();
    const sale = await shipped(smouha);

    const parsed = await parseCourierReport(
      await report([["9001", sale.orderNumber, "13/09/2026", "منى", "سموحة", "المسلمة ودفع كامل", "1805", "1805", "1773", "1", "", "32", "0"]]),
    );
    expect(parsed.missing).toEqual([]);

    const result = await applyCourierReport({ rows: parsed.rows }, ctx());

    expect(result.delivered).toBe(1);
    const order = await db.salesOrder.findUniqueOrThrow({ where: { id: sale.salesOrderId } });
    expect(order.status).toBe("DELIVERED");
    const owed = await courierOwesUs();
    expect(Number(owed.outstanding)).toBe(1773);
    expect(Number(owed.fees)).toBe(32);
  });

  it("asks somebody to look at a partial return, and moves no stock on its word", async () => {
    const { smouha } = await givenZones();
    const sale = await shipped(smouha);
    const onHand = async () =>
      (await db.inventoryLot.aggregate({ where: { variantId }, _sum: { remainingQty: true } }))._sum.remainingQty?.toString();
    const before = await onHand();

    const parsed = await parseCourierReport(
      await report([["9002", sale.orderNumber, "", "", "", "المسلمة ومرتجع جزئى", "1805", "880", "848", "1", "رجعت قطعة", "32", "0"]]),
    );
    const result = await applyCourierReport({ rows: parsed.rows }, ctx());

    expect(result.needsAttention[0]).toContain(sale.orderNumber);
    expect(await onHand()).toBe(before);
    const attention = await shipmentsNeedingAttention();
    expect(attention.map((a) => a.orderNumber)).toContain(sale.orderNumber);
    expect((await db.salesOrder.findUniqueOrThrow({ where: { id: sale.salesOrderId } })).status).toBe("SHIPPED");
  });

  it("reports references it has never sent and statuses it does not know", async () => {
    const { smouha } = await givenZones();
    const sale = await shipped(smouha);

    const parsed = await parseCourierReport(
      await report([
        ["1", "SO-NOT-OURS", "", "", "", "قيد التوصيل", "0", "0", "0", "0", "", "0", "0"],
        ["2", sale.orderNumber, "", "", "", "حالة جديدة", "0", "0", "0", "0", "", "0", "0"],
      ]),
    );
    const result = await applyCourierReport({ rows: parsed.rows }, ctx());

    expect(result.unmatched).toEqual(["SO-NOT-OURS"]);
    expect(result.unknownStatuses).toEqual(["حالة جديدة"]);
    // A word it does not know is not a delivery.
    const shipment = await db.shipment.findFirstOrThrow({ where: { reference: sale.orderNumber } });
    expect(shipment.status).toBe("NEEDS_REVIEW");
  });

  it("changes nothing when the same report is read twice", async () => {
    const { smouha } = await givenZones();
    const sale = await shipped(smouha);
    const file = await report([["9003", sale.orderNumber, "", "", "", "قيد التوصيل", "1805", "0", "0", "1", "", "32", "0"]]);

    await applyCourierReport({ rows: (await parseCourierReport(file)).rows }, ctx());
    const again = await applyCourierReport({ rows: (await parseCourierReport(file)).rows }, ctx());

    expect(again.updated).toBe(0);
    expect(again.unchanged).toBe(1);
  });

  it("reads an HTML table sent under a spreadsheet's name, as portals like this often export", async () => {
    const { smouha } = await givenZones();
    const sale = await shipped(smouha);
    const html = Buffer.from(
      `<html><body><table><tr><th>الحالة</th><th>رقم الشحنة</th><th>المدفوع</th></tr>` +
        `<tr><td>المسلمة ودفع كامل</td><td>${sale.orderNumber}</td><td>1,805.00</td></tr></table></body></html>`,
      "utf8",
    );

    const parsed = await parseCourierReport(html);
    expect(parsed.rows).toHaveLength(1);
    const result = await applyCourierReport({ rows: parsed.rows }, ctx());
    expect(result.delivered).toBe(1);
    const shipment = await db.shipment.findFirstOrThrow({ where: { reference: sale.orderNumber } });
    expect(Number(shipment.collectedAmount)).toBe(1805);
  });

  it("refuses a file that is not the courier's report rather than guessing at it", async () => {
    const parsed = await parseCourierReport(Buffer.from("<table><tr><td>hello</td></tr></table>"));
    expect(parsed.missing).toContain("رقم الشحنة");
  });
});
