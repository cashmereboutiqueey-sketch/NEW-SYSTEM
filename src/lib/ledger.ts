import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { checkBalanced, describeViolation, reverseLines, type DraftLine } from "@/core/ledger";
import { writeAudit, type AuditContext } from "./audit";
import { dec } from "./money";

/**
 * Posting service — the only supported way to write to the general ledger.
 *
 * Every posting runs inside the caller's transaction so the journal, its lines
 * and the audit row commit together with whatever subledger document caused
 * them. A sale that records revenue but loses its journal to a failed
 * transaction is precisely the drift this prevents.
 */

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

export type PostEntryInput = {
  entityId: string;
  postingDate: Date;
  sourceType: Prisma.JournalEntryCreateInput["sourceType"];
  sourceId?: string | null;
  memo?: string | null;
  lines: DraftLine[];
  ctx: AuditContext;
  /** Leave a posting as DRAFT when it still needs review before it counts. */
  status?: "DRAFT" | "PENDING_REVIEW" | "POSTED";
};

/**
 * Issues the next document number atomically.
 *
 * `UPDATE … RETURNING` on a single counter row is what makes this safe under
 * concurrency: the row lock is held for the rest of the transaction, so two
 * simultaneous postings serialise instead of colliding on a unique index.
 */
export async function nextDocumentNumber(
  tx: Prisma.TransactionClient,
  docType: string,
  date: Date,
): Promise<string> {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;

  const rows = await tx.$queryRaw<{ lastNumber: number }[]>`
    INSERT INTO "document_sequences" ("id", "docType", "year", "month", "lastNumber", "updatedAt")
    VALUES (gen_random_uuid()::text, ${docType}, ${year}, ${month}, 1, NOW())
    ON CONFLICT ("docType", "year", "month")
    DO UPDATE SET "lastNumber" = "document_sequences"."lastNumber" + 1, "updatedAt" = NOW()
    RETURNING "lastNumber"
  `;

  const seq = rows[0].lastNumber;
  return `${docType}-${year}-${String(month).padStart(2, "0")}-${String(seq).padStart(4, "0")}`;
}

/** Resolves the fiscal period a date falls in, refusing closed periods. */
async function resolveOpenPeriod(
  tx: Prisma.TransactionClient,
  postingDate: Date,
  status: string,
): Promise<string> {
  const period = await tx.fiscalPeriod.findFirst({
    where: { startDate: { lte: postingDate }, endDate: { gte: postingDate } },
  });
  if (!period) {
    throw new LedgerError(
      `No fiscal period covers ${postingDate.toISOString().slice(0, 10)}. Create the period before posting to it.`,
    );
  }
  if (status === "POSTED" && period.status === "CLOSED") {
    throw new LedgerError(
      `Fiscal period ${period.year}-${String(period.month).padStart(2, "0")} is closed. Post the correction to an open period instead.`,
    );
  }
  return period.id;
}

export async function postEntry(
  tx: Prisma.TransactionClient,
  input: PostEntryInput,
): Promise<{ id: string; entryNumber: string }> {
  const status = input.status ?? "POSTED";

  // Checked here as well as by the database trigger so the caller gets a
  // specific, actionable message instead of a raw Postgres exception.
  const balance = checkBalanced(input.lines);
  if (!balance.ok) {
    throw new LedgerError(balance.violations.map(describeViolation).join(" "));
  }

  const fiscalPeriodId = await resolveOpenPeriod(tx, input.postingDate, status);
  const entryNumber = await nextDocumentNumber(tx, "JE", input.postingDate);

  const entry = await tx.journalEntry.create({
    data: {
      entryNumber,
      entityId: input.entityId,
      fiscalPeriodId,
      status,
      postingDate: input.postingDate,
      memo: input.memo ?? null,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      createdByUserId: input.ctx.userId,
      postedByUserId: status === "POSTED" ? input.ctx.userId : null,
      postedAt: status === "POSTED" ? new Date() : null,
      lines: {
        create: input.lines.map((l, i) => ({
          lineNumber: i + 1,
          accountId: l.accountId,
          debit: dec(l.debit ?? 0).toString(),
          credit: dec(l.credit ?? 0).toString(),
          entityId: l.entityId,
          costCenterId: l.costCenterId ?? null,
          supplierId: l.supplierId ?? null,
          customerId: l.customerId ?? null,
          styleId: l.styleId ?? null,
          variantId: l.variantId ?? null,
          appliedTaxRate: l.appliedTaxRate != null ? dec(l.appliedTaxRate).toString() : null,
          description: l.description ?? null,
        })),
      },
    },
    select: { id: true, entryNumber: true },
  });

  await writeAudit(tx, {
    action: status === "POSTED" ? "JOURNAL_POSTED" : "JOURNAL_DRAFTED",
    entityName: "JournalEntry",
    entityId: entry.id,
    after: {
      entryNumber: entry.entryNumber,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      totalDebit: balance.totalDebit.toString(),
      lines: input.lines.length,
    },
    ctx: input.ctx,
  });

  return entry;
}

