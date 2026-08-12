import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { createExpense, payExpense } from "./expenses";
import { approveExpense } from "./approvals";
import { supplierStatements, supplierCommitments } from "./reports";
import { createPurchaseOrder } from "./purchasing";
import { dec } from "./money";

/**
 * What each supplier is owed.
 *
 * The aging report answers "how much is overdue" across the whole business.
 * The question a supplier asks on the phone is different — "what do you owe
 * me" — and answering it by eye from a list of invoices is how somebody gets
 * told a number that is wrong in their own favour.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let factoryId: string;
let categoryId: string;
let supplierA: string;
let supplierB: string;
let materialId: string;
let ownerId: string;
let approverId: string;
let day: Date;

const ctx = { userId: null as string | null, reason: null };

beforeAll(async () => {
  const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });
  factoryId = factory.id;
  categoryId = (await db.costCategory.findFirstOrThrow({ where: { entityId: factory.id } })).id;
  materialId = (await db.material.findFirstOrThrow()).id;
  ownerId = (await db.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  approverId = (await db.user.findFirstOrThrow({ where: { id: { not: ownerId } } })).id;

  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" },
    orderBy: { startDate: "asc" },
  });
  day = new Date(period.startDate);

  const suppliers = await db.supplier.findMany({ take: 2, orderBy: { code: "asc" } });
  supplierA = suppliers[0].id;
  supplierB = suppliers[1]?.id ?? suppliers[0].id;
});

beforeEach(async () => {
  await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
  await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
  try {
    await db.goodsReceiptLine.deleteMany({});
    await db.goodsReceipt.deleteMany({});
    await db.purchaseOrderLine.deleteMany({});
    await db.purchaseOrder.deleteMany({});
    await db.expensePayment.deleteMany({});
    await db.expense.deleteMany({});
    await db.inventoryMovement.deleteMany({});
    await db.inventoryLot.deleteMany({});
    await db.journalLine.deleteMany({});
    await db.journalEntry.deleteMany({});
    await db.documentSequence.deleteMany({});
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
  }
});

afterAll(async () => {
  await db.$disconnect();
});

/**
 * An invoice due `dueOffsetDays` after the reference day.
 *
 * Lateness is created by looking from a later date rather than by backdating
 * the invoice. Backdating fails twice over — an expense cannot fall due
 * before it was incurred, and pushing the incurred date back far enough
 * lands it in a closed period. Both refusals are correct; the fixture was
 * wrong to fight them.
 */
function anInvoice(
  supplierId: string,
  amount: number,
  dueOffsetDays: number,
  description = "فاتورة",
) {
  const due = new Date(day.getTime() + dueOffsetDays * 86_400_000);
  const incurred = day;

  return createExpense(
    {
      entityId: factoryId,
      costCategoryId: categoryId,
      supplierId,
      description,
      amount,
      incurredDate: incurred,
      dueDate: due,
    },
    { userId: ownerId, reason: null },
  );
}

