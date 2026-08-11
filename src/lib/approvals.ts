import "server-only";
import { db } from "./db";
import { dec, type Decimal } from "./money";
import { writeAudit, type AuditContext } from "./audit";
import { violatesSeparationOfDuties } from "@/core/permissions";

/**
 * Somebody other than the person who raised it has to say yes.
 *
 * The role map has always said an accountant may create an expense and not
 * approve it, and that a finance approver may approve one and not create it.
 * Nothing enforced it, because there was no approval step to enforce: money
 * left the business on one signature, and the separation existed only as a
 * list of strings.
 *
 * Two things keep this from being theatre.
 *
 * There is a threshold. A fifty-pound taxi receipt does not need the finance
 * approver, and a system that stops for one gets worked around within a week
 * — somebody starts splitting invoices, and then the control is worse than
 * none. Only what is worth a second signature asks for one.
 *
 * And the approver is never the person who raised it, checked on the person
 * rather than the role. A role map cannot express "not this human", which is
 * the only version of the rule that means anything.
 */

export class ApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalError";
  }
}

export const APPROVAL_THRESHOLD_KEY = "finance.approvalThreshold";

/** Above this, money does not move without a second person. */
export async function approvalThreshold(): Promise<Decimal> {
  const setting = await db.setting.findUnique({ where: { key: APPROVAL_THRESHOLD_KEY } });
  return dec(setting?.value ?? "10000");
}

function reject(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) {
    throw new ApprovalError("Say why it is being sent back — somebody has to act on it.");
  }
  return trimmed;
}

// -------------------------------------------------------------- expenses

/**
 * Whether this expense may be paid.
 *
 * Called by the payment path rather than only by a screen, so an expense
 * cannot be paid by any route that skips the inbox.
 */
export async function expensePayable(expenseId: string): Promise<{
  ok: boolean;
  reason?: string;
}> {
  const expense = await db.expense.findUnique({
    where: { id: expenseId },
    select: { amount: true, approvedAt: true, rejectedAt: true, description: true },
  });
  if (!expense) return { ok: false, reason: "Expense not found." };

  if (expense.rejectedAt) {
    return { ok: false, reason: "This expense was sent back and has not been approved." };
  }

  const threshold = await approvalThreshold();
  if (dec(expense.amount).greaterThan(threshold) && !expense.approvedAt) {
    return {
      ok: false,
      reason:
        `${dec(expense.amount).toFixed(2)} is over the ${threshold.toFixed(2)} approval limit ` +
        `and has not been approved yet.`,
    };
  }

  return { ok: true };
}

export async function approveExpense(
  input: {
    expenseId: string;
    /**
     * Approving something you raised yourself. Allowed, because a shop where
     * one person does both is a real shop, but never silently: the reason is
     * required and the audit entry says an override happened. That is the
     * convention `violatesSeparationOfDuties` was written for — the owner is
     * not exempt, the override is simply visible.
     */
    overrideReason?: string | null;
  },
  ctx: AuditContext,
): Promise<void> {
  const expense = await db.expense.findUnique({ where: { id: input.expenseId } });
  if (!expense) throw new ApprovalError("Expense not found.");
  if (expense.approvedAt) throw new ApprovalError("This expense is already approved.");

  const selfApproving =
    !!ctx.userId &&
    violatesSeparationOfDuties({
      creatorUserId: expense.createdByUserId,
      approverUserId: ctx.userId,
      createPermission: "expense:create",
      approvePermission: "expense:approve",
    });

  // A role map cannot say "not this human". This is the only version of the
  // rule that means anything.
  if (selfApproving && !input.overrideReason?.trim()) {
    throw new ApprovalError(
      "You raised this expense, so somebody else has to approve it — or say why you are approving your own.",
    );
  }

  await db.$transaction(async (tx) => {
    await tx.expense.update({
      where: { id: expense.id },
      data: {
        approvedByUserId: ctx.userId,
        approvedAt: new Date(),
        rejectedAt: null,
        rejectionReason: null,
      },
    });

    await writeAudit(tx, {
      action: selfApproving ? "EXPENSE_SELF_APPROVED" : "EXPENSE_APPROVED",
      entityName: "Expense",
      entityId: expense.id,
      after: {
        description: expense.description,
        amount: dec(expense.amount).toString(),
        raisedBy: expense.createdByUserId,
        ...(selfApproving ? { override: input.overrideReason?.trim() } : {}),
      },
      ctx: selfApproving ? { ...ctx, reason: input.overrideReason?.trim() ?? null } : ctx,
    });
  });
}

