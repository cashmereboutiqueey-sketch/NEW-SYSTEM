import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { createExpense } from "./expenses";
import { calculatePeriodMinuteRate } from "./minute-rate";
import { receiveMaterial } from "./inventory";
import {
  createProductionOrder,
  confirmProductionOrder,
  issueForOrder,
  completeProductionOrder,
} from "./production";
import { despatchToBrand, receiveAtBrand, awaitingDespatch } from "./intercompany";
import { createSale } from "./sales";
import { findUnitBySerial, unitsForDespatch, writeOffUnit } from "./garment-units";
import { decodeSerial, encodeSerial } from "@/core/serial";

/**
 * Individual garments, followed from the moment they come off the line to the
 * moment somebody carries one out of the shop.
 *
 * The point of the whole mechanism is that "which one" is answerable. These
 * tests ask it at each step.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let factoryId: string;
let brandId: string;
let factoryLocationId: string;
let showroomId: string;
let cairoId: string;
let styleId: string;
let variantIds: string[];
let fabricId: string;
let periodId: string;
let rateperiodId: string;
let channelId: string;
let day: Date;

const ctx = { userId: null as string | null, reason: null };

beforeAll(async () => {
  factoryId = (await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } })).id;
  brandId = (await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } })).id;
  factoryLocationId = (await db.location.findFirstOrThrow({ where: { code: "LOC-FAC" } })).id;
  showroomId = (await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } })).id;
  cairoId = (await db.location.findFirstOrThrow({ where: { code: "LOC-CAI" } })).id;
  channelId = (await db.salesChannel.findFirstOrThrow()).id;

  const style = await db.style.findFirstOrThrow({
    where: {
      operations: { some: {} },
      bomLines: { some: { material: { type: "FABRIC" } } },
    },
    include: { bomLines: { include: { material: true } }, variants: true },
  });
  styleId = style.id;
  variantIds = style.variants.map((v) => v.id);
  fabricId = style.bomLines.find((l) => l.material.type === "FABRIC")!.materialId;

  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" }, orderBy: { startDate: "asc" },
  });
  periodId = period.id;
  day = new Date(period.startDate);
});

async function wipe() {
  await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
  await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
  try {
    await db.garmentUnit.deleteMany({});
    await db.settlementLine.deleteMany({});
    await db.settlement.deleteMany({});
    await db.salesPayment.deleteMany({});
    await db.salesOrderLine.deleteMany({});
    await db.salesOrder.deleteMany({});
    await db.materialIssue.deleteMany({});
    await db.capacityBooking.deleteMany({});
    await db.productionOrderLine.deleteMany({});
    await db.inventoryMovement.deleteMany({});
    await db.inventoryLot.deleteMany({});
    await db.productionOrder.deleteMany({});
    await db.costSnapshotLine.deleteMany({});
    await db.costSnapshot.deleteMany({});
    await db.minuteRateComponent.deleteMany({});
    await db.minuteRatePeriod.deleteMany({});
    await db.bankStatementLine.deleteMany({});
    await db.bankStatement.deleteMany({});
    await db.journalLine.deleteMany({});
    await db.journalEntry.deleteMany({});
    await db.expense.deleteMany({});
    await db.auditLog.deleteMany({});
    await db.documentSequence.deleteMany({});
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
  }
}

beforeEach(async () => {
  await wipe();

  const cat = await db.costCategory.findFirstOrThrow({
    where: { code: "FAC-RENT", entityId: factoryId },
  });
  await createExpense(
    {
      entityId: factoryId, costCategoryId: cat.id, description: "Conversion pool",
      amount: 568000, incurredDate: day, dueDate: day,
    },
    ctx,
  );
  const rate = await calculatePeriodMinuteRate(
    { entityId: factoryId, fiscalPeriodId: periodId }, ctx,
  );
  rateperiodId = rate.minuteRatePeriodId;

  await receiveMaterial(
    {
      materialId: fabricId, locationId: factoryLocationId, entityId: factoryId,
      quantity: "5000", unitCost: "172.20", receivedDate: day,
    },
    ctx,
  );
});

afterAll(async () => { await wipe(); await db.$disconnect(); });

/** Makes a run and hands back the serials it produced. */
async function makeRun(curve: number[]): Promise<string[]> {
  const total = curve.reduce((s, n) => s + n, 0);
  const order = await createProductionOrder(
    { styleId, plannedQty: total, orderDate: day }, ctx,
  );
  await confirmProductionOrder(
    { productionOrderId: order.productionOrderId, minuteRatePeriodId: rateperiodId }, ctx,
  );
  await issueForOrder(
    {
      productionOrderId: order.productionOrderId, materialId: fabricId,
      locationId: factoryLocationId, entityId: factoryId,
      quantity: String(total * 3), issueDate: day, piecesCut: total,
    },
    ctx,
  );
  const done = await completeProductionOrder(
    {
      productionOrderId: order.productionOrderId,
      outputs: curve.map((goodQty, i) => ({ variantId: variantIds[i], goodQty })),
      locationId: factoryLocationId, entityId: factoryId, completedDate: day,
    },
    ctx,
  );
  return done.serials;
}

