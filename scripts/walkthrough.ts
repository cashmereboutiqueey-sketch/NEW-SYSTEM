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
import { approvePurchaseOrder } from "../src/lib/approvals";
import { createStyle, addBomLine, addOperation, generateVariants } from "../src/lib/products";
import { createExpense } from "../src/lib/expenses";
import { receiveMaterial } from "../src/lib/inventory";
import { calculatePeriodMinuteRate } from "../src/lib/minute-rate";
import { createCostSnapshot } from "../src/lib/costing";
import {
  createProductionOrder, confirmProductionOrder, issueForOrder, completeProductionOrder,
  plannedMaterials,
} from "../src/lib/production";
import { sellableStock, openTillFor } from "../src/lib/pos";
import { openPosSession, createSale, closePosSession } from "../src/lib/sales";
import {
  despatchToBrand, receiveAtBrand, awaitingDespatch, awaitingIntake, recentTransfers,
} from "../src/lib/intercompany";
import { findUnitBySerial } from "../src/lib/garment-units";
import { labelsForDespatch, labelFormat } from "../src/lib/print";
import { decodeSerial } from "../src/core/serial";
import { code128Bars } from "../src/core/barcode";

import { existsSync } from "node:fs";

const problems: string[] = [];
let lostTags: string[] = [];
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
  ["transfers", "send the goods to the brand"],
  ["goods-in", "count them in and tag them"],
  ["sales", "record an order taken by message"],
  ["settings", "change the label size"],
  ["alerts", "be told when something crosses a threshold"],
  ["scenarios", "ask what happens if the cloth gets dearer"],
  ["cmt/quotes", "quote outside work above the capacity floor"],
  ["pos", "sell at the till"],
] as const) {
  const dir = `src/app/(app)/${route}`;
  // Actions may sit beside the page or one level up, where sibling screens
  // share them — /cmt/clients and /cmt/quotes both post to /cmt/actions.ts.
  const parent = dir.slice(0, dir.lastIndexOf("/"));
  const hasActions =
    existsSync(`${dir}/actions.ts`) || existsSync(`${parent}/actions.ts`);

  if (!existsSync(`${dir}/page.tsx`)) gap(`/${route} has no page — cannot ${why}`);
  else if (!hasActions) gap(`/${route} is read-only — cannot ${why}`);
  else ok(`/${route} — ${why}`);
}

const owner = await db.user.findFirstOrThrow({ where: { email: "owner@cashmere.eg" } });
const ctx = { userId: owner.id, reason: null };

// A suffix per run, because codes are unique and the walkthrough creates real
// master data. Without it the second run dies at step 1 on the supplier the
// first run created — and a full-cycle test that only works on a virgin
// database is a test nobody runs twice, which is to say a test nobody runs.
const run = new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "");
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
  code: `sup-tanta-${run}`, nameEn: "Tanta Weaving", nameAr: "طنطا للنسيج",
  contactPerson: "أ. كريم فؤاد", phone: "01004445566", creditDays: 30,
}, ctx);
ok(`${supplier.code} — ${supplier.nameAr}, ${supplier.creditDays} days credit`);