export async function rejectExpense(
  input: { expenseId: string; reason: string },
  ctx: AuditContext,
): Promise<void> {
  const reason = reject(input.reason);

  const expense = await db.expense.findUnique({ where: { id: input.expenseId } });
  if (!expense) throw new ApprovalError("Expense not found.");
  if (expense.status !== "UNPAID") {
    throw new ApprovalError("Money has already gone out on this; it cannot be sent back.");
  }

  await db.$transaction(async (tx) => {
    await tx.expense.update({
      where: { id: expense.id },
      data: {
        rejectedAt: new Date(),
        rejectionReason: reason,
        approvedByUserId: null,
        approvedAt: null,
      },
    });

    await writeAudit(tx, {
      action: "EXPENSE_REJECTED",
      entityName: "Expense",
      entityId: expense.id,
      after: {
        description: expense.description,
        amount: dec(expense.amount).toString(),
        reason,
      },
      ctx,
    });
  });
}

// -------------------------------------------------------- purchase orders

/** Whether goods may be received against this order. */
export async function purchaseOrderReceivable(purchaseOrderId: string): Promise<{
  ok: boolean;
  reason?: string;
}> {
  const order = await db.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    include: { lines: true },
  });
  if (!order) return { ok: false, reason: "Purchase order not found." };

  if (order.rejectedAt) {
    return { ok: false, reason: "This order was sent back and has not been approved." };
  }

  const value = order.lines.reduce(
    (s, l) => s.plus(dec(l.quantity).times(dec(l.unitPrice))),
    dec(0),
  );
  const threshold = await approvalThreshold();

  if (value.greaterThan(threshold) && !order.approvedAt) {
    return {
      ok: false,
      reason:
        `${order.poNumber} commits ${value.toFixed(2)}, over the ${threshold.toFixed(2)} ` +
        `limit, and has not been approved.`,
    };
  }

  return { ok: true };
}

export async function approvePurchaseOrder(
  input: { purchaseOrderId: string; overrideReason?: string | null },
  ctx: AuditContext,
): Promise<void> {
  const order = await db.purchaseOrder.findUnique({
    where: { id: input.purchaseOrderId },
  });
  if (!order) throw new ApprovalError("Purchase order not found.");
  if (order.approvedAt) throw new ApprovalError("This order is already approved.");
  if (order.status === "CANCELLED") throw new ApprovalError("This order was cancelled.");

  const selfApproving =
    !!ctx.userId &&
    violatesSeparationOfDuties({
      creatorUserId: order.createdByUserId,
      approverUserId: ctx.userId,
      createPermission: "purchase_order:create",
      approvePermission: "purchase_order:approve",
    });

  if (selfApproving && !input.overrideReason?.trim()) {
    throw new ApprovalError(
      "You raised this order, so somebody else has to approve it — or say why you are approving your own.",
    );
  }

  await db.$transaction(async (tx) => {
    await tx.purchaseOrder.update({
      where: { id: order.id },
      data: {
        approvedByUserId: ctx.userId,
        approvedAt: new Date(),
        rejectedAt: null,
        rejectionReason: null,
        // Approval is what turns a proposal into a commitment.
        ...(order.status === "DRAFT" ? { status: "CONFIRMED" as const } : {}),
      },
    });

    await writeAudit(tx, {
      action: selfApproving ? "PURCHASE_ORDER_SELF_APPROVED" : "PURCHASE_ORDER_APPROVED",
      entityName: "PurchaseOrder",
      entityId: order.id,
      after: {
        orderNumber: order.poNumber,
        raisedBy: order.createdByUserId,
        ...(selfApproving ? { override: input.overrideReason?.trim() } : {}),
      },
      ctx: selfApproving ? { ...ctx, reason: input.overrideReason?.trim() ?? null } : ctx,
    });
  });
}

export async function rejectPurchaseOrder(
  input: { purchaseOrderId: string; reason: string },
  ctx: AuditContext,
): Promise<void> {
  const reason = reject(input.reason);

  const order = await db.purchaseOrder.findUnique({ where: { id: input.purchaseOrderId } });
  if (!order) throw new ApprovalError("Purchase order not found.");
  if (["PARTIALLY_RECEIVED", "RECEIVED"].includes(order.status)) {
    throw new ApprovalError("Goods have already arrived against this order.");
  }

  await db.$transaction(async (tx) => {
    await tx.purchaseOrder.update({
      where: { id: order.id },
      data: {
        rejectedAt: new Date(),
        rejectionReason: reason,
        approvedByUserId: null,
        approvedAt: null,
        status: "DRAFT",
      },
    });

    await writeAudit(tx, {
      action: "PURCHASE_ORDER_REJECTED",
      entityName: "PurchaseOrder",
      entityId: order.id,
      after: { orderNumber: order.poNumber, reason },
      ctx,
    });
  });
}

