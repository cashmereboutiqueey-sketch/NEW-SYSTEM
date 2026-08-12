import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { createExpense, payExpense, ExpenseError } from "./expenses";
import { createUser } from "./users";
import {
  approveExpense,
  rejectExpense,
  expensePayable,
  approvePurchaseOrder,
  rejectPurchaseOrder,
  purchaseOrderReceivable,
  pendingApprovals,
  approvalThreshold,
  APPROVAL_THRESHOLD_KEY,
  ApprovalError,
} from "./approvals";
import { dec } from "./money";

/**
 * Somebody other than the person who raised it has to say yes.
 *
 * These tests are about one sentence: money over a threshold does not leave
 * the business on a single signature. Everything else here — the threshold,
 * the rejection reason, the inbox — exists to make that sentence survivable
 * in a real shop, where a control that stops every taxi receipt gets worked
 * around within a week.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let entityId: string;
let categoryId: string;
let supplierId: string;
let materialId: string;
let ownerId: string;
let raiserId: string;
let approverId: string;
let day: Date;

beforeAll(async () => {
  const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });
  entityId = factory.id;
  categoryId = (
    await db.costCategory.findFirstOrThrow({ where: { entityId: factory.id } })
  ).id;
  supplierId = (await db.supplier.findFirstOrThrow()).id;
  materialId = (await db.material.findFirstOrThrow()).id;
  ownerId = (await db.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;

  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" },
    orderBy: { startDate: "asc" },
  });
  day = new Date(period.startDate);

  await db.setting.upsert({
    where: { key: APPROVAL_THRESHOLD_KEY },
    update: { value: "10000" },
    create: {
      key: APPROVAL_THRESHOLD_KEY, value: "10000", type: "DECIMAL", group: "Finance",
      labelAr: "حد الاعتماد المالي", labelEn: "Approval threshold",
    },
  });
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
    await db.journalLine.deleteMany({});
    await db.journalEntry.deleteMany({});
    await db.documentSequence.deleteMany({});
    await db.user.deleteMany({ where: { email: { endsWith: "@apprtest.eg" } } });
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
  }

  raiserId = (
    await createUser(
      {
        name: "محاسب", email: "raiser@apprtest.eg",
        role: "ACCOUNTANT", password: "approval-test-1",
      },
      { userId: ownerId, reason: null },
    )
  ).id;

  approverId = (
    await createUser(
      {
        name: "معتمد مالي", email: "approver@apprtest.eg",
        role: "FINANCE_APPROVER", password: "approval-test-2",
      },
      { userId: ownerId, reason: null },
    )
  ).id;
});

afterAll(async () => {
  await db.user.deleteMany({ where: { email: { endsWith: "@apprtest.eg" } } });
  await db.$disconnect();
});

const asRaiser = () => ({ userId: raiserId, reason: null });
const asApprover = () => ({ userId: approverId, reason: null });

function anExpense(amount: number) {
  return createExpense(
    {
      entityId, costCategoryId: categoryId,
      description: `مصروف ${amount}`,
      amount, incurredDate: day, dueDate: day,
    },
    asRaiser(),
  );
}

async function aPurchaseOrder(unitPrice: number, quantity = 10) {
  const { purchaseOrderId } = await (
    await import("./purchasing")
  ).createPurchaseOrder(
    {
      supplierId, orderDate: day,
      lines: [{ materialId, quantity: String(quantity), unitPrice: String(unitPrice) }],
    },
    asRaiser(),
  );
  return purchaseOrderId;
}

describe("the threshold", () => {
  it("lets a small expense through without a second signature", async () => {
    // A shop that stops for a taxi receipt gets worked around within a week,
    // and then the control is worse than none.
    const { expenseId } = await anExpense(500);
    expect((await expensePayable(expenseId)).ok).toBe(true);
  });

  it("holds a large one until somebody approves it", async () => {
    const { expenseId } = await anExpense(50_000);
    const check = await expensePayable(expenseId);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/approval limit/i);
  });

  it("is a real setting, not a constant", async () => {
    expect((await approvalThreshold()).toNumber()).toBe(10_000);
  });
});

describe("money does not move without the second signature", () => {
  it("refuses to pay an unapproved expense", async () => {
    const { expenseId } = await anExpense(50_000);

    await expect(
      payExpense(
        { expenseId, amount: 50_000, paidDate: day, method: "BANK_TRANSFER" },
        asRaiser(),
      ),
    ).rejects.toThrow(/approval limit/i);
  });

  it("pays it once approved", async () => {
    const { expenseId } = await anExpense(50_000);
    await approveExpense({ expenseId }, asApprover());

    const paid = await payExpense(
      { expenseId, amount: 50_000, paidDate: day, method: "BANK_TRANSFER" },
      asRaiser(),
    );
    expect(paid.status).toBe("PAID");
  });

  it("refuses to pay one that was sent back", async () => {
    const { expenseId } = await anExpense(50_000);
    await rejectExpense({ expenseId, reason: "مفيش فاتورة" }, asApprover());

    await expect(
      payExpense(
        { expenseId, amount: 50_000, paidDate: day, method: "BANK_TRANSFER" },
        asRaiser(),
      ),
    ).rejects.toThrow(/sent back/i);
  });

  it("is checked in the payment path, not only on the screen", async () => {
    // The guard lives in payExpense, so an import or a script cannot walk
    // round the inbox.
    const { expenseId } = await anExpense(50_000);
    await expect(
      payExpense({ expenseId, amount: 1, paidDate: day, method: "CASH" }, asRaiser()),
    ).rejects.toThrow(ExpenseError);
  });
});

describe("the approver is not the person who asked", () => {
  it("refuses the raiser's own expense", async () => {
    const { expenseId } = await anExpense(50_000);

    // A role map cannot say "not this human"; this is the only version of
    // the rule that means anything.
    await expect(approveExpense({ expenseId }, asRaiser())).rejects.toThrow(
      /somebody else has to approve/i,
    );
  });

  it("lets you approve your own only with a stated reason", async () => {
    const { expenseId } = await anExpense(50_000);

    // A shop where one person does both is a real shop. What must never
    // happen is that it looks the same as a second signature.
    await approveExpense(
      { expenseId, overrideReason: "أنا الوحيد اللي بيعتمد" },
      asRaiser(),
    );

    const expense = await db.expense.findUniqueOrThrow({ where: { id: expenseId } });
    expect(expense.approvedByUserId).toBe(raiserId);

    const entry = await db.auditLog.findFirstOrThrow({
      where: { entityId: expenseId, action: "EXPENSE_SELF_APPROVED" },
      orderBy: { createdAt: "desc" },
    });
    // The trail says an override happened, and why.
    expect(JSON.stringify(entry.after)).toContain("أنا الوحيد اللي بيعتمد");
    expect(entry.reason).toBe("أنا الوحيد اللي بيعتمد");
  });

  it("does not record an override as an ordinary approval", async () => {
    const { expenseId } = await anExpense(50_000);
    await approveExpense({ expenseId, overrideReason: "ضروري" }, asRaiser());

    // Otherwise a month of self-approvals reads as a month of proper ones.
    const ordinary = await db.auditLog.count({
      where: { entityId: expenseId, action: "EXPENSE_APPROVED" },
    });
    expect(ordinary).toBe(0);
  });

  it("refuses a blank reason as no reason at all", async () => {
    const { expenseId } = await anExpense(50_000);
    await expect(
      approveExpense({ expenseId, overrideReason: "   " }, asRaiser()),
    ).rejects.toThrow(/somebody else has to approve/i);
  });

  it("accepts somebody else", async () => {
    const { expenseId } = await anExpense(50_000);
    await approveExpense({ expenseId }, asApprover());

    const expense = await db.expense.findUniqueOrThrow({ where: { id: expenseId } });
    expect(expense.approvedByUserId).toBe(approverId);
    expect(expense.approvedAt).not.toBeNull();
  });

  it("records who raised it on the row, not only in the log", async () => {
    const { expenseId } = await anExpense(50_000);
    const expense = await db.expense.findUniqueOrThrow({ where: { id: expenseId } });
    // Without this the rule above cannot be checked at all.
    expect(expense.createdByUserId).toBe(raiserId);
  });

  it("refuses the raiser's own purchase order", async () => {
    const purchaseOrderId = await aPurchaseOrder(5_000);
    await expect(
      approvePurchaseOrder({ purchaseOrderId }, asRaiser()),
    ).rejects.toThrow(/somebody else has to approve/i);
  });
});

describe("sending something back", () => {
  it("insists on a reason", async () => {
    const { expenseId } = await anExpense(50_000);
    await expect(
      rejectExpense({ expenseId, reason: "   " }, asApprover()),
    ).rejects.toThrow(/say why/i);
  });

  it("keeps the reason where the person who raised it will see it", async () => {
    const { expenseId } = await anExpense(50_000);
    await rejectExpense({ expenseId, reason: "الفاتورة مش مرفقة" }, asApprover());

    const expense = await db.expense.findUniqueOrThrow({ where: { id: expenseId } });
    expect(expense.rejectionReason).toBe("الفاتورة مش مرفقة");
    expect(expense.rejectedAt).not.toBeNull();
  });

  it("can be approved after being fixed", async () => {
    const { expenseId } = await anExpense(50_000);
    await rejectExpense({ expenseId, reason: "ناقص ورق" }, asApprover());
    await approveExpense({ expenseId }, asApprover());

    const expense = await db.expense.findUniqueOrThrow({ where: { id: expenseId } });
    expect(expense.approvedAt).not.toBeNull();
    // The rejection is cleared rather than left to contradict the approval.
    expect(expense.rejectedAt).toBeNull();
    expect(expense.rejectionReason).toBeNull();
  });

  it("refuses to send back something already paid", async () => {
    const { expenseId } = await anExpense(500); // under the threshold
    await payExpense(
      { expenseId, amount: 500, paidDate: day, method: "CASH" },
      asRaiser(),
    );

    await expect(
      rejectExpense({ expenseId, reason: "غيّرت رأيي" }, asApprover()),
    ).rejects.toThrow(/already gone out/i);
  });

  it("cannot be approved twice", async () => {
    const { expenseId } = await anExpense(50_000);
    await approveExpense({ expenseId }, asApprover());
    await expect(approveExpense({ expenseId }, asApprover())).rejects.toThrow(
      /already approved/i,
    );
  });
});

describe("purchase orders", () => {
  it("lets a small order receive goods without approval", async () => {
    const purchaseOrderId = await aPurchaseOrder(50, 10); // 500
    expect((await purchaseOrderReceivable(purchaseOrderId)).ok).toBe(true);
  });

  it("holds a large one until it is approved", async () => {
    const purchaseOrderId = await aPurchaseOrder(5_000, 10); // 50,000
    const check = await purchaseOrderReceivable(purchaseOrderId);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/has not been approved/i);
  });

  it("turns a proposal into a commitment when approved", async () => {
    const purchaseOrderId = await aPurchaseOrder(5_000, 10);
    await approvePurchaseOrder({ purchaseOrderId }, asApprover());

    const order = await db.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId } });
    expect(order.status).toBe("CONFIRMED");
    expect(order.approvedByUserId).toBe(approverId);
    expect((await purchaseOrderReceivable(purchaseOrderId)).ok).toBe(true);
  });

  it("puts a rejected order back to a draft", async () => {
    const purchaseOrderId = await aPurchaseOrder(5_000, 10);
    await rejectPurchaseOrder(
      { purchaseOrderId, reason: "السعر غالي" },
      asApprover(),
    );

    const order = await db.purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrderId } });
    expect(order.status).toBe("DRAFT");
    expect(order.rejectionReason).toBe("السعر غالي");
    expect((await purchaseOrderReceivable(purchaseOrderId)).ok).toBe(false);
  });
});

describe("the inbox", () => {
  it("shows only what is worth a signature", async () => {
    await anExpense(500);
    const big = await anExpense(50_000);

    const inbox = await pendingApprovals(approverId);
    const ids = inbox.expenses.map((e) => e.id);
    expect(ids).toContain(big.expenseId);
    expect(ids).toHaveLength(1);
  });

  it("marks what the person looking at it raised themselves", async () => {
    const { expenseId } = await anExpense(50_000);

    // Offering somebody a button that will refuse them is how a control
    // becomes noise.
    const theirs = await pendingApprovals(raiserId);
    expect(theirs.expenses.find((e) => e.id === expenseId)!.isOwn).toBe(true);

    const someone = await pendingApprovals(approverId);
    expect(someone.expenses.find((e) => e.id === expenseId)!.isOwn).toBe(false);
  });

  it("drops things once they are decided", async () => {
    const { expenseId } = await anExpense(50_000);
    expect((await pendingApprovals(approverId)).expenses).toHaveLength(1);

    await approveExpense({ expenseId }, asApprover());
    expect((await pendingApprovals(approverId)).expenses).toHaveLength(0);
  });

  it("carries the reason a rejected item came back", async () => {
    const { expenseId } = await anExpense(50_000);
    await rejectExpense({ expenseId, reason: "محتاج عرض سعر تاني" }, asApprover());

    const inbox = await pendingApprovals(approverId);
    const row = inbox.expenses.find((e) => e.id === expenseId)!;
    expect(row.rejectionReason).toBe("محتاج عرض سعر تاني");
  });

  it("only holds up the orders that are worth holding up", async () => {
    const small = await aPurchaseOrder(50, 10);   // 500
    const large = await aPurchaseOrder(5_000, 10); // 50,000

    // The small one commits the moment it is raised: making a hundred pounds
    // of buttons wait behind a fabric order is how an inbox stops being read.
    const smallOrder = await db.purchaseOrder.findUniqueOrThrow({ where: { id: small } });
    expect(smallOrder.status).toBe("CONFIRMED");

    const largeOrder = await db.purchaseOrder.findUniqueOrThrow({ where: { id: large } });
    expect(largeOrder.status).toBe("DRAFT");

    const inbox = await pendingApprovals(approverId);
    const ids = inbox.purchaseOrders.map((o) => o.id);
    expect(ids).toContain(large);
    expect(ids).not.toContain(small);
    expect(inbox.purchaseOrders.find((o) => o.id === large)!.needsApproval).toBe(true);
  });
});
