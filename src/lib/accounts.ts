import "server-only";
import { z } from "zod";
import { db } from "./db";
import { dec, type Decimal } from "./money";
import { writeAudit, type AuditContext } from "./audit";

/**
 * The chart of accounts.
 *
 * `account:manage` was declared from the first migration and nothing ever
 * checked it, because there was no way to see the chart at all, let alone
 * change it. Every account in the system came from the seed, and adding one
 * meant editing a seed file and reseeding — which on a live database is not a
 * thing anybody should be asked to do.
 *
 * Two rules make the difference between a chart that stays trustworthy and one
 * that quietly rots:
 *
 *   A code is never reused and an account with postings is never deleted.
 *   The history refers to it; renaming is fine, removing is not.
 *
 *   A header account cannot be posted to, and an account with children is a
 *   header. Otherwise a balance appears at two levels of the same subtotal
 *   and the report double-counts it.
 */

export class AccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountError";
  }
}

export const ACCOUNT_TYPES = [
  "ASSET",
  "LIABILITY",
  "EQUITY",
  "REVENUE",
  "COGS",
  "EXPENSE",
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const SCOPES = ["FACTORY", "BRAND", "BOTH"] as const;

/** What a type's balance normally is. Getting this backwards inverts a report. */
export const NORMAL_BALANCE: Record<AccountType, "DEBIT" | "CREDIT"> = {
  ASSET: "DEBIT",
  LIABILITY: "CREDIT",
  EQUITY: "CREDIT",
  REVENUE: "CREDIT",
  COGS: "DEBIT",
  EXPENSE: "DEBIT",
};

const accountSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[0-9]{4}$/, "An account code is four digits, matching the chart's structure."),
  nameAr: z.string().trim().min(1, "An Arabic name is required."),
  nameEn: z.string().trim().min(1, "An English name is required."),
  type: z.enum(ACCOUNT_TYPES),
  scope: z.enum(SCOPES).default("BOTH"),
  parentId: z.string().min(1).nullable().optional(),
  isPostable: z.coerce.boolean().default(true),
  includeInMinuteRate: z.coerce.boolean().default(false),
  includeInBrandFixedPool: z.coerce.boolean().default(false),
  reportingCategory: z.string().trim().max(80).nullable().optional(),
});

export type CreateAccountInput = z.input<typeof accountSchema>;

/**
 * Add an account.
 *
 * The normal balance is derived from the type rather than asked for. It is not
 * a preference — an asset is a debit balance — and offering it as a choice is
 * offering somebody the chance to invert a report.
 */
export async function createAccount(input: CreateAccountInput, ctx: AuditContext) {
  const data = accountSchema.parse(input);

  const existing = await db.account.findUnique({ where: { code: data.code } });
  if (existing) {
    throw new AccountError(
      `Account ${data.code} already exists (${existing.nameEn}). Codes are never reused: ` +
        "the history refers to them.",
    );
  }

  let parent: { id: string; type: string; isPostable: boolean; code: string } | null = null;
  if (data.parentId) {
    parent = await db.account.findUnique({
      where: { id: data.parentId },
      select: { id: true, type: true, isPostable: true, code: true },
    });
    if (!parent) throw new AccountError("That parent account does not exist.");
    if (parent.type !== data.type) {
      // An expense filed under an asset header makes every subtotal above it
      // wrong, and nothing downstream would notice.
      throw new AccountError(
        `A ${data.type} account cannot sit under ${parent.code}, which is a ${parent.type}.`,
      );
    }
  }

  const account = await db.$transaction(async (tx) => {
    const created = await tx.account.create({
      data: {
        code: data.code,
        nameAr: data.nameAr,
        nameEn: data.nameEn,
        type: data.type,
        normalBalance: NORMAL_BALANCE[data.type],
        scope: data.scope,
        parentId: data.parentId ?? null,
        isPostable: data.isPostable,
        includeInMinuteRate: data.includeInMinuteRate,
        includeInBrandFixedPool: data.includeInBrandFixedPool,
        reportingCategory: data.reportingCategory ?? null,
        sortOrder: Number(data.code),
      },
    });

    // A parent with children is a header by definition. Leaving it postable
    // would let a balance appear both on it and inside it, and the subtotal
    // would count the same money twice.
    if (parent?.isPostable) {
      await tx.account.update({ where: { id: parent.id }, data: { isPostable: false } });
    }

    await writeAudit(tx, {
      action: "ACCOUNT_CREATED",
      entityName: "Account",
      entityId: created.id,
      ctx,
      after: {
        code: created.code,
        name: created.nameEn,
        type: created.type,
        normalBalance: created.normalBalance,
        parent: parent?.code ?? null,
        postable: created.isPostable,
      },
    });

    return created;
  });

  return {
    accountId: account.id,
    code: account.code,
    normalBalance: account.normalBalance,
    /** True when adding this account turned its parent into a header. */
    parentBecameHeader: Boolean(parent?.isPostable),
  };
}

const updateSchema = z.object({
  id: z.string().min(1),
  nameAr: z.string().trim().min(1).optional(),
  nameEn: z.string().trim().min(1).optional(),
  scope: z.enum(SCOPES).optional(),
  isActive: z.coerce.boolean().optional(),
  includeInMinuteRate: z.coerce.boolean().optional(),
  includeInBrandFixedPool: z.coerce.boolean().optional(),
  reportingCategory: z.string().trim().max(80).nullable().optional(),
});