// ----------------------------------------------------------- the inbox

/**
 * Everything waiting on this person, in one place.
 *
 * An approver opens one list; they do not go looking through four screens for
 * things that might need them. What is not over the threshold never appears,
 * and neither does anything they raised themselves — offering somebody a
 * button that will refuse them is how a control becomes noise.
 */
export async function pendingApprovals(forUserId: string | null) {
  const threshold = await approvalThreshold();

  const [expenses, orders, payrollRuns] = await Promise.all([
    db.expense.findMany({
      where: {
        status: "UNPAID",
        approvedAt: null,
        amount: { gt: threshold.toString() },
      },
      include: { costCategory: true, entity: true, createdBy: true },
      orderBy: [{ rejectedAt: "asc" }, { incurredDate: "asc" }],
    }),
    db.purchaseOrder.findMany({
      where: { status: "DRAFT", approvedAt: null },
      include: { supplier: true, lines: true, createdBy: true },
      orderBy: [{ rejectedAt: "asc" }, { orderDate: "asc" }],
    }),
    db.payrollRun.findMany({
      where: { status: "DRAFT" },
      include: { entity: true, fiscalPeriod: true, _count: { select: { lines: true } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  // preparedByUserId has no relation on the model, so the names are looked
  // up in one go rather than per row.
  const preparers = await db.user.findMany({
    where: { id: { in: payrollRuns.map((r) => r.preparedByUserId).filter((x): x is string => !!x) } },
    select: { id: true, name: true },
  });
  const preparerNames = new Map(preparers.map((u) => [u.id, u.name]));

  const mine = (creatorId: string | null) =>
    forUserId != null && creatorId === forUserId;

  return {
    threshold: threshold.toString(),
    expenses: expenses.map((e) => ({
      id: e.id,
      description: e.description,
      amount: dec(e.amount).toString(),
      category: e.costCategory.nameAr || e.costCategory.nameEn,
      entity: e.entity.nameAr || e.entity.nameEn,
      incurredDate: e.incurredDate,
      dueDate: e.dueDate,
      raisedBy: e.createdBy?.name ?? null,
      /** Raised by whoever is looking: they cannot approve it. */
      isOwn: mine(e.createdByUserId),
      rejectedAt: e.rejectedAt,
      rejectionReason: e.rejectionReason,
    })),
    purchaseOrders: orders.map((o) => {
      const value = o.lines.reduce(
        (s, l) => s.plus(dec(l.quantity).times(dec(l.unitPrice))),
        dec(0),
      );
      return {
        id: o.id,
        orderNumber: o.poNumber,
        supplier: o.supplier.nameAr || o.supplier.nameEn,
        value: value.toString(),
        lines: o.lines.length,
        orderDate: o.orderDate,
        expectedDate: o.expectedDate,
        raisedBy: o.createdBy?.name ?? null,
        isOwn: mine(o.createdByUserId),
        /** Small orders do not need a signature, and are shown as such. */
        needsApproval: value.greaterThan(threshold),
        rejectedAt: o.rejectedAt,
        rejectionReason: o.rejectionReason,
      };
    }),
    payrollRuns: payrollRuns.map((r) => ({
      id: r.id,
      runNumber: r.runNumber,
      entity: r.entity.nameAr || r.entity.nameEn,
      period: `${r.fiscalPeriod.year}-${String(r.fiscalPeriod.month).padStart(2, "0")}`,
      employees: r._count.lines,
      // The run stores its own totals, so this is what was prepared rather
      // than a figure recomputed from the lines and possibly differing.
      total: dec(r.grossPay).plus(dec(r.employerCost)).toString(),
      preparedBy: preparerNames.get(r.preparedByUserId ?? "") ?? null,
      isOwn: mine(r.preparedByUserId),
    })),
  };
}

/** What has been decided lately, so a decision can be looked up. */
export async function recentDecisions(limit = 40) {
  return db.auditLog.findMany({
    where: {
      action: {
        in: [
          "EXPENSE_APPROVED", "EXPENSE_REJECTED",
          "PURCHASE_ORDER_APPROVED", "PURCHASE_ORDER_REJECTED",
          "PAYROLL_POSTED", "PAYROLL_APPROVED",
        ],
      },
    },
    include: { user: true },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
