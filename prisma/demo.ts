/**
 * Cashmere OS — a full business cycle, for looking at.
 *
 * Runs one realistic month end to end so every screen has something real on
 * it: conversion costs posted, a minute rate calculated, a style costed, a
 * production order made and completed, stock transferred to the Brand, sales
 * through all three channels, customers, payroll.
 *
 * This is DEMONSTRATION data, not sample master data. It is deliberately kept
 * out of `seed.ts`, which seeds only master and reference records — a seeded
 * "answer" would be a fiction, and this file exists so it is obvious which is
 * which.
 *
 * Run:  npm run db:demo
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { createExpense, payExpense } from "../src/lib/expenses";
import { calculatePeriodMinuteRate } from "../src/lib/minute-rate";
import { createCostSnapshot } from "../src/lib/costing";
import { receiveMaterial } from "../src/lib/inventory";
import {
  createProductionOrder, confirmProductionOrder, issueForOrder, completeProductionOrder,
} from "../src/lib/production";
import { transferToBrand } from "../src/lib/intercompany";
import { createSale, openPosSession, closePosSession } from "../src/lib/sales";
import { upsertCustomerContact } from "../src/lib/crm";
import {
  importPunches, deriveAttendance, adjustAttendance,
  preparePayrollRun, approveAndPostPayroll,
} from "../src/lib/payroll";

async function main() {
  console.log("→ Running a full demonstration cycle…");

  const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });
  const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });
  const facLoc = await db.location.findFirstOrThrow({ where: { code: "LOC-FAC" } });
  const alxLoc = await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } });
  const owner = await db.user.findFirstOrThrow({ where: { email: "owner@cashmere.eg" } });
  const accountant = await db.user.findFirstOrThrow({ where: { email: "accountant@cashmere.eg" } });
  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" }, orderBy: { startDate: "asc" },
  });

  const day = new Date(period.startDate);
  const on = (offset: number) => {
    const d = new Date(day);
    d.setUTCDate(d.getUTCDate() + offset);
    return d;
  };
  const asOwner = { userId: owner.id, reason: null };
  const cat = async (code: string, entityId: string) =>
    (await db.costCategory.findFirstOrThrow({ where: { code, entityId } })).id;

  // ---------------------------------------------------------------- expenses
  const factoryCosts: [string, number, string][] = [
    ["FAC-DIRECT-LABOUR", 268000, "أجور عمال الإنتاج — أغسطس"],
    ["FAC-INDIRECT-LABOUR", 96000, "مشرفين وفنيين وجودة"],
    ["FAC-RENT", 55000, "إيجار المصنع"],
    ["FAC-UTILITIES", 41000, "كهرباء ومياه"],
    ["FAC-MAINTENANCE", 22000, "صيانة المكن"],
    ["FAC-DEPRECIATION", 48000, "إهلاك الآلات"],
    ["FAC-ADMIN", 38000, "إدارة المصنع"],
  ];
  for (const [code, amount, description] of factoryCosts) {
    await createExpense(
      {
        entityId: factory.id, costCategoryId: await cat(code, factory.id),
        description, amount, incurredDate: on(1), dueDate: on(10),
      },
      asOwner,
    );
  }

  // Brand-side costs. The rent falls due early in the month so it is already
  // overdue by the time anyone looks, giving the aging report something real.
  const brandCosts: [string, number, string, number][] = [
    ["BRD-SALARIES", 62000, "رواتب البراند", 12],
    ["BRD-RENT", 38000, "إيجار المعرض", 2],
    ["BRD-MARKETING", 45000, "إعلانات فيسبوك وإنستجرام", 15],
    ["BRD-SOFTWARE", 4200, "اشتراكات برمجيات", 20],
  ];
  for (const [code, amount, description, dueOffset] of brandCosts) {
    const e = await createExpense(
      {
        entityId: brand.id, costCategoryId: await cat(code, brand.id),
        description, amount, incurredDate: on(1), dueDate: on(dueOffset),
      },
      asOwner,
    );
    if (code === "BRD-SOFTWARE") {
      await payExpense(
        { expenseId: e.expenseId, amount, paidDate: on(20), method: "BANK" },
        asOwner,
      );
    }
  }
  console.log(`  expenses: ${factoryCosts.length + brandCosts.length}`);

  // ------------------------------------------------------------- minute rate
  const rate = await calculatePeriodMinuteRate(
    { entityId: factory.id, fiscalPeriodId: period.id }, asOwner,
  );
  console.log(`  minute rate: ${Number(rate.actualMinuteRate).toFixed(4)} EGP/min`);

  // ------------------------------------------------------------- style cost
  const style = await db.style.findFirstOrThrow({
    where: { operations: { some: {} }, bomLines: { some: { material: { type: "FABRIC" } } } },
    include: { bomLines: { include: { material: true } }, variants: true },
  });
  const fabric = style.bomLines.find((l) => l.material.type === "FABRIC")!;

  const snapshot = await createCostSnapshot(
    { styleId: style.id, minuteRatePeriodId: rate.minuteRatePeriodId, reason: "تسعير دفعة أغسطس" },
    asOwner,
  );
  const snap = await db.costSnapshot.findUniqueOrThrow({ where: { id: snapshot.costSnapshotId } });
  console.log(`  ${style.code}: cost ${snap.factoryTotalCost} → transfer ${snap.transferPrice}`);

  // --------------------------------------------------------------- materials
  await receiveMaterial(
    {
      materialId: fabric.materialId, locationId: facLoc.id, entityId: factory.id,
      quantity: "1200", unitCost: "172.20", receivedDate: on(2),
    },
    asOwner,
  );
  // A second, dearer lot so FIFO has two layers to consume.
  await receiveMaterial(
    {
      materialId: fabric.materialId, locationId: facLoc.id, entityId: factory.id,
      quantity: "600", unitCost: "189.40", receivedDate: on(12),
    },
    asOwner,
  );

  // -------------------------------------------------------------- production
  const RUN = 400;
  const po = await createProductionOrder(
    { styleId: style.id, plannedQty: RUN, orderDate: on(3) }, asOwner,
  );
  await confirmProductionOrder(
    { productionOrderId: po.productionOrderId, minuteRatePeriodId: rate.minuteRatePeriodId },
    asOwner,
  );
  // Issued 12% over the waste-free standard, so the variance report is real.
  const issued = Number(fabric.standardConsumption) * RUN * 1.12;
  await issueForOrder(
    {
      productionOrderId: po.productionOrderId, materialId: fabric.materialId,
      locationId: facLoc.id, entityId: factory.id,
      quantity: issued.toFixed(4), issueDate: on(5), piecesCut: RUN,
    },
    asOwner,
  );
  await completeProductionOrder(
    {
      productionOrderId: po.productionOrderId, goodQty: 388, rejectedQty: 12,
      variantId: style.variants[0].id, locationId: facLoc.id,
      entityId: factory.id, completedDate: on(14),
    },
    asOwner,
  );
  console.log(`  production: ${po.orderNumber} — 400 planned, 388 good, 12 rejected`);

  // ------------------------------------------------------------- transfer
  const transfer = await transferToBrand(
    {
      variantId: style.variants[0].id, quantity: "388",
      fromLocationId: facLoc.id, toLocationId: alxLoc.id,
      transferDate: on(15), costSnapshotId: snapshot.costSnapshotId,
    },
    asOwner,
  );
  console.log(`  transfer: ${transfer.transferNumber} — margin ${Number(transfer.marginPerUnit).toFixed(2)}/unit`);

  // -------------------------------------------------------------- customers
  const customers = [
    ["CUST-001", "نور حسن", "01001234567", "nour@example.com", true],
    ["CUST-002", "سلمى محمود", "01119876543", null, true],
    ["CUST-003", "منة حسن", "01001234567", null, null],
    ["CUST-004", "دعاء إبراهيم", "01277654321", "doaa@example.com", false],
  ] as const;

  const created: string[] = [];
  for (const [code, name, phone, email, consent] of customers) {
    const c = await db.customer.upsert({
      where: { code },
      update: {},
      create: { code, name, phone, email, phoneNormalised: null, emailNormalised: null },
    });
    await upsertCustomerContact(
      {
        customerId: c.id, phone, email,
        ...(consent === null ? {} : { marketingConsent: consent }),
        ...(consent === false ? { isSuppressed: true } : {}),
      },
      asOwner,
    );
    created.push(c.id);
  }

  // ------------------------------------------------------------------ sales
  const channel = await db.salesChannel.findFirstOrThrow();
  const v = style.variants[0].id;

  // Priced at a clean piastre, the way a price tag actually reads.
  const retail = Math.round(Number(snap.transferPrice) * 2.1 * 100) / 100;

  /**
   * What the customer owes, computed the way the invoice computes it: round
   * the unit price, apply the discount, round again, then multiply by a whole
   * quantity. Reaching for `retail * qty * (1 - disc)` here would produce a
   * figure a piastre away from the invoice and be rejected.
   */
  const due = (qty: number, discount = 0, shipping = 0) => {
    const unit = Math.round(retail * 100) / 100;
    const net = Math.round(unit * (1 - discount) * 100) / 100;
    return Math.round((net * qty + shipping) * 100) / 100;
  };

  const sell = (over: Record<string, unknown>) =>
    createSale(
      {
        channelId: channel.id, entityId: brand.id, locationId: alxLoc.id,
        source: "MODERATOR", orderDate: on(18),
        lines: [{ variantId: v, quantity: 1, retailPrice: retail, discountPct: 0 }],
        payments: [],
        ...over,
      } as never,
      asOwner,
    );

  await sell({
    source: "SHOPIFY", externalId: "shopify-88001", customerId: created[0],
    lines: [{ variantId: v, quantity: 2, retailPrice: retail, discountPct: 0 }],
    shippingAmount: 65,
    payments: [{ method: "COD", amount: due(2, 0, 65), fee: 35, collected: false }],
  });
  await sell({
    source: "MODERATOR", customerId: created[0],
    lines: [{ variantId: v, quantity: 3, retailPrice: retail, discountPct: 0.1 }],
    payments: [{ method: "COD", amount: due(3, 0.1), fee: 35, collected: true }],
  });
  await sell({
    source: "MODERATOR", customerId: created[1],
    lines: [{ variantId: v, quantity: 1, retailPrice: retail, discountPct: 0 }],
    payments: [{ method: "COD", amount: due(1), fee: 35, collected: false }],
  });

  const till = await openPosSession(
    { locationId: alxLoc.id, cashierUserId: owner.id, openingFloat: "1000" }, asOwner,
  );
  await sell({
    source: "POS", posSessionId: till.posSessionId, customerId: created[3],
    lines: [{ variantId: v, quantity: 4, retailPrice: retail, discountPct: 0.15 }],
    payments: [{ method: "CASH", amount: due(4, 0.15), fee: 0, collected: true }],
  });
  // Counted twenty pounds short, recorded rather than forced to balance.
  await closePosSession(
    {
      posSessionId: till.posSessionId,
      countedCash: (1000 + due(4, 0.15) - 20).toFixed(2),
      note: "عجز ٢٠ جنيه — تم إبلاغ الكاشير",
    },
    asOwner,
  );
  console.log("  sales: 4 orders across website, social and the showroom till");

  // ----------------------------------------------------------------- payroll
  const ccFactory = await db.costCenter.findFirstOrThrow({ where: { code: "CC-FACTORY" } });
  const ccShowroom = await db.costCenter.findFirstOrThrow({ where: { code: "CC-SHOWROOM-ALX" } });

  const staff = [
    ["EMP-101", "أحمد سيد", factory.id, ccFactory.id, "6700", "B-101", "عامل ماكينة"],
    ["EMP-102", "محمود علي", factory.id, ccFactory.id, "7200", "B-102", "عامل ماكينة"],
    ["EMP-103", "سعاد رمضان", factory.id, ccFactory.id, "8400", "B-103", "مشرفة خط"],
    ["EMP-201", "هدى فتحي", brand.id, ccShowroom.id, "9500", "B-201", "مسؤولة معرض"],
  ] as const;

  for (const [code, name, entityId, costCenterId, baseSalary, badge, jobTitle] of staff) {
    await db.employee.upsert({
      where: { code },
      update: {},
      create: {
        code, name, entityId, costCenterId, baseSalary,
        biometricDeviceUserId: badge, jobTitle, hiredAt: day,
      },
    });
  }

  const punchAt = (offset: number, hhmm: string) => {
    const d = on(offset);
    const [h, m] = hhmm.split(":").map(Number);
    d.setUTCHours(h, m, 0, 0);
    return d;
  };

  await importPunches(
    {
      deviceId: "ZK-ALX-01",
      punches: [
        { deviceUserId: "B-101", punchedAt: punchAt(4, "08:02") },
        { deviceUserId: "B-101", punchedAt: punchAt(4, "17:05") },
        { deviceUserId: "B-102", punchedAt: punchAt(4, "08:10") },
        { deviceUserId: "B-102", punchedAt: punchAt(4, "17:00") },
        // No clock-out: surfaces as a day needing review rather than absence.
        { deviceUserId: "B-103", punchedAt: punchAt(4, "07:55") },
        // Unknown badge: kept as evidence, flagged as an exception.
        { deviceUserId: "B-999", punchedAt: punchAt(4, "08:00") },
      ],
    },
    asOwner,
  );

  for (const code of ["EMP-101", "EMP-102", "EMP-103"]) {
    const e = await db.employee.findFirstOrThrow({ where: { code } });
    await deriveAttendance(
      { employeeId: e.id, from: on(4), to: on(5), breakMinutes: 60 }, asOwner,
    );
  }

  // One unpaid absence, so the payroll deduction is visible.
  const absentee = await db.employee.findFirstOrThrow({ where: { code: "EMP-102" } });
  await adjustAttendance(
    {
      employeeId: absentee.id, workDate: on(6), isAbsent: true,
      reason: "غياب بدون إذن",
    },
    asOwner,
  );

  const run = await preparePayrollRun(
    { entityId: factory.id, fiscalPeriodId: period.id },
    { userId: accountant.id, reason: null },
  );
  const posted = await approveAndPostPayroll({ payrollRunId: run.payrollRunId }, asOwner);
  console.log(`  payroll: ${run.runNumber} — charged ${Number(posted.totalCharged).toFixed(2)}`);

  // The minute rate is recalculated so it now includes the posted payroll.
  const finalRate = await calculatePeriodMinuteRate(
    { entityId: factory.id, fiscalPeriodId: period.id }, asOwner,
  );

  console.log("");
  console.log("✓ Demonstration cycle complete.");
  console.log(`  minute rate now ${Number(finalRate.actualMinuteRate).toFixed(4)} EGP/min`);
  console.log("");
  console.log("  Sign in at http://localhost:3100");
  console.log("    owner@cashmere.eg / cashmere2026");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