/**
 * Rename or retire an account.
 *
 * The code, the type and the normal balance are not editable at all. Changing
 * a type would silently restate every report that has ever included it, and
 * the entries already posted would mean something different from what they
 * meant when they were posted.
 */
export async function updateAccount(
  input: z.input<typeof updateSchema>,
  ctx: AuditContext,
) {
  const data = updateSchema.parse(input);

  const before = await db.account.findUnique({
    where: { id: data.id },
    include: { _count: { select: { journalLines: true, children: true } } },
  });
  if (!before) throw new AccountError("Account not found.");

  if (data.isActive === false) {
    if (before._count.journalLines > 0) {
      // Retiring an account with history is fine — it just stops accepting new
      // postings. Deleting it is what would break the past, and nothing here
      // deletes.
    }
    if (before._count.children > 0) {
      const live = await db.account.count({
        where: { parentId: data.id, isActive: true },
      });
      if (live > 0) {
        throw new AccountError(
          `${before.code} still has ${live} active account(s) under it. Retire those first.`,
        );
      }
    }
  }

  const after = await db.$transaction(async (tx) => {
    const updated = await tx.account.update({
      where: { id: data.id },
      data: {
        ...(data.nameAr !== undefined ? { nameAr: data.nameAr } : {}),
        ...(data.nameEn !== undefined ? { nameEn: data.nameEn } : {}),
        ...(data.scope !== undefined ? { scope: data.scope } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        ...(data.includeInMinuteRate !== undefined
          ? { includeInMinuteRate: data.includeInMinuteRate }
          : {}),
        ...(data.includeInBrandFixedPool !== undefined
          ? { includeInBrandFixedPool: data.includeInBrandFixedPool }
          : {}),
        ...(data.reportingCategory !== undefined
          ? { reportingCategory: data.reportingCategory }
          : {}),
      },
    });

    await writeAudit(tx, {
      action: "ACCOUNT_UPDATED",
      entityName: "Account",
      entityId: updated.id,
      ctx,
      before: {
        nameEn: before.nameEn,
        scope: before.scope,
        isActive: before.isActive,
        includeInMinuteRate: before.includeInMinuteRate,
        includeInBrandFixedPool: before.includeInBrandFixedPool,
      },
      after: {
        nameEn: updated.nameEn,
        scope: updated.scope,
        isActive: updated.isActive,
        includeInMinuteRate: updated.includeInMinuteRate,
        includeInBrandFixedPool: updated.includeInBrandFixedPool,
      },
    });

    return updated;
  });

  return { accountId: after.id, code: after.code };
}

export type ChartRow = {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  type: string;
  normalBalance: string;
  scope: string;
  parentId: string | null;
  parentCode: string | null;
  depth: number;
  isPostable: boolean;
  isActive: boolean;
  includeInMinuteRate: boolean;
  includeInBrandFixedPool: boolean;
  isIntercompany: boolean;
  /** Postings against it. An account with any is permanent. */
  postings: number;
  children: number;
  /** Debits less credits on posted entries. Sign follows the raw arithmetic. */
  balance: Decimal;
};

/**
 * The chart, in order, with what each account actually holds.
 *
 * The balance is included because an account list without balances cannot
 * answer the question people open it for — which of these is doing anything.
 */
export async function chartOfAccounts(options: { includeInactive?: boolean } = {}) {
  const [accounts, balances] = await Promise.all([
    db.account.findMany({
      where: options.includeInactive ? {} : { isActive: true },
      include: {
        parent: { select: { code: true } },
        _count: { select: { journalLines: true, children: true } },
      },
      orderBy: [{ code: "asc" }],
    }),
    db.$queryRaw<{ accountId: string; total: string }[]>`
      SELECT l."accountId" AS "accountId",
             (SUM(l."debit") - SUM(l."credit"))::text AS total
      FROM "journal_lines" l
      JOIN "journal_entries" e ON e."id" = l."journalEntryId"
      WHERE e."status" = 'POSTED'
      GROUP BY l."accountId"
    `,
  ]);

  const balanceFor = new Map(balances.map((b) => [b.accountId, dec(b.total)]));
  const byId = new Map(accounts.map((a) => [a.id, a]));

  /** How deep the account sits, so the list can be read as a tree. */
  const depthOf = (id: string): number => {
    let depth = 0;
    let current = byId.get(id);
    while (current?.parentId) {
      depth += 1;
      current = byId.get(current.parentId);
      if (depth > 10) break; // a cycle cannot happen, but a loop here would
    }
    return depth;
  };

  return accounts.map(
    (a): ChartRow => ({
      id: a.id,
      code: a.code,
      nameAr: a.nameAr,
      nameEn: a.nameEn,
      type: a.type,
      normalBalance: a.normalBalance,
      scope: a.scope,
      parentId: a.parentId,
      parentCode: a.parent?.code ?? null,
      depth: depthOf(a.id),
      isPostable: a.isPostable,
      isActive: a.isActive,
      includeInMinuteRate: a.includeInMinuteRate,
      includeInBrandFixedPool: a.includeInBrandFixedPool,
      isIntercompany: a.isIntercompany,
      postings: a._count.journalLines,
      children: a._count.children,
      balance: balanceFor.get(a.id) ?? dec(0),
    }),
  );
}

/** Accounts that can be a parent: any account, since a parent becomes a header. */
export async function possibleParents() {
  const accounts = await db.account.findMany({
    where: { isActive: true },
    select: { id: true, code: true, nameAr: true, nameEn: true, type: true },
    orderBy: { code: "asc" },
  });
  return accounts;
}