describe("a garment gets its own code when it is made", () => {
  it("mints one code per garment, all different", async () => {
    const serials = await makeRun([5, 3]);

    expect(serials).toHaveLength(8);
    expect(new Set(serials).size).toBe(8);
    for (const serial of serials) {
      expect(serial).toHaveLength(8);
      expect(decodeSerial(serial)).not.toBeNull();
    }
  });

  it("gives two garments of the same SKU different codes", async () => {
    await makeRun([4]);

    const units = await db.garmentUnit.findMany({ where: { variantId: variantIds[0] } });
    expect(units).toHaveLength(4);
    expect(new Set(units.map((u) => u.serial)).size).toBe(4);
  });

  it("ties each garment to its SKU, run and lot", async () => {
    await makeRun([3, 2]);

    const units = await db.garmentUnit.findMany({ include: { lot: true } });
    expect(units).toHaveLength(5);
    for (const unit of units) {
      expect(unit.status).toBe("MADE");
      expect(unit.entityId).toBe(factoryId);
      expect(unit.locationId).toBe(factoryLocationId);
      expect(unit.productionOrderId).not.toBeNull();
      expect(unit.lot?.variantId).toBe(unit.variantId);
    }
    // The size curve is reflected in the tags, not just in the lot quantities.
    const bySku = new Map<string, number>();
    for (const u of units) bySku.set(u.variantId, (bySku.get(u.variantId) ?? 0) + 1);
    expect([...bySku.values()].sort()).toEqual([2, 3]);
  });

  it("never reuses a code across runs", async () => {
    const first = await makeRun([4]);
    const second = await makeRun([4]);

    expect(new Set([...first, ...second]).size).toBe(8);
  });
});

