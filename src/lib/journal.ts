import "server-only";
import { z } from "zod";
import { db } from "./db";
import { dec, type Decimal } from "./money";
import { reverseEntry } from "./ledger";
import type { AuditContext } from "./audit";

/**
 * The ledger, and the only honest way to correct it.
 *
 * Every posting in this system is immutable — the database refuses to edit a
 * posted line, from application code and from raw SQL alike. That is the right
 * rule and it left a hole: nothing could put a mistake right. `reverseEntry`
 * has been in the ledger since the first migration, correct and complete, with
 * no screen and no caller.
 *
 * A reversal is not a deletion. The original stays exactly as posted, the
 * mirror image is posted beside it, and the two are linked — so the books show
 * both the mistake and the correction, which is what an auditor is entitled to
 * see. Quietly amending the original would leave a trial balance that is right
 * today and a history that has been rewritten.
 */

export class JournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JournalError";
  }
}

export type JournalFilters = {
  entityId?: string | null;
  status?: "DRAFT" | "POSTED" | "REVERSED" | null;
  sourceType?: string | null;
  accountCode?: string | null;
  from?: Date | null;
  to?: Date | null;
  search?: string | null;
  limit?: number;
};

/**
 * Entries, newest first.
 *
 * Each carries its own totals so the list can be read without opening
 * anything: a posted entry that does not balance is impossible — the trigger
 * forbids it — so a total that looks wrong means the filter is wrong, not the
 * books.
 */
export async function journalEntries(filters: JournalFilters = {}) {
  const where: Record<string, unknown> = {};
  if (filters.entityId) where.entityId = filters.entityId;
  if (filters.status) where.status = filters.status;
  if (filters.sourceType) where.sourceType = filters.sourceType;
  if (filters.from || filters.to) {
    where.postingDate = {
      ...(filters.from ? { gte: filters.from } : {}),
      ...(filters.to ? { lte: filters.to } : {}),
    };
  }
  if (filters.accountCode) {
    where.lines = { some: { account: { code: filters.accountCode } } };
  }
  if (filters.search?.trim()) {
    const term = filters.search.trim();
    where.OR = [
      { entryNumber: { contains: term, mode: "insensitive" } },
      { memo: { contains: term, mode: "insensitive" } },
    ];
  }

  const entries = await db.journalEntry.findMany({
    where,
    include: {
      entity: { select: { nameAr: true, nameEn: true, kind: true } },
      fiscalPeriod: { select: { year: true, month: true, status: true } },
      createdBy: { select: { name: true } },
      postedBy: { select: { name: true } },
      reversedBy: { select: { entryNumber: true, postingDate: true } },
      reversesEntry: { select: { entryNumber: true } },
      lines: {
        include: { account: { select: { code: true, nameAr: true, nameEn: true } } },
        orderBy: { lineNumber: "asc" },
      },
    },
    orderBy: [{ postingDate: "desc" }, { entryNumber: "desc" }],
    take: filters.limit ?? 100,
  });

  return entries.map((e) => {
    const debit = e.lines.reduce((t, l) => t.plus(dec(l.debit)), dec(0));
    const credit = e.lines.reduce((t, l) => t.plus(dec(l.credit)), dec(0));

    return {
      id: e.id,
      entryNumber: e.entryNumber,
      status: e.status,
      postingDate: e.postingDate,
      memo: e.memo,
      sourceType: e.sourceType,
      sourceId: e.sourceId,
      entityAr: e.entity.nameAr,
      entityEn: e.entity.nameEn,
      entityKind: e.entity.kind,
      period: `${e.fiscalPeriod.year}-${String(e.fiscalPeriod.month).padStart(2, "0")}`,
      periodStatus: e.fiscalPeriod.status,
      createdBy: e.createdBy?.name ?? null,
      postedBy: e.postedBy?.name ?? null,
      debit,
      credit,
      /** Always true for a posted entry; the trigger will not allow otherwise. */
      balanced: debit.equals(credit),

      /** The entry that put this one right, if somebody has. */
      reversedByNumber: e.reversedBy?.entryNumber ?? null,
      reversedOn: e.reversedBy?.postingDate ?? null,
      /** The mistake this entry exists to correct, if it is a correction. */
      reversesNumber: e.reversesEntry?.entryNumber ?? null,
      reversalReason: e.reversalReason,

      /** A posted entry that has not already been reversed can still be put right. */
      reversible: e.status === "POSTED" && !e.reversedBy,

      lines: e.lines.map((l) => ({
        id: l.id,
        lineNumber: l.lineNumber,
        accountCode: l.account.code,
        accountAr: l.account.nameAr,
        accountEn: l.account.nameEn,
        debit: l.debit.toString(),
        credit: l.credit.toString(),
        description: l.description,
      })),
    };
  });
}

