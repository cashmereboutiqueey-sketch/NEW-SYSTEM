import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "./db";
import { postEntry, LedgerError } from "./ledger";
import { writeAudit, type AuditContext } from "./audit";
import { expensePayable } from "./approvals";
import { dec } from "./money";
import { violatesSeparationOfDuties } from "@/core/permissions";

/**
 * Expense subledger.
 *
 * An expense is recognised when it is *incurred*, never when it is paid — that
 * is the whole point of the accrual basis. Recording it writes both the
 * subledger document and its general-ledger journal in one transaction:
 *
 *   DR  expense account (from the cost category)
 *     CR  trade payables
 *
 * Payment is a separate, later event that settles the liability:
 *
 *   DR  trade payables
 *     CR  bank or cash
 *
 * Because the two are distinct, paying an invoice never moves the cost into
 * the payment month.
 */

/** Accounts the postings need, looked up by code rather than hardcoded id. */
const PAYABLE_ACCOUNT_CODE = "2110";
const BANK_ACCOUNT_CODE = "1120";
const CASH_ACCOUNT_CODE = "1110";

export const createExpenseSchema = z.object({
  entityId: z.string().min(1),
  costCategoryId: z.string().min(1),
  supplierId: z.string().min(1).nullable().optional(),
  costCenterId: z.string().min(1).nullable().optional(),
  description: z.string().min(1, "Describe what this expense is for."),
  reference: z.string().nullable().optional(),
  amount: z.coerce.number().positive("Amount must be greater than zero."),
  incurredDate: z.coerce.date(),
  dueDate: z.coerce.date(),
});

/** Pre-parse shape: dates and amounts arrive from a form as strings. */
export type CreateExpenseInput = z.input<typeof createExpenseSchema>;

export class ExpenseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpenseError";
  }
}

async function accountIdByCode(tx: Prisma.TransactionClient, code: string): Promise<string> {
  const account = await tx.account.findUnique({ where: { code }, select: { id: true } });
  if (!account) {
    throw new ExpenseError(`Account ${code} is missing from the chart of accounts.`);
  }
  return account.id;
}

/**
 * Records an expense and posts it to the ledger in one transaction.
 *
 * Amounts are stored ex-VAT. Decision D-001: the business is not VAT
 * registered, so no input VAT is separated out — supplier VAT is part of the
 * cost. When registration happens, the VAT portion becomes a third line
 * debiting account 1450 and this posting grows by one line.
 */
export async function createExpense(
  input: CreateExpenseInput,
  ctx: AuditContext,
): Promise<{ expenseId: string; journalEntryNumber: string }> {
  const data = createExpenseSchema.parse(input);

  if (data.dueDate < data.incurredDate) {
    throw new ExpenseError("Due date cannot be before the date the cost was incurred.");
  }

  return db.$transaction(async (tx) => {
    const category = await tx.costCategory.findUnique({
      where: { id: data.costCategoryId },
      select: { id: true, code: true, nameEn: true, entityId: true, accountId: true, isActive: true },
    });

    if (!category) throw new ExpenseError("Cost category not found.");
    if (!category.isActive) throw new ExpenseError(`Cost category ${category.code} is inactive.`);
    if (category.entityId !== data.entityId) {
      // A factory category on a brand expense would put the cost in the wrong
      // set of books and quietly corrupt both entities' P&L.
      throw new ExpenseError(
        `Cost category ${category.code} belongs to a different entity than this expense.`,
      );
    }
    if (!category.accountId) {
      throw new ExpenseError(
        `Cost category ${category.code} has no ledger account, so the expense cannot be posted.`,
      );
    }

    const period = await tx.fiscalPeriod.findFirst({
      where: { startDate: { lte: data.incurredDate }, endDate: { gte: data.incurredDate } },
    });
    if (!period) {
      throw new ExpenseError(
        `No fiscal period covers ${data.incurredDate.toISOString().slice(0, 10)}.`,
      );
    }
    if (period.status === "CLOSED") {
      throw new ExpenseError(
        `Period ${period.year}-${String(period.month).padStart(2, "0")} is closed. File the expense in an open period.`,
      );
    }

    const amount = dec(data.amount);

    const expense = await tx.expense.create({
      data: {
        createdByUserId: ctx.userId,
        entityId: data.entityId,
        costCategoryId: category.id,
        fiscalPeriodId: period.id,
        supplierId: data.supplierId ?? null,
        description: data.description,
        reference: data.reference ?? null,
        amount: amount.toString(),
        incurredDate: data.incurredDate,
        dueDate: data.dueDate,
        status: "UNPAID",
      },
    });

    const payableAccountId = await accountIdByCode(tx, PAYABLE_ACCOUNT_CODE);

    const journal = await postEntry(tx, {
      entityId: data.entityId,
      postingDate: data.incurredDate,
      sourceType: "EXPENSE",
      sourceId: expense.id,
      memo: data.description,
      ctx,
      lines: [
        {
          accountId: category.accountId,
          debit: amount,
          entityId: data.entityId,
          costCenterId: data.costCenterId ?? null,
          supplierId: data.supplierId ?? null,
          description: data.description,
        },
        {
          accountId: payableAccountId,
          credit: amount,
          entityId: data.entityId,
          costCenterId: data.costCenterId ?? null,
          supplierId: data.supplierId ?? null,
          description: data.reference ?? data.description,
        },
      ],
    });

    await writeAudit(tx, {
      action: "EXPENSE_CREATED",
      entityName: "Expense",
      entityId: expense.id,
      after: {
        amount: amount.toString(),
        category: category.code,
        incurredDate: data.incurredDate,
        dueDate: data.dueDate,
        journalEntry: journal.entryNumber,
      },
      ctx,
    });

    return { expenseId: expense.id, journalEntryNumber: journal.entryNumber };
  });
}

