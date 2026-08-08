import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { createExpense, payExpense, ExpenseError } from "./expenses";

/**
 * The expense vertical slice, end to end: subledger document, general-ledger
 * posting and audit trail, against a real database.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let factoryId: string;
let brandId: string;
let factoryRentCategoryId: string;
let brandRentCategoryId: string;
let supplierId: string;
let openDate: Date;
let closedDate: Date;

const ctx = { userId: null as string | null, reason: null };

beforeAll(async () => {
  factoryId = (await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } })).id;
  brandId = (await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } })).id;

  factoryRentCategoryId = (
    await db.costCategory.findFirstOrThrow({ where: { code: "FAC-RENT", entityId: factoryId } })
  ).id;
  brandRentCategoryId = (
    await db.costCategory.findFirstOrThrow({ where: { code: "BRD-RENT", entityId: brandId } })
  ).id;

  supplierId = (await db.supplier.findFirstOrThrow()).id;

  const open = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" }, orderBy: { startDate: "asc" },
  });
  openDate = new Date(open.startDate);

  const closed = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "CLOSED" }, orderBy: { startDate: "asc" },
  });
  closedDate = new Date(closed.startDate);
});

async function wipe() {
  await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
  await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
  try {
    await db.journalLine.deleteMany({});
    await db.journalEntry.deleteMany({});
    await db.expensePayment.deleteMany({});
    await db.expense.deleteMany({});
    await db.auditLog.deleteMany({});
    await db.documentSequence.deleteMany({});
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
  }
}

beforeEach(wipe);

afterAll(async () => {
  await wipe();
  await db.$disconnect();
});

/** Factory rent, 55,000 EGP — the worked example from the accounting spec. */
function rentInput(over: Partial<Parameters<typeof createExpense>[0]> = {}) {
  return {
    entityId: factoryId,
    costCategoryId: factoryRentCategoryId,
    supplierId,
    description: "Factory rent — March",
    amount: 55000,
    incurredDate: openDate,
    dueDate: new Date(openDate.getTime() + 9 * 86_400_000),
    ...over,
  };
}

describe("recording an expense", () => {
  it("creates the document and posts a balanced journal", async () => {
    const result = await createExpense(rentInput(), ctx);

    const expense = await db.expense.findUniqueOrThrow({ where: { id: result.expenseId } });
    expect(expense.amount.toString()).toBe("55000");
    expect(expense.status).toBe("UNPAID");
    expect(expense.paidAmount.toString()).toBe("0");

    const journal = await db.journalEntry.findFirstOrThrow({
      where: { sourceType: "EXPENSE", sourceId: result.expenseId },
      include: { lines: { include: { account: true } } },
    });
    expect(journal.status).toBe("POSTED");

    const debit = journal.lines.find((l) => Number(l.debit) > 0)!;
    const credit = journal.lines.find((l) => Number(l.credit) > 0)!;

    // Rent expense debited, trade payables credited.
    expect(debit.account.code).toBe("6120");
    expect(credit.account.code).toBe("2110");
    expect(debit.debit.toString()).toBe(credit.credit.toString());
  });

  it("records the cost when incurred, not when paid", async () => {
    // The accrual rule: an unpaid cost still hits the period it belongs to.
    const result = await createExpense(rentInput(), ctx);
    const expense = await db.expense.findUniqueOrThrow({ where: { id: result.expenseId } });
    const period = await db.fiscalPeriod.findUniqueOrThrow({
      where: { id: expense.fiscalPeriodId },
    });

    expect(expense.status).toBe("UNPAID");
    expect(period.startDate.getTime()).toBeLessThanOrEqual(openDate.getTime());
    expect(period.endDate.getTime()).toBeGreaterThanOrEqual(openDate.getTime());
  });

  it("writes an audit row naming the journal it produced", async () => {
    const result = await createExpense(rentInput(), ctx);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityName: "Expense", entityId: result.expenseId, action: "EXPENSE_CREATED" },
    });
    expect(audit.after).toMatchObject({
      amount: "55000",
      category: "FAC-RENT",
      journalEntry: result.journalEntryNumber,
    });
  });

  it("refuses a category belonging to a different entity", async () => {
    // A brand category on a factory expense would corrupt both P&Ls.
    await expect(
      createExpense(rentInput({ costCategoryId: brandRentCategoryId }), ctx),
    ).rejects.toThrow(/different entity/i);
  });

  it("refuses to file into a closed period", async () => {
    await expect(
      createExpense(rentInput({ incurredDate: closedDate, dueDate: closedDate }), ctx),
    ).rejects.toThrow(/closed/i);
  });

  it("refuses a due date before the incurred date", async () => {
    await expect(
      createExpense(
        rentInput({ dueDate: new Date(openDate.getTime() - 86_400_000) }),
        ctx,
      ),
    ).rejects.toThrow(/before the date the cost was incurred/i);
  });

  it("refuses a zero or negative amount", async () => {
    await expect(createExpense(rentInput({ amount: 0 }), ctx)).rejects.toThrow();
    await expect(createExpense(rentInput({ amount: -100 }), ctx)).rejects.toThrow();
  });

  it("leaves no expense behind when the posting fails", async () => {
    // An expense without its journal is exactly the subledger/GL drift the
    // single transaction exists to prevent.
    await expect(
      createExpense(rentInput({ incurredDate: closedDate, dueDate: closedDate }), ctx),
    ).rejects.toThrow();

    expect(await db.expense.count()).toBe(0);
    expect(await db.journalEntry.count()).toBe(0);
  });
});