describe("following a garment to the shop", () => {
  async function send(quantity: number) {
    const [row] = await awaitingDespatch();
    return despatchToBrand(
      {
        variantId: row.variantId, quantity: String(quantity),
        fromLocationId: factoryLocationId, despatchDate: day,
        costSnapshotId: row.costSnapshotId!,
      },
      ctx,
    );
  }

  it("marks the garments in the box as on the road", async () => {
    await makeRun([6]);
    const sent = await send(6);

    const units = await db.garmentUnit.findMany({ where: { variantId: variantIds[0] } });
    for (const unit of units) expect(unit.status).toBe("IN_TRANSIT");

    // And the labels to print are exactly those garments.
    const forPrinting = await unitsForDespatch(sent.despatchNumber);
    expect(forPrinting).toHaveLength(6);
  });

  it("puts the counted garments on the floor, tagged", async () => {
    await makeRun([6]);
    const sent = await send(6);

    const got = await receiveAtBrand(
      {
        despatchNumber: sent.despatchNumber, variantId: variantIds[0],
        countedQty: "6", toLocationId: showroomId,
        receivedDate: day, labelsPrinted: true,
      },
      ctx,
    );

    expect(got.receivedSerials).toHaveLength(6);
    expect(got.lostSerials).toHaveLength(0);

    const units = await db.garmentUnit.findMany({ where: { variantId: variantIds[0] } });
    for (const unit of units) {
      expect(unit.status).toBe("IN_STOCK");
      expect(unit.entityId).toBe(brandId);
      expect(unit.locationId).toBe(showroomId);
      expect(unit.labelPrintedAt).not.toBeNull();
    }
  });

  it("names the garments that never arrived", async () => {
    await makeRun([6]);
    const sent = await send(6);

    const got = await receiveAtBrand(
      {
        despatchNumber: sent.despatchNumber, variantId: variantIds[0],
        countedQty: "4", toLocationId: showroomId,
        receivedDate: day, labelsPrinted: true, shortfallNote: "carton torn open",
      },
      ctx,
    );

    // This is the thing a shared barcode cannot do: say which two are gone.
    expect(got.lostSerials).toHaveLength(2);
    expect(got.receivedSerials).toHaveLength(4);

    const lost = await db.garmentUnit.findMany({
      where: { serial: { in: got.lostSerials } },
    });
    for (const unit of lost) {
      expect(unit.status).toBe("LOST");
      expect(unit.lotId).toBeNull();
      expect(unit.locationId).toBeNull();
      expect(unit.writeOffNote).toBe("carton torn open");
    }
  });

  it("leaves no garment in limbo when a delivery is short", async () => {
    await makeRun([10]);
    const sent = await send(10);
    await receiveAtBrand(
      {
        despatchNumber: sent.despatchNumber, variantId: variantIds[0],
        countedQty: "7", toLocationId: showroomId,
        receivedDate: day, labelsPrinted: true,
      },
      ctx,
    );

    const stillTravelling = await db.garmentUnit.count({ where: { status: "IN_TRANSIT" } });
    expect(stillTravelling).toBe(0);
    expect(await db.garmentUnit.count({ where: { status: "IN_STOCK" } })).toBe(7);
    expect(await db.garmentUnit.count({ where: { status: "LOST" } })).toBe(3);
  });
});

describe("selling a particular garment", () => {
  async function stockTheShop(quantity: number): Promise<string[]> {
    await makeRun([quantity]);
    const [row] = await awaitingDespatch();
    const sent = await despatchToBrand(
      {
        variantId: row.variantId, quantity: String(quantity),
        fromLocationId: factoryLocationId, despatchDate: day,
        costSnapshotId: row.costSnapshotId!,
      },
      ctx,
    );
    const got = await receiveAtBrand(
      {
        despatchNumber: sent.despatchNumber, variantId: variantIds[0],
        countedQty: String(quantity), toLocationId: showroomId,
        receivedDate: day, labelsPrinted: true,
      },
      ctx,
    );
    return got.receivedSerials;
  }

  async function sell(quantity: number, scannedSerials?: string[]) {
    return createSale(
      {
        source: "MANUAL", channelId, entityId: brandId, locationId: showroomId,
        orderDate: day,
        lines: [
          { variantId: variantIds[0], quantity, retailPrice: 1200, discountPct: 0, scannedSerials },
        ],
        payments: [{ method: "CASH", amount: 1200 * quantity, fee: 0, collected: true }],
      },
      ctx,
    );
  }

  it("sells the exact garment that was scanned", async () => {
    const serials = await stockTheShop(5);
    const chosen = serials[3];

    await sell(1, [chosen]);

    const sold = await db.garmentUnit.findFirstOrThrow({ where: { serial: chosen } });
    expect(sold.status).toBe("SOLD");
    expect(sold.soldAt).not.toBeNull();
    expect(sold.salesOrderLineId).not.toBeNull();

    // And nothing else moved.
    expect(await db.garmentUnit.count({ where: { status: "IN_STOCK" } })).toBe(4);
  });

  it("ties the garment to the line that sold it", async () => {
    const serials = await stockTheShop(3);
    const order = await sell(1, [serials[0]]);

    const unit = await db.garmentUnit.findFirstOrThrow({
      where: { serial: serials[0] },
      include: { salesOrderLine: { include: { salesOrder: true } } },
    });
    expect(unit.salesOrderLine?.salesOrder.orderNumber).toBe(order.orderNumber);
  });

  it("falls back to oldest first when the cashier tapped instead of scanning", async () => {
    const serials = await stockTheShop(4);

    await sell(2);

    const sold = await db.garmentUnit.findMany({
      where: { status: "SOLD" }, orderBy: { serial: "asc" },
    });
    expect(sold.map((u) => u.serial)).toEqual(serials.slice(0, 2).sort());
  });

  it("keeps the tags and the lot telling the same story", async () => {
    await stockTheShop(6);
    await sell(2);

    const inStock = await db.garmentUnit.count({ where: { status: "IN_STOCK" } });
    const lot = await db.inventoryLot.findFirstOrThrow({
      where: { entityId: brandId, variantId: variantIds[0], remainingQty: { gt: 0 } },
    });

    expect(inStock).toBe(Number(lot.remainingQty));
  });
});