export const payExpenseSchema = z.object({
  expenseId: z.string().min(1),
  amount: z.coerce.number().positive("Payment must be greater than zero."),
  paidDate: z.coerce.date(),
  method: z.enum(["BANK", "CASH"]).default("BANK"),
  reference: z.string().nullable().optional(),
});

export type PayExpenseInput = z.input<typeof payExpenseSchema>;

/**
 * Settles part or all of an expense.
 *
 * Overpayment is rejected rather than absorbed: a payment larger than the
 * outstanding balance means either the wrong invoice or the wrong amount, and
 * silently accepting it would leave a negative payable that reconciliation
 * could never explain.
 */
export async function payExpense(
  input: PayExpenseInput,
  ctx: AuditContext,
): Promise<{ paymentId: string; journalEntryNumber: string; status: string }> {
  const data = payExpenseSchema.parse(input);

  return db.$transaction(async (tx) => {
    const expense = await tx.expense.findUnique({
      where: { id: data.expenseId },
      select: {
        id: true, entityId: true, amount: true, paidAmount: true, status: true,
        supplierId: true, description: true,
      },
    });
    if (!expense) throw new ExpenseError("Expense not found.");

    // Checked here rather than only on the approvals screen, so money cannot
    // leave by a route that skips the inbox — an import, a script, a second
    // screen somebody adds later.
    const payable = await expensePayable(expense.id);
    if (!payable.ok) throw new ExpenseError(payable.reason ?? "This expense cannot be paid yet.");

    const outstanding = dec(expense.amount).minus(dec(expense.paidAmount));
    const payment = dec(data.amount);

    if (outstanding.lessThanOrEqualTo(0)) {
      throw new ExpenseError("This expense is already fully paid.");
    }
    if (payment.greaterThan(outstanding)) {
      throw new ExpenseError(
        `Payment ${payment.toFixed(2)} exceeds the outstanding balance of ${outstanding.toFixed(2)}.`,
      );
    }

    const newPaid = dec(expense.paidAmount).plus(payment);
    const status = newPaid.greaterThanOrEqualTo(dec(expense.amount))
      ? "PAID"
      : "PARTIALLY_PAID";

    const paymentRow = await tx.expensePayment.create({
      data: {
        expenseId: expense.id,
        amount: payment.toString(),
        paidDate: data.paidDate,
        method: data.method,
        reference: data.reference ?? null,
      },
    });

    await tx.expense.update({
      where: { id: expense.id },
      data: { paidAmount: newPaid.toString(), status },
    });

    const payableAccountId = await accountIdByCode(tx, PAYABLE_ACCOUNT_CODE);
    const fundingAccountId = await accountIdByCode(
      tx,
      data.method === "CASH" ? CASH_ACCOUNT_CODE : BANK_ACCOUNT_CODE,
    );

    const journal = await postEntry(tx, {
      entityId: expense.entityId,
      postingDate: data.paidDate,
      sourceType: "EXPENSE_PAYMENT",
      sourceId: paymentRow.id,
      memo: `Payment — ${expense.description}`,
      ctx,
      lines: [
        {
          accountId: payableAccountId,
          debit: payment,
          entityId: expense.entityId,
          supplierId: expense.supplierId,
          description: data.reference ?? "Supplier payment",
        },
        {
          accountId: fundingAccountId,
          credit: payment,
          entityId: expense.entityId,
          supplierId: expense.supplierId,
          description: data.reference ?? "Supplier payment",
        },
      ],
    });

    await writeAudit(tx, {
      action: "EXPENSE_PAID",
      entityName: "Expense",
      entityId: expense.id,
      before: { paidAmount: dec(expense.paidAmount).toString(), status: expense.status },
      after: {
        paidAmount: newPaid.toString(),
        status,
        payment: payment.toString(),
        journalEntry: journal.entryNumber,
      },
      ctx,
    });

    return { paymentId: paymentRow.id, journalEntryNumber: journal.entryNumber, status };
  });
}
