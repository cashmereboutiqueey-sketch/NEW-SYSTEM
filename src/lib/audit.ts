import "server-only";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Audit writing.
 *
 * Every consequential mutation records who did what, to which record, with the
 * before and after state. Audit rows are append-only — nothing updates or
 * deletes them.
 *
 * The transaction client is a required argument rather than the module-level
 * `db` on purpose: the audit row must commit or roll back together with the
 * change it describes. An audit trail that survives a rolled-back write is
 * worse than none, because it claims something happened that did not.
 */

export type AuditContext = {
  userId: string | null;
  /** Free-text justification. Required for corrections and overrides. */
  reason?: string | null;
};

export async function writeAudit(
  tx: Prisma.TransactionClient,
  input: {
    action: string;
    entityName: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
    ctx: AuditContext;
  },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      userId: input.ctx.userId,
      action: input.action,
      entityName: input.entityName,
      entityId: input.entityId,
      before: toJson(input.before),
      after: toJson(input.after),
      reason: input.ctx.reason ?? null,
    },
  });
}

/**
 * Prisma `Decimal` and `Date` values do not survive `JSON.stringify` in a form
 * that reads back usefully, so they are normalised to strings first. Without
 * this an audited amount shows up as `{}` — the one thing an auditor needs.
 */
function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(
    JSON.stringify(value, (_key, v) => {
      if (v === null || v === undefined) return v;
      if (typeof v === "object" && "toFixed" in v && typeof v.toFixed === "function") {
        return v.toString();
      }
      if (v instanceof Date) return v.toISOString();
      if (typeof v === "bigint") return v.toString();
      return v;
    }),
  ) as Prisma.InputJsonValue;
}