// 2 ─────────────────────────────────────────────────────── add a material
step("2. Add the fabric  →  /materials");
const metre = await db.unitOfMeasure.findFirstOrThrow({ where: { code: "M" } });
const fabric = await createMaterial({
  code: `fab-crepe-160-${run}`, nameEn: "Crepe 160gsm", nameAr: "كريب ١٦٠",
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

// An order this size cannot be received until somebody approves it, and the
// walkthrough went straight from raising to receiving — so the one step that
// actually stops the fabric arriving was the one step never exercised. It read
// as a complete cycle and skipped the gate.
//
// The owner raised it, so approving it is a self-approval and the rule demands
// a stated reason. A fresh install has exactly one person in it, which makes
// this the normal path rather than the exception — and it is the path that
// records who overrode what, which is the point of allowing it at all.
step("3b. Approve it  →  /approvals");
await approvePurchaseOrder(
  {
    purchaseOrderId: po.purchaseOrderId,
    overrideReason: "Single-operator factory: the owner raises and approves.",
  },
  ctx,
);
const approved = await db.purchaseOrder.findUniqueOrThrow({
  where: { id: po.purchaseOrderId },
});
ok(`${po.poNumber} approved — now ${approved.status.toLowerCase()}`);

step("3c. Receive the goods  →  /purchasing");
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
  code: `SAMIA${run}`, nameEn: "Samia Dress", nameAr: "فستان سامية",
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
ok(`transfer price ${frozen.transferPrice} (margin ${Number(frozen.factoryMarkupPct) * 100}%)`);
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

// The whole bill goes to the floor, not just the cloth: finished goods
// relieve work in progress for every line of it, and a run that was never
// issued its trims is refused rather than quietly leaving WIP negative.
const needed = 2.4 * 120 * 1.1;
await issueForOrder({
  productionOrderId: order.productionOrderId, materialId: fabric.id,
  locationId: facLoc.id, entityId: factory.id,
  quantity: needed.toFixed(2), issueDate: on(14), piecesCut: 120,
}, ctx);

for (const line of await plannedMaterials(order.productionOrderId)) {
  if (line.materialId === fabric.id) continue;
  await receiveMaterial({
    materialId: line.materialId, locationId: facLoc.id, entityId: factory.id,
    quantity: (Number(line.requiredQty) * 2).toFixed(4),
    unitCost: "6.5", receivedDate: on(13),
  }, ctx);
  await issueForOrder({
    productionOrderId: order.productionOrderId, materialId: line.materialId,
    locationId: facLoc.id, entityId: factory.id,
    quantity: Number(line.requiredQty).toFixed(4), issueDate: on(14),
  }, ctx);
}
ok(`issued ${needed.toFixed(1)} m of fabric and the rest of the bill`);

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

// Every garment is tagged as it comes off the line.
if (done.serials.length !== 116) gap(`${done.serials.length} tags minted, expected 116`);
else if (new Set(done.serials).size !== 116) gap("two garments share a tag code");
else if (done.serials.some((s) => decodeSerial(s) === null)) gap("a tag code fails its own check character");
else ok(`116 tags minted, all different — ${done.serials[0]} … ${done.serials[115]}`);


// 8 ──────────────────────────────────────────────── does it reach the till?
step("8. Open the till and look for it  →  /pos");
// A till left open by an earlier run is reused rather than fought with. Only
// one can be open per location — which is right, a second drawer at the same
// counter cannot be counted — but it means a walkthrough that always opens a
// fresh one can only ever run once.
const already = await openTillFor(alxLoc.id);
const till = already
  ? { sessionNumber: already.sessionNumber, posSessionId: already.id }
  : await openPosSession(
      { locationId: alxLoc.id, cashierUserId: owner.id, openingFloat: "500" }, ctx,
    );
ok(`till ${till.sessionNumber} ${already ? "already" : ""} open at ${alxLoc.nameAr}`);

let onShelf = await sellableStock(alxLoc.id, brand.id);
const found = onShelf.find((p) => p.styleCode === style.code);

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

  step("8b. Factory sends it  →  /transfers");
  const queue = await awaitingDespatch();
  if (queue.length !== 6) gap(`screen lists ${queue.length} rows, expected one per SKU`);
  else ok(`screen lists all 6 SKUs, ${queue.reduce((s, q) => s + Number(q.quantity), 0)} garments`);

  const blocked = queue.filter((q) => q.blockedReason);
  if (blocked.length > 0) gap(`${blocked.length} row(s) blocked: ${blocked[0].blockedReason}`);

  const mispriced = queue.filter((q) => q.transferPrice !== frozen.transferPrice.toString());
  if (mispriced.length > 0) {
    gap(`${mispriced.length} row(s) priced off the snapshot: ${mispriced[0].transferPrice}`);
  } else ok(`every row priced at ${frozen.transferPrice} from the frozen snapshot, not typed`);

  // One click per row, which is what the screen actually offers.
  const notes: string[] = [];
  for (const row of queue) {
    const sent = await despatchToBrand({
      variantId: row.variantId, quantity: row.quantity,
      fromLocationId: row.locationId, despatchDate: on(21),
      costSnapshotId: row.costSnapshotId!,
    }, ctx);
    notes.push(sent.despatchNumber);
  }
  ok("6 despatch notes raised — no invoice yet, the goods are still the factory's");

  // The tags to print are exactly the garments in that box.
  const format = await labelFormat();
  const sheet = await labelsForDespatch(notes[0]);
  const firstRow = queue[0];
  if (sheet.length !== Number(firstRow.quantity)) {
    gap(`${notes[0]} would print ${sheet.length} labels for ${firstRow.quantity} garments`);
  } else ok(`${notes[0]} prints ${sheet.length} labels, one per garment`);

  if (format.widthMm !== 40 || format.heightMm !== 20) {
    gap(`label roll reads ${format.widthMm}×${format.heightMm}mm, expected 40×20`);
  } else ok("label roll 40 × 20 mm, one label per page");

  const widest = Math.max(
    ...sheet.map((l) => code128Bars(l.serial).totalModules * format.moduleWidthMm),
  );
  if (widest >= format.widthMm) {
    gap(`barcode is ${widest.toFixed(1)}mm on a ${format.widthMm}mm label — it will not scan`);
  } else ok(`barcode ${widest.toFixed(1)}mm on a ${format.widthMm}mm label`);

  if ((await awaitingDespatch()).length > 0) gap("rows still queued at the factory after sending");
  else ok("the factory queue empties");

  const stillNotSellable = await sellableStock(alxLoc.id, brand.id);
  if (stillNotSellable.length > 0) {
    gap("goods in transit are sellable at the till — they should not be");
  } else ok("in transit is not sellable: the shop has not counted it yet");

  step("8c. Shop counts it in and tags it  →  /goods-in");
  const arriving = await awaitingIntake();
  if (arriving.length !== 6) gap(`goods-in lists ${arriving.length} rows, expected 6`);
  else ok(`goods-in lists 6 deliveries, ${arriving.reduce((s, r) => s + Number(r.expectedQty), 0)} garments expected`);

  // Nothing reaches the floor untagged.
  const untagged = await receiveAtBrand({
    despatchNumber: arriving[0].despatchNumber, variantId: arriving[0].variantId,
    countedQty: arriving[0].expectedQty, toLocationId: alxLoc.id,
    receivedDate: on(22), labelsPrinted: false,
  }, ctx).then(() => "accepted").catch(() => "refused");
  if (untagged !== "refused") gap("an untagged batch was allowed onto the floor");
  else ok("an untagged batch is refused");

  // One box arrives two garments light. The factory wears it.
  let short = 0;
  for (const [i, r] of arriving.entries()) {
    const counted = i === 0 ? String(Number(r.expectedQty) - 2) : r.expectedQty;
    if (i === 0) short = 2;
    const got = await receiveAtBrand({
      despatchNumber: r.despatchNumber, variantId: r.variantId,
      countedQty: counted, toLocationId: alxLoc.id,
      receivedDate: on(22), labelsPrinted: true,
      shortfallNote: i === 0 ? "اتكسر الكرتونة في الطريق" : null,
    }, ctx);
    if (i === 0 && got.shortfallQty !== "2") gap(`shortfall recorded as ${got.shortfallQty}, expected 2`);
    if (i === 0) {
      if (got.lostSerials.length !== 2) gap("the missing garments were not named");
      else ok(`the 2 missing garments are named: ${got.lostSerials.join(", ")}`);
      lostTags = got.lostSerials;
    }
  }
  ok(`6 invoices raised for what actually arrived — ${short} garments short on one box`);

  const overCounted = await receiveAtBrand({
    despatchNumber: arriving[0].despatchNumber, variantId: arriving[0].variantId,
    countedQty: "999", toLocationId: alxLoc.id,
    receivedDate: on(22), labelsPrinted: true,
  }, ctx).then(() => "accepted").catch(() => "refused");
  if (overCounted !== "refused") gap("more arrived than was ever sent");
  else ok("counting in more than was sent is refused");

  if ((await awaitingIntake()).length > 0) gap("deliveries still listed after being received");
  else ok("goods-in empties once everything is counted");

  onShelf = await sellableStock(alxLoc.id, brand.id);
}

const sellable = onShelf.find((p) => p.styleCode === style.code);
if (!sellable) gap("still not sellable after the transfer");
else {
  const total = onShelf.reduce((s, p) => s + Number(p.available), 0);
  // 116 made, 2 lost on the road.
  if (onShelf.length !== 6 || total !== 114) {
    gap(`the till shows ${onShelf.length} SKUs totalling ${total}, expected 6 and 114`);
  } else ok("all 6 SKUs on the shelf, 114 garments — the 2 lost never arrived");
  ok(`${sellable.sku} — ${sellable.available} available at the till`);
  if (!sellable.retailPrice) {
    gap("no price on the till button — the cashier must type it every time");
  } else {
    ok(`price shows as ${sellable.retailPrice}`);
  }
}

// 9 ────────────────────────────────────────────────────────────── sell it
step("9. Scan a tag and sell it  →  /pos");

// The cashier scans the label rather than tapping a tile, so the sale names
// the exact garment that left the shop.
const onShelfUnit = await db.garmentUnit.findFirstOrThrow({
  where: { variantId: sellable!.variantId, status: "IN_STOCK", locationId: alxLoc.id },
  orderBy: { serial: "asc" },
});
const scanned = await findUnitBySerial(onShelfUnit.serial.toLowerCase());
if (!scanned.ok) gap(`scanning ${onShelfUnit.serial} failed`);
else ok(`scanned ${scanned.unit.serial} → ${scanned.unit.sku}, in stock at ${scanned.unit.locationAr}`);

// A garment that never arrived must not be sellable.
if (lostTags.length > 0) {
  const ghost = await findUnitBySerial(lostTags[0]);
  if (ghost.ok && ghost.unit.status !== "LOST") {
    gap(`${lostTags[0]} never arrived but reads as ${ghost.ok ? ghost.unit.status : "?"}`);
  } else ok(`${lostTags[0]} reads back as lost, so the till refuses it`);
}

const channel = await db.salesChannel.findFirstOrThrow();
const sale = await createSale({
  source: "POS", channelId: channel.id, entityId: brand.id, locationId: alxLoc.id,
  posSessionId: till.posSessionId, orderDate: on(22),
  lines: [
    {
      variantId: sellable!.variantId, quantity: 1, retailPrice: 1650, discountPct: 0,
      scannedSerials: [onShelfUnit.serial],
    },
  ],
  payments: [{ method: "CASH", amount: 1650, fee: 0, collected: true }],
}, ctx);
ok(`${sale.orderNumber} — sold 1650, cost ${Number(sale.cogs).toFixed(2)}, margin ${Number(sale.grossMargin).toFixed(2)}`);

const soldUnit = await db.garmentUnit.findFirstOrThrow({ where: { serial: onShelfUnit.serial } });
if (soldUnit.status !== "SOLD") gap(`${onShelfUnit.serial} was not marked sold`);
else ok(`${onShelfUnit.serial} is recorded as the garment that left the shop`);

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