describe("what a supplier is owed", () => {
  it("adds their open invoices into one figure", async () => {
    await anInvoice(supplierA, 4000, 30, "قماش");
    await anInvoice(supplierA, 6000, 30, "بطانة");

    const rows = await supplierStatements(factoryId, day);
    const row = rows.find((r) => r.supplierId === supplierA)!;

    expect(Number(row.outstanding)).toBe(10_000);
    expect(row.invoices).toHaveLength(2);
  });

  it("keeps suppliers apart", async () => {
    await anInvoice(supplierA, 4000, 30);
    if (supplierB !== supplierA) {
      await anInvoice(supplierB, 9000, 30);
      const rows = await supplierStatements(factoryId, day);
      expect(Number(rows.find((r) => r.supplierId === supplierA)!.outstanding)).toBe(4000);
      expect(Number(rows.find((r) => r.supplierId === supplierB)!.outstanding)).toBe(9000);
    }
  });

  it("counts only what is still unpaid", async () => {
    const invoice = await anInvoice(supplierA, 4000, 30);
    await approveExpense({ expenseId: invoice.expenseId }, { userId: approverId, reason: null });
    await payExpense(
      { expenseId: invoice.expenseId, amount: 1500, paidDate: day, method: "INSTAPAY" },
      { userId: ownerId, reason: null },
    );

    const row = (await supplierStatements(factoryId, day)).find(
      (r) => r.supplierId === supplierA,
    )!;
    expect(Number(row.outstanding)).toBe(2500);
    expect(Number(row.invoices[0].paid)).toBe(1500);
  });

  it("drops a supplier off once they are settled", async () => {
    const invoice = await anInvoice(supplierA, 4000, 30);
    await approveExpense({ expenseId: invoice.expenseId }, { userId: approverId, reason: null });
    await payExpense(
      { expenseId: invoice.expenseId, amount: 4000, paidDate: day, method: "INSTAPAY" },
      { userId: ownerId, reason: null },
    );

    expect(
      (await supplierStatements(factoryId, day)).find((r) => r.supplierId === supplierA),
    ).toBeUndefined();
  });

  it("separates late from merely unpaid", async () => {
    await anInvoice(supplierA, 4000, 10, "فاتورة قريبة");
    await anInvoice(supplierA, 6000, 40, "فاتورة بعيدة");

    // Standing twenty days on: the first has fallen due, the second has not.
    const asOf = new Date(day.getTime() + 20 * 86_400_000);
    const row = (await supplierStatements(factoryId, asOf)).find(
      (r) => r.supplierId === supplierA,
    )!;

    expect(Number(row.overdue)).toBe(4000);
    expect(Number(row.notYetDue)).toBe(6000);
  });

  it("says how many days late each invoice is", async () => {
    await anInvoice(supplierA, 4000, 10);

    const asOf = new Date(day.getTime() + 20 * 86_400_000);
    const row = (await supplierStatements(factoryId, asOf)).find(
      (r) => r.supplierId === supplierA,
    )!;
    expect(row.invoices[0].daysLate).toBe(10);
  });

  it("puts whoever is owed late money first", async () => {
    if (supplierB === supplierA) return;

    await anInvoice(supplierB, 1000, 60); // still has time
    await anInvoice(supplierA, 500, 5); // fell due a fortnight ago

    const asOf = new Date(day.getTime() + 20 * 86_400_000);
    const rows = await supplierStatements(factoryId, asOf);
    // That is the order somebody works down the list in.
    expect(rows[0].supplierId).toBe(supplierA);
  });
});

describe("what has been ordered and not delivered", () => {
  it("is reported separately from what is owed", async () => {
    await createPurchaseOrder(
      {
        supplierId: supplierA,
        orderDate: day,
        expectedDate: day,
        lines: [{ materialId, quantity: 100, unitPrice: 50 }],
      },
      { userId: ownerId, reason: null },
    );

    // Not a debt: a supplier is owed when the goods arrive. It belongs in the
    // conversation about the relationship, not in the payables figure.
    const owed = await supplierStatements(factoryId, day);
    expect(owed.find((r) => r.supplierId === supplierA)).toBeUndefined();

    const commitments = await supplierCommitments(supplierA);
    expect(commitments).toHaveLength(1);
    expect(Number(commitments[0].outstanding)).toBeGreaterThan(0);
  });

  it("flags an order still waiting on a signature", async () => {
    await createPurchaseOrder(
      {
        supplierId: supplierA,
        orderDate: day,
        expectedDate: day,
        lines: [{ materialId, quantity: 500, unitPrice: 200 }], // 100,000
      },
      { userId: ownerId, reason: null },
    );

    const commitments = await supplierCommitments(supplierA);
    expect(commitments[0].awaitingApproval).toBe(true);
  });

  it("shows only that supplier when asked for one", async () => {
    if (supplierB === supplierA) return;

    await createPurchaseOrder(
      {
        supplierId: supplierA, orderDate: day, expectedDate: day,
        lines: [{ materialId, quantity: 10, unitPrice: 50 }],
      },
      { userId: ownerId, reason: null },
    );
    await createPurchaseOrder(
      {
        supplierId: supplierB, orderDate: day, expectedDate: day,
        lines: [{ materialId, quantity: 10, unitPrice: 50 }],
      },
      { userId: ownerId, reason: null },
    );

    expect(await supplierCommitments(supplierA)).toHaveLength(1);
    expect(await supplierCommitments()).toHaveLength(2);
  });
});