/**
 * Corrects a posted entry by posting its mirror image and linking the two.
 *
 * The original is never touched — the database forbids it, and the audit trail
 * depends on it staying exactly as posted.
 */
export async function reverseEntry(
  tx: Prisma.TransactionClient,
  input: { entryId: string; postingDate: Date; reason: string; ctx: AuditContext },
): Promise<{ id: string; entryNumber: string }> {
  const original = await tx.journalEntry.findUnique({
    where: { id: input.entryId },
    include: { lines: true, reversedBy: true },
  });

  if (!original) throw new LedgerError(`Journal entry ${input.entryId} not found.`);
  if (original.status !== "POSTED") {
    throw new LedgerError("Only a posted entry can be reversed; edit or delete the draft instead.");
  }
  if (original.reversedBy) {
    throw new LedgerError(
      `Entry ${original.entryNumber} was already reversed by ${original.reversedBy.entryNumber}.`,
    );
  }
  if (!input.reason.trim()) {
    throw new LedgerError("A reversal needs a reason; it becomes part of the audit trail.");
  }

  const mirrored = reverseLines(
    original.lines.map((l) => ({
      accountId: l.accountId,
      debit: l.debit.toString(),
      credit: l.credit.toString(),
      entityId: l.entityId,
      costCenterId: l.costCenterId,
      supplierId: l.supplierId,
      customerId: l.customerId,
      styleId: l.styleId,
      variantId: l.variantId,
      appliedTaxRate: l.appliedTaxRate?.toString() ?? null,
      description: l.description,
    })),
  );

  const fiscalPeriodId = await resolveOpenPeriod(tx, input.postingDate, "POSTED");
  const entryNumber = await nextDocumentNumber(tx, "JE", input.postingDate);

  const reversal = await tx.journalEntry.create({
    data: {
      entryNumber,
      entityId: original.entityId,
      fiscalPeriodId,
      status: "POSTED",
      postingDate: input.postingDate,
      memo: `Reversal of ${original.entryNumber}`,
      sourceType: "ADJUSTMENT",
      sourceId: original.id,
      reversesEntryId: original.id,
      reversalReason: input.reason,
      createdByUserId: input.ctx.userId,
      postedByUserId: input.ctx.userId,
      postedAt: new Date(),
      lines: {
        create: mirrored.map((l, i) => ({
          lineNumber: i + 1,
          accountId: l.accountId,
          debit: dec(l.debit ?? 0).toString(),
          credit: dec(l.credit ?? 0).toString(),
          entityId: l.entityId,
          costCenterId: l.costCenterId ?? null,
          supplierId: l.supplierId ?? null,
          customerId: l.customerId ?? null,
          styleId: l.styleId ?? null,
          variantId: l.variantId ?? null,
          appliedTaxRate: l.appliedTaxRate != null ? dec(l.appliedTaxRate).toString() : null,
          description: l.description ?? null,
        })),
      },
    },
    select: { id: true, entryNumber: true },
  });

  await writeAudit(tx, {
    action: "JOURNAL_REVERSED",
    entityName: "JournalEntry",
    entityId: original.id,
    before: { entryNumber: original.entryNumber, status: original.status },
    after: { reversedBy: reversal.entryNumber },
    ctx: { ...input.ctx, reason: input.reason },
  });

  return reversal;
}