describe("paying an expense", () => {
  it("settles the liability without touching the original cost", async () => {
    const created = await createExpense(rentInput(), ctx);
    const paidDate = new Date(openDate.getTime() + 5 * 86_400_000);

    const payment = await payExpense(
      { expenseId: created.expenseId, amount: 55000, paidDate, method: "BANK" },
      ctx,
    );

    expect(payment.status).toBe("PAID");

    const journal = await db.journalEntry.findFirstOrThrow({
      where: { sourceType: "EXPENSE_PAYMENT" },
      include: { lines: { include: { account: true } } },
    });
    const debit = journal.lines.find((l) => Number(l.debit) > 0)!;
    const credit = journal.lines.find((l) => Number(l.credit) > 0)!;

    // Payable cleared, bank credited. The expense account is untouched.
    expect(debit.account.code).toBe("2110");
    expect(credit.account.code).toBe("1120");

    const expenseJournal = await db.journalEntry.findFirstOrThrow({
      where: { sourceType: "EXPENSE" },
      include: { lines: { include: { account: true } } },
    });
    expect(expenseJournal.lines.some((l) => l.account.code === "6120")).toBe(true);
  });

  it("supports partial payment and tracks the balance", async () => {
    const created = await createExpense(rentInput(), ctx);

    const first = await payExpense(
      { expenseId: created.expenseId, amount: 20000, paidDate: openDate, method: "BANK" },
      ctx,
    );
    expect(first.status).toBe("PARTIALLY_PAID");

    let expense = await db.expense.findUniqueOrThrow({ where: { id: created.expenseId } });
    expect(expense.paidAmount.toString()).toBe("20000");

    const second = await payExpense(
      { expenseId: created.expenseId, amount: 35000, paidDate: openDate, method: "CASH" },
      ctx,
    );
    expect(second.status).toBe("PAID");

    expense = await db.expense.findUniqueOrThrow({ where: { id: created.expenseId } });
    expect(expense.paidAmount.toString()).toBe("55000");
  });

  it("rejects an overpayment rather than creating a negative payable", async () => {
    const created = await createExpense(rentInput(), ctx);
    await expect(
      payExpense(
        { expenseId: created.expenseId, amount: 55000.01, paidDate: openDate, method: "BANK" },
        ctx,
      ),
    ).rejects.toThrow(/exceeds the outstanding balance/i);
  });

  it("rejects paying an already settled expense", async () => {
    const created = await createExpense(rentInput(), ctx);
    await payExpense(
      { expenseId: created.expenseId, amount: 55000, paidDate: openDate, method: "BANK" },
      ctx,
    );

    await expect(
      payExpense(
        { expenseId: created.expenseId, amount: 1, paidDate: openDate, method: "BANK" },
        ctx,
      ),
    ).rejects.toThrow(/already fully paid/i);
  });

  it("credits cash rather than bank when paid in cash", async () => {
    const created = await createExpense(rentInput(), ctx);
    await payExpense(
      { expenseId: created.expenseId, amount: 55000, paidDate: openDate, method: "CASH" },
      ctx,
    );

    const journal = await db.journalEntry.findFirstOrThrow({
      where: { sourceType: "EXPENSE_PAYMENT" },
      include: { lines: { include: { account: true } } },
    });
    expect(journal.lines.find((l) => Number(l.credit) > 0)!.account.code).toBe("1110");
  });

  it("rejects an unknown expense", async () => {
    await expect(
      payExpense({ expenseId: "does-not-exist", amount: 10, paidDate: openDate, method: "BANK" }, ctx),
    ).rejects.toThrow(ExpenseError);
  });
});

describe("subledger reconciles to the general ledger", () => {
  it("matches the payables balance to the sum of unpaid expenses", async () => {
    // Three expenses, one partly paid — the classic place where a subledger
    // and the GL drift apart.
    const a = await createExpense(rentInput({ amount: 55000 }), ctx);
    await createExpense(rentInput({ amount: 12000, description: "Utilities" }), ctx);
    const c = await createExpense(rentInput({ amount: 8000, description: "Maintenance" }), ctx);

    await payExpense({ expenseId: a.expenseId, amount: 55000, paidDate: openDate, method: "BANK" }, ctx);
    await payExpense({ expenseId: c.expenseId, amount: 3000, paidDate: openDate, method: "BANK" }, ctx);

    const expenses = await db.expense.findMany();
    const outstandingPerSubledger = expenses.reduce(
      (s, e) => s + Number(e.amount) - Number(e.paidAmount),
      0,
    );

    const [gl] = await db.$queryRaw<{ balance: string }[]>`
      SELECT COALESCE(SUM(l."credit") - SUM(l."debit"), 0)::text AS balance
      FROM "journal_lines" l
      JOIN "journal_entries" e ON e."id" = l."journalEntryId"
      JOIN "accounts" a ON a."id" = l."accountId"
      WHERE a."code" = '2110' AND e."status" = 'POSTED'
    `;

    expect(Number(gl.balance)).toBe(outstandingPerSubledger);
    expect(outstandingPerSubledger).toBe(12000 + 5000);
  });

  it("keeps the whole ledger in balance after every posting", async () => {
    const e = await createExpense(rentInput(), ctx);
    await payExpense({ expenseId: e.expenseId, amount: 25000, paidDate: openDate, method: "BANK" }, ctx);

    const [row] = await db.$queryRaw<{ debit: string; credit: string }[]>`
      SELECT COALESCE(SUM(l."debit"), 0)::text AS debit,
             COALESCE(SUM(l."credit"), 0)::text AS credit
      FROM "journal_lines" l
      JOIN "journal_entries" e ON e."id" = l."journalEntryId"
      WHERE e."status" = 'POSTED'
    `;
    expect(row.debit).toBe(row.credit);
  });
});