const reversalSchema = z.object({
  entryId: z.string().min(1),
  postingDate: z.coerce.date(),
  reason: z.string().trim().min(10, "Say why in a sentence — it becomes part of the audit trail."),
});

export type ReverseInput = z.input<typeof reversalSchema>;

/**
 * Put a posted entry right.
 *
 * The reason is required and deliberately not a dropdown. "Correction" tells
 * whoever reads the books in a year exactly nothing; the sentence somebody had
 * to type is the only part of a reversal that carries information.
 */
export async function reverseJournalEntry(input: ReverseInput, ctx: AuditContext) {
  const data = reversalSchema.parse(input);

  return db.$transaction(async (tx) => {
    const reversal = await reverseEntry(tx, {
      entryId: data.entryId,
      postingDate: data.postingDate,
      reason: data.reason,
      ctx,
    });
    return { entryNumber: reversal.entryNumber, id: reversal.id };
  });
}

/** The filters the screen offers, built from what is actually in the ledger. */
export async function journalFilterOptions() {
  const [entities, sources, accounts] = await Promise.all([
    db.entity.findMany({ select: { id: true, nameAr: true, nameEn: true, kind: true } }),
    db.journalEntry.findMany({
      distinct: ["sourceType"],
      select: { sourceType: true },
      orderBy: { sourceType: "asc" },
    }),
    db.account.findMany({
      where: { isPostable: true, isActive: true },
      select: { code: true, nameAr: true, nameEn: true },
      orderBy: { code: "asc" },
    }),
  ]);

  return {
    entities,
    sourceTypes: sources.map((s) => s.sourceType),
    accounts,
  };
}

/* ────────────────────────────── the audit trail ─────────────────────────── */

export type AuditFilters = {
  userId?: string | null;
  action?: string | null;
  entityName?: string | null;
  entityId?: string | null;
  from?: Date | null;
  to?: Date | null;
  limit?: number;
};

/**
 * Who did what, and what it looked like before and after.
 *
 * Written on every consequential action since the first migration and never
 * readable from anywhere. An audit trail nobody can open is a trail that only
 * exists to be believed in — the point of writing it is that somebody can
 * check it afterwards without asking an engineer for a database query.
 */
export async function auditTrail(filters: AuditFilters = {}) {
  const where: Record<string, unknown> = {};
  if (filters.userId) where.userId = filters.userId;
  if (filters.action) where.action = filters.action;
  if (filters.entityName) where.entityName = filters.entityName;
  if (filters.entityId) where.entityId = filters.entityId;
  if (filters.from || filters.to) {
    where.createdAt = {
      ...(filters.from ? { gte: filters.from } : {}),
      ...(filters.to ? { lte: filters.to } : {}),
    };
  }

  const rows = await db.auditLog.findMany({
    where,
    include: { user: { select: { name: true, email: true, role: true } } },
    orderBy: { createdAt: "desc" },
    take: filters.limit ?? 200,
  });

  return rows.map((r) => ({
    id: r.id,
    at: r.createdAt,
    action: r.action,
    entityName: r.entityName,
    entityId: r.entityId,
    // Null when the actor was the system itself — a seed, a scheduled job, a
    // migration. Saying so is better than attributing it to nobody in
    // particular and letting a reader assume it was a person.
    userName: r.user?.name ?? null,
    userEmail: r.user?.email ?? null,
    userRole: r.user?.role ?? null,
    reason: r.reason,
    before: r.before,
    after: r.after,
  }));
}

/** What the audit filters can offer, derived from what has actually happened. */
export async function auditFilterOptions() {
  const [actions, entities, users] = await Promise.all([
    db.auditLog.findMany({
      distinct: ["action"],
      select: { action: true },
      orderBy: { action: "asc" },
    }),
    db.auditLog.findMany({
      distinct: ["entityName"],
      select: { entityName: true },
      orderBy: { entityName: "asc" },
    }),
    db.user.findMany({
      where: { auditLogs: { some: {} } },
      select: { id: true, name: true, role: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return {
    actions: actions.map((a) => a.action),
    entityNames: entities.map((e) => e.entityName),
    users,
  };
}

/** A count of what has been recorded, so an empty screen can say why. */
export async function auditSummary(sinceDays = 30) {
  const since = new Date();
  since.setDate(since.getDate() - sinceDays);

  const [total, recent, byAction] = await Promise.all([
    db.auditLog.count(),
    db.auditLog.count({ where: { createdAt: { gte: since } } }),
    db.auditLog.groupBy({
      by: ["action"],
      where: { createdAt: { gte: since } },
      _count: { action: true },
      orderBy: { _count: { action: "desc" } },
      take: 8,
    }),
  ]);

  return {
    total,
    recent,
    sinceDays,
    topActions: byAction.map((a) => ({ action: a.action, count: a._count.action })),
  };
}