describe("reading a tag", () => {
  it("finds the garment and says where it is", async () => {
    const serials = await makeRun([3]);

    const found = await findUnitBySerial(serials[0]);
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.unit.status).toBe("MADE");
      expect(found.unit.serial).toBe(serials[0]);
      expect(found.unit.sku).toBeTruthy();
    }
  });

  it("accepts what a scanner hands over, whatever its case", async () => {
    const serials = await makeRun([2]);

    const found = await findUnitBySerial(` ${serials[0].toLowerCase()} `);
    expect(found.ok).toBe(true);
  });

  it("calls out a garbled scan rather than saying nothing was found", async () => {
    const serials = await makeRun([2]);

    // Break one character: the check character catches it.
    const broken =
      serials[0].slice(0, 3) +
      (serials[0][3] === "K" ? "M" : "K") +
      serials[0].slice(4);

    const found = await findUnitBySerial(broken);
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.reason).toBe("MALFORMED");
  });

  it("reports an unknown but well-formed code separately", async () => {
    // Well-formed, check character and all, but far past anything minted:
    // a tag from another shop, or one typed out of thin air.
    const found = await findUnitBySerial(encodeSerial(9_000_000));
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.reason).toBe("UNKNOWN");
  });
});

describe("writing a garment off", () => {
  it("marks it lost and records why", async () => {
    const serials = await makeRun([3]);

    await writeOffUnit({ serial: serials[1], note: "damaged on the rail" }, ctx);

    const unit = await db.garmentUnit.findFirstOrThrow({ where: { serial: serials[1] } });
    expect(unit.status).toBe("LOST");
    expect(unit.writeOffNote).toBe("damaged on the rail");

    const log = await db.auditLog.findFirstOrThrow({
      where: { action: "GARMENT_UNIT_WRITTEN_OFF" },
    });
    expect(log.entityId).toBe(unit.id);
  });

  it("refuses to write off something already sold", async () => {
    await makeRun([2]);
    const [row] = await awaitingDespatch();
    const sent = await despatchToBrand(
      {
        variantId: row.variantId, quantity: "2",
        fromLocationId: factoryLocationId, despatchDate: day,
        costSnapshotId: row.costSnapshotId!,
      },
      ctx,
    );
    const got = await receiveAtBrand(
      {
        despatchNumber: sent.despatchNumber, variantId: variantIds[0],
        countedQty: "2", toLocationId: showroomId,
        receivedDate: day, labelsPrinted: true,
      },
      ctx,
    );
    await createSale(
      {
        source: "MANUAL", channelId, entityId: brandId, locationId: showroomId,
        orderDate: day,
        lines: [
          {
            variantId: variantIds[0], quantity: 1, retailPrice: 1200, discountPct: 0,
            scannedSerials: [got.receivedSerials[0]],
          },
        ],
        payments: [{ method: "CASH", amount: 1200, fee: 0, collected: true }],
      },
      ctx,
    );

    await expect(
      writeOffUnit({ serial: got.receivedSerials[0], note: "cannot find it" }, ctx),
    ).rejects.toThrow(/was sold/i);
  });
});
