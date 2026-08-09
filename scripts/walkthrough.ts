/**
 * A full walkthrough, in the order a person would actually do it.
 *
 * Every step calls exactly what the corresponding button calls, so anything
 * this script cannot do is something the screens cannot do either.
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { createSupplier, createMaterial } from "../src/lib/master-data";
import { createPurchaseOrder, receiveGoods } from "../src/lib/purchasing";
import { createStyle, addBomLine, addOperation, generateVariants } from "../src/lib/products";
import { createExpense } from "../src/lib/expenses";
import { calculatePeriodMinuteRate } from "../src/lib/minute-rate";
import { createCostSnapshot } from "../src/lib/costing";
import {
  createProductionOrder, confirmProductionOrder, issueForOrder, completeProductionOrder,
} from "../src/lib/production";
import { sellableStock, openTillFor } from "../src/lib/pos";
import { openPosSession, createSale, closePosSession } from "../src/lib/sales";
import { transferToBrand, awaitingTransfer, recentTransfers } from "../src/lib/intercompany";

import { existsSync } from "node:fs";

const problems: string[] = [];
const step = (n: string) => console.log(`\n── ${n}`);
const ok = (m: string) => console.log(`   ✓ ${m}`);
const gap = (m: string) => { problems.push(m); console.log(`   ✗ ${m}`); };

// 0 ─────────────────────────────────────────────── is there a way in at all?
//
// The first run of this walkthrough passed every step while the production
// screen was read-only, because the script called the services directly. A
// screen with no server actions is a screen you can only read.
step("0. Every step in the cycle has a screen with buttons on it");
for (const [route, why] of [
  ["suppliers", "add a supplier"],
  ["materials", "add a material"],
  ["purchasing", "raise an order and receive the goods"],
  ["styles", "create a product, its BOM and its SKUs"],
  ["expenses", "post the factory's costs"],
  ["minute-rate", "calculate the minute rate"],
  ["costing", "freeze a cost"],
  ["production", "raise, confirm, issue and close a run"],
  ["transfers", "invoice the goods to the brand"],
  ["pos", "sell at the till"],
] as const) {
  const dir = `src/app/(app)/${route}`;
  if (!existsSync(`${dir}/page.tsx`)) gap(`/${route} has no page — cannot ${why}`);
  else if (!existsSync(`${dir}/actions.ts`)) gap(`/${route} is read-only — cannot ${why}`);
  else ok(`/${route} — ${why}`);
}

const owner = await db.user.findFirstOrThrow({ where: { email: "owner@cashmere.eg" } });
const ctx = { userId: owner.id, reason: null };
const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });
const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });
const facLoc = await db.location.findFirstOrThrow({ where: { code: "LOC-FAC" } });
const alxLoc = await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } });
const period = await db.fiscalPeriod.findFirstOrThrow({
  where: { status: "OPEN" }, orderBy: { startDate: "asc" },
});
const day = new Date(period.startDate);
const on = (d: number) => new Date(day.getTime() + d * 86_400_000);

// 1 ──────────────────────────────────────────────────────── add a supplier
step("1. Add a supplier  →  /suppliers");
const supplier = await createSupplier({
  code: "sup-tanta", nameEn: "Tanta Weaving", nameAr: "طنطا للنسيج",
  contactPerson: "أ. كريم فؤاد", phone: "01004445566", creditDays: 30,
}, ctx);
ok(`${supplier.code} — ${supplier.nameAr}, ${supplier.creditDays} days credit`);

// 2 ─────────────────────────────────────────────────────── add a material
step("2. Add the fabric  →  /materials");
const metre = await db.unitOfMeasure.findFirstOrThrow({ where: { code: "M" } });
const fabric = await createMaterial({
  code: "fab-crepe-160", nameEn: "Crepe 160gsm", nameAr: "كريب ١٦٠",
  type: "FABRIC", uomId: metre.id, supplierId: supplier.id,
  basePrice: 195, freightPct: 0.03, dutyPct: 0.02,
  moq: 100, packSize: 50, leadTimeDays: 12, reorderPoint: 150,
  composition: "100% Viscose", gsm: 160, widthCm: 150,
}, ctx);
const landed = await db.materialPriceHistory.findFirstOrThrow({ where: { materialId: fabric.id } });
ok(`${fabric.code} — 195 + 5% = ${landed.effectiveCost} landed`);

const trim = await db.material.findFirstOrThrow({ where: { type: "TRIM" } });
ok(`using existing trim ${trim.code} as a second BOM line`);

// 3 ──────────────────────────────────────────────────────── buy the fabric
step("3. Raise a purchase order  →  /purchasing");
const po = await createPurchaseOrder({
  supplierId: supplier.id, orderDate: day, expectedDate: on(12),
  lines: [{ materialId: fabric.id, quantity: 600, unitPrice: 195 }],
}, ctx);
ok(`${po.poNumber} for ${Number(po.total).toFixed(2)}`);

const poLine = await db.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: po.purchaseOrderId } });
const receipt = await receiveGoods({
  purchaseOrderId: po.purchaseOrderId, receivedDate: on(12),
  locationId: facLoc.id, entityId: factory.id, invoiceRef: "INV-TW-4471",
  // The supplier invoiced higher than quoted, which is the normal case.
  lines: [{ purchaseOrderLineId: poLine.id, acceptedQty: 580, rejectedQty: 20, actualUnitPrice: 205 }],
}, ctx);
ok(`${receipt.receiptNumber} — 580 accepted, 20 rejected, variance ${Number(receipt.priceVariance).toFixed(2)}`);

const rawLot = await db.inventoryLot.findFirstOrThrow({ where: { materialId: fabric.id } });
if (rawLot.remainingQty.toString() !== "580") gap(`stock should be 580, is ${rawLot.remainingQty}`);
else ok(`580 m in stock at ${rawLot.unitCost}/m`);

// 4 ───────────────────────────────────────────────────── create the product
step("4. Create the product  →  /styles");
const collection = await db.collection.findFirstOrThrow();
const style = await createStyle({
  code: "SAMIA", nameEn: "Samia Dress", nameAr: "فستان سامية",
  collectionId: collection.id, plannedWasteRate: 0.1, retailPrice: 1650,
}, ctx);
ok(`${style.code} created, planned waste ${Number(style.plannedWasteRate) * 100}%`);

await addBomLine({ styleId: style.id, materialId: fabric.id, standardConsumption: 2.4 }, ctx);
await addBomLine({ styleId: style.id, materialId: trim.id, standardConsumption: 1 }, ctx);
ok("bill of materials: 2.4 m fabric + 1 trim");

for (const [en, arName, min] of [
  ["Cutting", "قص", 5.5], ["Sewing", "خياطة", 26], ["Finishing", "تشطيب", 4], ["Pressing", "مكوى", 3.5],
] as const) {
  await addOperation({ styleId: style.id, nameEn: en, nameAr: arName, smvMinutes: min }, ctx);
}
const withSmv = await db.style.findUniqueOrThrow({ where: { id: style.id } });
ok(`operations total ${withSmv.totalSmvMinutes} SMV (5.5+26+4+3.5)`);

const colours = await db.colorCode.findMany({ where: { code: { in: ["BLK", "CRM"] } } });
const sizes = await db.sizeCode.findMany({ where: { code: { in: ["M", "L", "XL"] } } });
const variants = await generateVariants({
  styleId: style.id,
  colorCodeIds: colours.map((c) => c.id),
  sizeCodeIds: sizes.map((s) => s.id),
}, ctx);
ok(`${variants.created} SKUs: ${variants.skus.slice(0, 3).join(", ")}…`);

// 5 ───────────────────────────────────────────── the factory's running costs
step("5. Post the month's factory costs  →  /expenses");
for (const [code, amount] of [
  ["FAC-DIRECT-LABOUR", 268000], ["FAC-RENT", 55000], ["FAC-UTILITIES", 41000],
] as const) {
  const cat = await db.costCategory.findFirstOrThrow({ where: { code, entityId: factory.id } });
  await createExpense({
    entityId: factory.id, costCategoryId: cat.id, description: code,
    amount, incurredDate: day, dueDate: on(10),
  }, ctx);
}
const rate = await calculatePeriodMinuteRate(
  { entityId: factory.id, fiscalPeriodId: period.id }, ctx,
);
ok(`minute rate ${Number(rate.actualMinuteRate).toFixed(4)} EGP/min  →  /minute-rate`);

// 6 ─────────────────────────────────────────────────────────── cost it
step("6. Cost the style  →  /costing");
const snap = await createCostSnapshot(
  { styleId: style.id, minuteRatePeriodId: rate.minuteRatePeriodId, reason: "First run" }, ctx,
);
const frozen = await db.costSnapshot.findUniqueOrThrow({ where: { id: snap.costSnapshotId } });
ok(`materials ${frozen.materialCost} + labour ${frozen.cmtCost} = ${frozen.factoryTotalCost}`);
ok(`transfer price ${frozen.transferPrice} (margin ${Number(frozen.factoryMarginPct) * 100}%)`);
if (Number(frozen.transferPrice) > 1650) {
  gap(`transfer price ${frozen.transferPrice} exceeds the 1650 retail price — the brand would lose money`);
}

// 7 ─────────────────────────────────────────────────────────── make it
step("7. Manufacture  →  /production");
const order = await createProductionOrder(
  { styleId: style.id, plannedQty: 120, orderDate: on(13) }, ctx,
);
await confirmProductionOrder(
  { productionOrderId: order.productionOrderId, minuteRatePeriodId: rate.minuteRatePeriodId }, ctx,
);
ok(`${order.orderNumber} confirmed for 120`);

const needed = 2.4 * 120 * 1.1;
await issueForOrder({
  productionOrderId: order.productionOrderId, materialId: fabric.id,
  locationId: facLoc.id, entityId: factory.id,
  quantity: needed.toFixed(2), issueDate: on(14), piecesCut: 120,
}, ctx);
ok(`issued ${needed.toFixed(1)} m of fabric`);

// A real run comes off the line as a size curve.
const madeSkus = await db.variant.findMany({
  where: { styleId: style.id }, orderBy: { sku: "asc" },
});
const curve = [30, 26, 18, 20, 14, 8]; // 116 across six SKUs
const done = await completeProductionOrder({
  productionOrderId: order.productionOrderId,
  outputs: madeSkus.map((v, i) => ({ variantId: v.id, goodQty: curve[i] })),
  rejectedQty: 4, locationId: facLoc.id,
  entityId: factory.id, completedDate: on(20),
}, ctx);
if (done.goodQty !== 116) gap(`size curve totals ${done.goodQty}, expected 116`);
else ok(`116 good across ${done.finishedLotNumbers.length} SKUs, 4 rejected`);


// 8 ──────────────────────────────────────────────── does it reach the till?
step("8. Open the till and look for it  →  /pos");
const till = await openPosSession(
  { locationId: alxLoc.id, cashierUserId: owner.id, openingFloat: "500" }, ctx,
);
ok(`till ${till.sessionNumber} open at ${alxLoc.nameAr}`);

let onShelf = await sellableStock(alxLoc.id, brand.id);
const found = onShelf.find((p) => p.styleCode === "SAMIA");

if (!found) {
  ok("nothing on the shelf yet — the goods are still the factory's");

  // The till now says so instead of showing a blank grid.
  const stuck = await db.inventoryLot.aggregate({
    where: {
      state: "FINISHED_GOODS", remainingQty: { gt: 0 },
      variantId: { not: null }, entity: { kind: "FACTORY" },
    },
    _sum: { remainingQty: true },
  });
  if (Number(stuck._sum.remainingQty ?? 0) !== 116) gap("the till's explanation would show the wrong count");
  else ok("the till explains it: 116 waiting at the factory, with a link to /transfers");

  step("8b. Transfer factory → brand  →  /transfers");
  const queue = await awaitingTransfer();
  if (queue.length !== 6) gap(`screen lists ${queue.length} rows, expected one per SKU`);
  else ok(`screen lists all 6 SKUs, ${queue.reduce((s, q) => s + Number(q.quantity), 0)} garments`);

  const blocked = queue.filter((q) => q.blockedReason);
  if (blocked.length > 0) gap(`${blocked.length} row(s) blocked: ${blocked[0].blockedReason}`);

  const mispriced = queue.filter((q) => q.transferPrice !== frozen.transferPrice.toString());
  if (mispriced.length > 0) {
    gap(`${mispriced.length} row(s) priced off the snapshot: ${mispriced[0].transferPrice}`);
  } else ok(`every row priced at ${frozen.transferPrice} from the frozen snapshot, not typed`);

  // One click per row, which is what the screen actually offers.
  for (const row of queue) {
    await transferToBrand({
      variantId: row.variantId, quantity: row.quantity,
      fromLocationId: row.locationId, toLocationId: alxLoc.id,
      transferDate: on(21), costSnapshotId: row.costSnapshotId!,
    }, ctx);
  }
  ok(`6 internal invoices raised, margin ${Number(queue[0].marginPerUnit).toFixed(2)}/unit`);

  const left = await awaitingTransfer();
  if (left.length > 0) gap(`${left.length} row(s) still queued after transferring`);
  else ok("the queue empties once everything is invoiced");

  onShelf = await sellableStock(alxLoc.id, brand.id);
}

const sellable = onShelf.find((p) => p.styleCode === "SAMIA");
if (!sellable) gap("still not sellable after the transfer");
else {
  const total = onShelf.reduce((s, p) => s + Number(p.available), 0);
  if (onShelf.length !== 6 || total !== 116) {
    gap(`the till shows ${onShelf.length} SKUs totalling ${total}, expected 6 and 116`);
  } else ok("all 6 SKUs on the shelf, 116 garments");
  ok(`${sellable.sku} — ${sellable.available} available at the till`);
  if (!sellable.retailPrice) {
    gap("no price on the till button — the cashier must type it every time");
  } else {
    ok(`price shows as ${sellable.retailPrice}`);
  }
}

// 9 ────────────────────────────────────────────────────────────── sell it
step("9. Sell one  →  /pos");
const channel = await db.salesChannel.findFirstOrThrow();
const sale = await createSale({
  source: "POS", channelId: channel.id, entityId: brand.id, locationId: alxLoc.id,
  posSessionId: till.posSessionId, orderDate: on(22),
  lines: [{ variantId: sellable!.variantId, quantity: 1, retailPrice: 1650, discountPct: 0 }],
  payments: [{ method: "CASH", amount: 1650, fee: 0, collected: true }],
}, ctx);
ok(`${sale.orderNumber} — sold 1650, cost ${Number(sale.cogs).toFixed(2)}, margin ${Number(sale.grossMargin).toFixed(2)}`);

const closed = await closePosSession(
  { posSessionId: till.posSessionId, countedCash: "2150" }, ctx,
);
ok(`till closed, drawer variance ${closed.variance}`);

// 10 ───────────────────────────────────────────────────────── did it add up?
step("10. Check the books");
const [row] = await db.$queryRaw<{ d: string; c: string }[]>`
  SELECT COALESCE(SUM(l."debit"),0)::text AS d, COALESCE(SUM(l."credit"),0)::text AS c
  FROM "journal_lines" l JOIN "journal_entries" e ON e."id" = l."journalEntryId"
  WHERE e."status" = 'POSTED'`;
if (row.d !== row.c) gap(`ledger out of balance: ${row.d} vs ${row.c}`);
else ok(`ledger balances at ${Number(row.d).toFixed(2)}`);

const [past] = await recentTransfers();
if (!past) gap("the transfer history is empty after transferring");
else ok(`history shows ${past.transferNumber}, ${past.unsoldQty} still unsold (unrealised margin)`);

const remaining = await db.inventoryLot.findFirst({
  where: { variantId: sellable!.variantId, entityId: brand.id, remainingQty: { gt: 0 } },
});
ok(`${remaining?.remainingQty ?? 0} garments left on the shelf`);

console.log("\n" + "═".repeat(60));
if (problems.length === 0) console.log("No gaps found.");
else {
  console.log(`${problems.length} thing(s) to fix:\n`);
  problems.forEach((p, i) => console.log(`${i + 1}. ${p}`));
}

await db.$disconnect();
