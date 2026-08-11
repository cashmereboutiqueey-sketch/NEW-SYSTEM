/**
 * Clear the transactional data and leave the master data alone.
 *
 * `prisma/demo.ts` runs a whole business cycle and can only run once against a
 * given database — it posts payroll and raises numbered production orders,
 * and neither will happen twice. After a test run or a half-finished demo the
 * database ends up part-loaded, and every reconciliation then reports 0.00 and
 * calls itself a pass, which is worse than failing.
 *
 * This clears what a demo creates and keeps what a business configures:
 * accounts, styles, materials, people, settings. Then run `npm run db:demo`.
 *
 *   npx tsx --conditions=react-server scripts/reset-demo.ts
 *
 * It refuses to run against anything that does not look like a development
 * database, because the whole point of it is destroying data.
 */
import "dotenv/config";
import { db } from "../src/lib/db";

const url = process.env.DATABASE_URL ?? "";
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);

if (!isLocal && process.env.ALLOW_REMOTE_RESET !== "yes") {
  console.error(
    "DATABASE_URL does not point at localhost. This deletes every transaction;\n" +
      "if that is genuinely what you want on a remote database, set ALLOW_REMOTE_RESET=yes.",
  );
  await db.$disconnect();
  process.exit(1);
}

// Posted journals are immutable by trigger — which is exactly right, and the
// reason this cannot be a plain series of deletes. The triggers come off for
// the duration and go back on in a finally, so an error midway cannot leave
// the accounting rules disabled.
await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);

try {
  const cleared: string[] = [];
  const clear = async (label: string, run: () => Promise<{ count: number }>) => {
    const { count } = await run();
    if (count > 0) cleared.push(`${label} ${count}`);
  };

  // Order matters: children before parents.
  await clear("returns", () => db.return.deleteMany({}));
  await clear("custom orders", () => db.customOrder.deleteMany({}));
  await clear("settlement lines", () => db.settlementLine.deleteMany({}));
  await clear("settlements", () => db.settlement.deleteMany({}));
  await clear("statement lines", () => db.bankStatementLine.deleteMany({}));
  await clear("statements", () => db.bankStatement.deleteMany({}));
  await clear("garment units", () => db.garmentUnit.deleteMany({}));
  await clear("payments", () => db.salesPayment.deleteMany({}));
  await clear("order lines", () => db.salesOrderLine.deleteMany({}));
  await clear("orders", () => db.salesOrder.deleteMany({}));
  await clear("till sessions", () => db.posSession.deleteMany({}));
  await clear("movements", () => db.inventoryMovement.deleteMany({}));
  await clear("lots", () => db.inventoryLot.deleteMany({}));
  await clear("capacity bookings", () => db.capacityBooking.deleteMany({}));
  await clear("cutting tickets", () => db.cuttingTicket.deleteMany({}));
  await clear("production lines", () => db.productionOrderLine.deleteMany({}));
  await clear("production orders", () => db.productionOrder.deleteMany({}));
  await clear("cost snapshots", () => db.costSnapshot.deleteMany({}));
  await clear("payroll lines", () => db.payrollLine.deleteMany({}));
  await clear("payroll runs", () => db.payrollRun.deleteMany({}));
  await clear("attendance", () => db.attendanceDay.deleteMany({}));
  await clear("punches", () => db.biometricPunch.deleteMany({}));
  await clear("expense payments", () => db.expensePayment.deleteMany({}));
  await clear("expenses", () => db.expense.deleteMany({}));
  await clear("goods receipt lines", () => db.goodsReceiptLine.deleteMany({}));
  await clear("goods receipts", () => db.goodsReceipt.deleteMany({}));
  await clear("purchase order lines", () => db.purchaseOrderLine.deleteMany({}));
  await clear("purchase orders", () => db.purchaseOrder.deleteMany({}));
  await clear("minute rate components", () => db.minuteRateComponent.deleteMany({}));
  await clear("minute rate periods", () => db.minuteRatePeriod.deleteMany({}));
  await clear("journal lines", () => db.journalLine.deleteMany({}));
  await clear("journal entries", () => db.journalEntry.deleteMany({}));
  await clear("alerts", () => db.alert.deleteMany({}));
  await clear("audit log", () => db.auditLog.deleteMany({}));
  // Document numbers restart, so the demo's own numbering is repeatable.
  await clear("document numbers", () => db.documentSequence.deleteMany({}));
  // Bazaars are created by the demo; permanent locations are not.
  await clear("bazaars", () => db.location.deleteMany({ where: { kind: "EXHIBITION" } }));

  console.log(cleared.length === 0 ? "Nothing to clear." : `Cleared: ${cleared.join(", ")}.`);
} finally {
  await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
  await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
}

console.log("Master data kept. Run `npm run db:demo` to load a fresh cycle.");
await db.$disconnect();
