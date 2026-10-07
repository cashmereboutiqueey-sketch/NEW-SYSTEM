import "dotenv/config";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { createSupplierOpeningBalance, paySupplierOpeningBalance } from "./supplier-opening-balances";
import { apAging, supplierStatements } from "./reports";
import { cashForecast } from "./cash-flow";
import { dec } from "./money";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const ctx = { userId: null as string | null, reason: null };
let entityId: string;
let asOfDate: Date;
let supplierId: string;

async function clear() {
  await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
  await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
  try {
    await db.supplierOpeningPayment.deleteMany({});
    await db.supplierOpeningBalance.deleteMany({});
    await db.journalLine.deleteMany({});
    await db.journalEntry.deleteMany({});
    await db.supplier.deleteMany({ where: { code: "SUP-OPEN-TEST" } });
    await db.auditLog.deleteMany({});
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
  }
}

beforeAll(async () => {
  entityId = (await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } })).id;
  asOfDate = (await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" }, orderBy: { startDate: "asc" },
  })).startDate;
});

beforeEach(async () => {
  await clear();
  supplierId = (await db.supplier.create({
    data: { code: "SUP-OPEN-TEST", nameEn: "Old fabric supplier", nameAr: "مورد أقمشة قديم" },
  })).id;
});

afterAll(async () => {
  await clear();
  await db.$disconnect();
});

async function balance(code: string) {
  const account = await db.account.findUniqueOrThrow({ where: { code } });
  const lines = await db.journalLine.findMany({
    where: { accountId: account.id, journalEntry: { status: "POSTED" } },
    select: { debit: true, credit: true },
  });
  return lines.reduce((s, l) => s.plus(dec(l.debit)).minus(dec(l.credit)), dec(0)).toNumber();
}

function record(amount = "1000", dueDate = asOfDate) {
  return createSupplierOpeningBalance({ supplierId, entityId, amount,
    asOfDate, dueDate }, ctx);
}

describe("supplier opening debt", () => {
  it("records what is owed without inventing fabric or an expense", async () => {
    const stockBefore = await db.inventoryLot.count();
    const expensesBefore = await db.expense.count();
    await record();
    expect(await db.inventoryLot.count()).toBe(stockBefore);
    expect(await db.expense.count()).toBe(expensesBefore);
    expect(await balance("3400")).toBe(1000);
    expect(await balance("2110")).toBe(-1000);
    const aging = await apAging(entityId, asOfDate);
    expect(aging.total.toNumber()).toBe(1000);
    expect(aging.unreconciled.toNumber()).toBe(0);
    expect(aging.rows[0].kind).toBe("OPENING");
    const statement = await supplierStatements(entityId, asOfDate);
    expect(statement[0].supplierId).toBe(supplierId);
    expect(Number(statement[0].outstanding)).toBe(1000);
  });

  it("reduces the same debt on partial and final payment", async () => {
    const opening = await record();
    const first = await paySupplierOpeningBalance({ openingBalanceId: opening.id,
      amount: "400", paidDate: asOfDate, method: "BANK_TRANSFER" }, ctx);
    expect(first.outstanding).toBe("600");
    expect(await balance("2110")).toBe(-600);
    expect(await balance("1120")).toBe(-400);
    expect((await apAging(entityId, asOfDate)).unreconciled.toNumber()).toBe(0);
    await expect(paySupplierOpeningBalance({ openingBalanceId: opening.id,
      amount: "601", paidDate: asOfDate, method: "CASH" }, ctx))
      .rejects.toThrow(/only 600/i);
    const final = await paySupplierOpeningBalance({ openingBalanceId: opening.id,
      amount: "600", paidDate: asOfDate, method: "CASH" }, ctx);
    expect(final.outstanding).toBe("0");
    expect(await balance("2110")).toBe(0);
    expect((await apAging(entityId, asOfDate)).total.toNumber()).toBe(0);
    expect(await supplierStatements(entityId, asOfDate)).toHaveLength(0);
  });

  it("includes only the unpaid opening amount in the cash forecast", async () => {
    const opening = await record("1000", new Date());
    const initial = await cashForecast(entityId);
    const openingLines = initial.weeks.flatMap((w) => w.lines)
      .filter((line) => line.kind === "OPENING_PAYABLE");
    expect(openingLines).toHaveLength(1);
    expect(openingLines[0].amount.toNumber()).toBe(1000);
    await paySupplierOpeningBalance({ openingBalanceId: opening.id,
      amount: "400", paidDate: asOfDate, method: "BANK_TRANSFER" }, ctx);
    const remaining = (await cashForecast(entityId)).weeks.flatMap((w) => w.lines)
      .filter((line) => line.kind === "OPENING_PAYABLE");
    expect(remaining[0].amount.toNumber()).toBe(600);
  });

  it("rejects duplicate and nonpositive opening balances", async () => {
    await record();
    await expect(record()).rejects.toThrow(/already has an opening/i);
    await expect(record("0")).rejects.toThrow(/greater than zero/i);
    expect(await db.supplierOpeningBalance.count()).toBe(1);
  });
});
