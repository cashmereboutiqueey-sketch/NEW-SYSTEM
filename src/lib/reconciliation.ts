import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "./db";
import { postEntry, nextDocumentNumber } from "./ledger";
import { dec, type Decimal } from "./money";
import { writeAudit, type AuditContext } from "./audit";

/**
 * Proving the books against what the bank and the couriers actually did.
 *
 * Two things are being reconciled and they are different problems.
 *
 * A **settlement** clears money somebody else is holding. Cash taken on a
 * customer's doorstep belongs to the courier until they pay it over, so it
 * sits in a clearing account, and the balance of that account is exactly what
 * they owe. Clearing it order by order rather than by total is the whole
 * point: a remittance that is 4,000 light against a total looks like a fee,
 * and against a list it is a specific parcel nobody was paid for.
 *
 * A **bank reconciliation** proves the ledger against the statement. What
 * matters is not the two totals agreeing but the lines that appear on one side
 * and not the other — a bank charge nobody recorded, a payment entered twice.
 *
 * Fees are already posted when the sale is recorded, so a clearing balance is
 * net of them. A settlement therefore expects the net, and any gap is a real
 * discrepancy rather than a commission nobody had accounted for.
 */

export class ReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconciliationError";
  }
}

const ACC = {
  BANK: "1120",
  GATEWAY_CLEARING: "1130",
  COD_CLEARING: "1135",
  PAYMENT_FEES: "6230",
} as const;

async function accountId(tx: Prisma.TransactionClient, code: string): Promise<string> {
  const a = await tx.account.findUnique({ where: { code }, select: { id: true } });
  if (!a) throw new ReconciliationError(`Account ${code} is missing from the chart of accounts.`);
  return a.id;
}

const clearingAccount = (provider: "COURIER" | "PAYMENT_GATEWAY") =>
  provider === "COURIER" ? ACC.COD_CLEARING : ACC.GATEWAY_CLEARING;

/* ─────────────────────────────────────────────── what is still outstanding */

/**
 * Payments taken but not yet paid over, oldest first.
 *
 * The age matters more than the amount: a courier holding money for six weeks
 * is a different conversation from one holding it for four days.
 */
export async function awaitingSettlement(provider: "COURIER" | "PAYMENT_GATEWAY") {
  const methods =
    provider === "COURIER" ? (["COD"] as const) : (["CARD", "WALLET"] as const);

  const payments = await db.salesPayment.findMany({
    where: {
      status: "PENDING",
      method: { in: [...methods] },
      settlementLine: null,
    },
    include: {
      salesOrder: { include: { channel: true, customer: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const now = Date.now();

  return payments.map((p) => {
    // The clearing balance is net of the fee, because the fee was posted when
    // the sale was. Expecting the gross here would leave every settlement
    // short by exactly the commission.
    const expected = dec(p.amount).minus(dec(p.fee));
    // Clamped at zero: an order dated ahead of today has not been outstanding
    // for a negative number of days, and showing "-9" invites the reader to
    // distrust the rest of the column.
    const days = Math.max(
      0,
      Math.floor((now - p.salesOrder.orderDate.getTime()) / 86_400_000),
    );

    return {
      paymentId: p.id,
      orderNumber: p.salesOrder.orderNumber,
      orderDate: p.salesOrder.orderDate,
      method: p.method,
      channelEn: p.salesOrder.channel?.nameEn ?? "—",
      channelAr: p.salesOrder.channel?.nameAr ?? "—",
      customer: p.salesOrder.customer?.name ?? null,
      city: p.salesOrder.city,
      gross: dec(p.amount),
      fee: dec(p.fee),
      expected,
      daysOutstanding: days,
      reference: p.reference,
    };
  });
}

/** What the clearing account says is owed, from the posted ledger. */
export async function clearingBalance(
  provider: "COURIER" | "PAYMENT_GATEWAY",
  entityId: string,
): Promise<Decimal> {
  const code = clearingAccount(provider);
  const rows = await db.$queryRaw<{ balance: string }[]>`
    SELECT COALESCE(SUM(l."debit") - SUM(l."credit"), 0)::text AS balance
    FROM "journal_lines" l
    JOIN "journal_entries" e ON e."id" = l."journalEntryId"
    JOIN "accounts" a ON a."id" = l."accountId"
    WHERE a."code" = ${code} AND e."status" = 'POSTED' AND l."entityId" = ${entityId}
  `;
  return dec(rows[0]?.balance ?? 0);
}

/* ──────────────────────────────────────────────────────────── settlements */

/**
 * Records a remittance and clears the payments it covers.
 *
 *   DR bank            what actually landed
 *   DR payment fees    the gap, when they paid short
 *   CR clearing        what the ticked payments were owed
 *
 * A shortfall is charged to fees rather than left as a floating difference,
 * and the reason is recorded. If the shortfall is a parcel that was never
 * paid for, the answer is not to explain the gap — it is to leave that payment
 * unticked so it stays visible as outstanding.
 */
export async function recordSettlement(
  input: {
    provider: "COURIER" | "PAYMENT_GATEWAY";
    entityId: string;
    channelId?: string | null;
    reference?: string | null;
    settlementDate: Date;
    netReceived: string;
    paymentIds: string[];
    varianceNote?: string | null;
  },
  ctx: AuditContext,
): Promise<{
  settlementNumber: string;
  expected: string;
  netReceived: string;
  variance: string;
  cleared: number;
  journalEntryNumber: string;
}> {
  if (input.paymentIds.length === 0) {
    throw new ReconciliationError("Tick the orders this remittance covers.");
  }

  const netReceived = dec(input.netReceived);
  if (netReceived.lessThan(0)) {
    throw new ReconciliationError("A remittance cannot be negative.");
  }

  return db.$transaction(async (tx) => {
    const payments = await tx.salesPayment.findMany({
      where: { id: { in: input.paymentIds } },
      include: { settlementLine: true, salesOrder: true },
    });

    if (payments.length !== input.paymentIds.length) {
      throw new ReconciliationError("One of those payments no longer exists.");
    }

    const alreadySettled = payments.filter((p) => p.settlementLine !== null);
    if (alreadySettled.length > 0) {
      throw new ReconciliationError(
        `${alreadySettled.length} of these were already settled. Clearing them twice would credit the bank for money that only arrived once.`,
      );
    }

    const notPending = payments.filter((p) => p.status !== "PENDING");
    if (notPending.length > 0) {
      throw new ReconciliationError(
        "Some of those payments are not outstanding — they were already collected.",
      );
    }

    const expected = payments.reduce(
      (s, p) => s.plus(dec(p.amount).minus(dec(p.fee))),
      dec(0),
    );
    const variance = netReceived.minus(expected);

    if (!variance.isZero() && !input.varianceNote?.trim()) {
      throw new ReconciliationError(
        `The remittance is ${variance.abs().toFixed(2)} ${variance.lessThan(0) ? "short of" : "over"} what these orders were owed. Say why, or untick the orders that were not paid for.`,
      );
    }

    const settlementNumber = await nextDocumentNumber(tx, "STL", input.settlementDate);

    const lines: Parameters<typeof postEntry>[1]["lines"] = [
      {
        accountId: await accountId(tx, ACC.BANK),
        debit: netReceived,
        entityId: input.entityId,
        description: `Remittance ${settlementNumber}`,
      },
      {
        accountId: await accountId(tx, clearingAccount(input.provider)),
        credit: expected,
        entityId: input.entityId,
        description: `Cleared ${payments.length} payment(s) ${settlementNumber}`,
      },
    ];

    if (variance.lessThan(0)) {
      // They paid short: the gap is an extra charge they took.
      lines.push({
        accountId: await accountId(tx, ACC.PAYMENT_FEES),
        debit: variance.abs(),
        entityId: input.entityId,
        description: `Short on ${settlementNumber}: ${input.varianceNote}`,
      });
    } else if (variance.greaterThan(0)) {
      // They paid over: a refunded charge, credited back against fees.
      lines.push({
        accountId: await accountId(tx, ACC.PAYMENT_FEES),
        credit: variance,
        entityId: input.entityId,
        description: `Over on ${settlementNumber}: ${input.varianceNote}`,
      });
    }

    const journal = await postEntry(tx, {
      entityId: input.entityId,
      postingDate: input.settlementDate,
      sourceType: "PAYMENT",
      sourceId: settlementNumber,
      memo: `${input.provider === "COURIER" ? "Courier" : "Gateway"} remittance ${settlementNumber}`,
      ctx,
      lines,
    });

    const settlement = await tx.settlement.create({
      data: {
        settlementNumber,
        provider: input.provider,
        channelId: input.channelId ?? null,
        entityId: input.entityId,
        reference: input.reference ?? null,
        settlementDate: input.settlementDate,
        expectedAmount: expected.toString(),
        netReceived: netReceived.toString(),
        variance: variance.toString(),
        varianceNote: input.varianceNote ?? null,
        status: "POSTED",
        journalEntryId: journal.id,
        postedAt: new Date(),
        createdByUserId: ctx.userId,
        lines: {
          create: payments.map((p) => ({
            salesPaymentId: p.id,
            expectedAmount: dec(p.amount).minus(dec(p.fee)).toString(),
          })),
        },
      },
    });

    await tx.salesPayment.updateMany({
      where: { id: { in: payments.map((p) => p.id) } },
      data: { status: "COLLECTED", collectedAt: input.settlementDate },
    });

    await writeAudit(tx, {
      action: "SETTLEMENT_RECORDED",
      entityName: "Settlement",
      entityId: settlement.id,
      after: {
        settlementNumber,
        provider: input.provider,
        cleared: payments.length,
        expected: expected.toString(),
        netReceived: netReceived.toString(),
        variance: variance.toString(),
        varianceNote: input.varianceNote ?? null,
      },
      ctx,
    });

    return {
      settlementNumber,
      expected: expected.toString(),
      netReceived: netReceived.toString(),
      variance: variance.toString(),
      cleared: payments.length,
      journalEntryNumber: journal.entryNumber,
    };
  });
}

export async function recentSettlements(limit = 25) {
  const settlements = await db.settlement.findMany({
    include: { channel: true, createdBy: true, _count: { select: { lines: true } } },
    orderBy: [{ settlementDate: "desc" }, { createdAt: "desc" }],
    take: limit,
  });

  return settlements.map((s) => ({
    id: s.id,
    settlementNumber: s.settlementNumber,
    provider: s.provider,
    reference: s.reference,
    date: s.settlementDate,
    channelEn: s.channel?.nameEn ?? "—",
    channelAr: s.channel?.nameAr ?? "—",
    expected: dec(s.expectedAmount),
    netReceived: dec(s.netReceived),
    variance: dec(s.variance),
    varianceNote: s.varianceNote,
    cleared: s._count.lines,
    by: s.createdBy?.name ?? "—",
  }));
}

/* ───────────────────────────────────────────────── bank reconciliation */

/**
 * Enters a statement and matches what it can automatically.
 *
 * A line matches when a posted journal line on the same account has the same
 * amount within a few days and nothing else has claimed it. Anything the
 * machine cannot place is left alone rather than guessed at — a wrong
 * automatic match is far harder to find later than an unmatched line sitting
 * in plain sight.
 */
export async function importStatement(
  input: {
    accountCode: string;
    entityId: string;
    statementDate: Date;
    openingBalance: string;
    closingBalance: string;
    reference?: string | null;
    lines: { valueDate: Date; description: string; reference?: string | null; amount: string }[];
  },
  ctx: AuditContext,
): Promise<{ statementId: string; imported: number; matched: number }> {
  if (input.lines.length === 0) {
    throw new ReconciliationError("A statement with no lines has nothing to reconcile.");
  }

  const statement = await db.bankStatement.create({
    data: {
      accountCode: input.accountCode,
      entityId: input.entityId,
      statementDate: input.statementDate,
      openingBalance: dec(input.openingBalance).toString(),
      closingBalance: dec(input.closingBalance).toString(),
      reference: input.reference ?? null,
      createdByUserId: ctx.userId,
      lines: {
        create: input.lines.map((l) => ({
          valueDate: l.valueDate,
          description: l.description,
          reference: l.reference ?? null,
          amount: dec(l.amount).toString(),
        })),
      },
    },
    include: { lines: true },
  });

  const matched = await autoMatch(statement.id);

  await db.$transaction(async (tx) => {
    await writeAudit(tx, {
      action: "BANK_STATEMENT_IMPORTED",
      entityName: "BankStatement",
      entityId: statement.id,
      after: {
        accountCode: input.accountCode,
        lines: input.lines.length,
        matched,
        closingBalance: input.closingBalance,
      },
      ctx,
    });
  });

  return { statementId: statement.id, imported: statement.lines.length, matched };
}

/** Matches unmatched statement lines against unclaimed journal lines. */
export async function autoMatch(statementId: string, windowDays = 5): Promise<number> {
  const statement = await db.bankStatement.findUnique({
    where: { id: statementId },
    include: { lines: { where: { status: "UNMATCHED" } } },
  });
  if (!statement) throw new ReconciliationError("That statement no longer exists.");

  const account = await db.account.findUnique({ where: { code: statement.accountCode } });
  if (!account) throw new ReconciliationError(`Account ${statement.accountCode} does not exist.`);

  let matched = 0;

  for (const line of statement.lines) {
    const amount = dec(line.amount);
    const from = new Date(line.valueDate.getTime() - windowDays * 86_400_000);
    const to = new Date(line.valueDate.getTime() + windowDays * 86_400_000);

    // Money in is a debit to the bank; money out is a credit.
    const candidates = await db.journalLine.findMany({
      where: {
        accountId: account.id,
        bankStatementLine: null,
        journalEntry: { status: "POSTED", postingDate: { gte: from, lte: to } },
        ...(amount.greaterThan(0)
          ? { debit: amount.toString() }
          : { credit: amount.abs().toString() }),
      },
      include: { journalEntry: true },
      orderBy: { id: "asc" },
      take: 2,
    });

    // Exactly one candidate, or it is a guess. Two identical payments in the
    // same week are precisely the case where guessing goes wrong quietly.
    if (candidates.length !== 1) continue;

    await db.bankStatementLine.update({
      where: { id: line.id },
      data: { status: "MATCHED", matchedJournalLineId: candidates[0].id },
    });
    matched++;
  }

  return matched;
}

/** What is on one side and not the other. */
export async function reconciliationView(statementId: string) {
  const statement = await db.bankStatement.findUnique({
    where: { id: statementId },
    include: {
      lines: { orderBy: { valueDate: "asc" } },
      entity: true,
    },
  });
  if (!statement) return null;

  const account = await db.account.findUnique({ where: { code: statement.accountCode } });
  if (!account) return null;

  const earliest = statement.lines.reduce<Date | null>(
    (min, l) => (!min || l.valueDate < min ? l.valueDate : min),
    null,
  );
  const latest = statement.lines.reduce<Date | null>(
    (max, l) => (!max || l.valueDate > max ? l.valueDate : max),
    null,
  );

  // Ledger lines in the same window that no statement line has claimed: these
  // are payments the books think happened and the bank has never seen.
  const unmatchedInBooks =
    earliest && latest
      ? await db.journalLine.findMany({
          where: {
            accountId: account.id,
            bankStatementLine: null,
            journalEntry: {
              status: "POSTED",
              postingDate: {
                gte: new Date(earliest.getTime() - 5 * 86_400_000),
                lte: new Date(latest.getTime() + 5 * 86_400_000),
              },
            },
          },
          include: { journalEntry: true },
          orderBy: { id: "asc" },
        })
      : [];

  const statementTotal = statement.lines.reduce((s, l) => s.plus(dec(l.amount)), dec(0));
  const matchedTotal = statement.lines
    .filter((l) => l.status === "MATCHED")
    .reduce((s, l) => s.plus(dec(l.amount)), dec(0));

  return {
    id: statement.id,
    accountCode: statement.accountCode,
    accountNameEn: account.nameEn,
    accountNameAr: account.nameAr,
    entityEn: statement.entity.nameEn,
    entityAr: statement.entity.nameAr,
    statementDate: statement.statementDate,
    reference: statement.reference,
    openingBalance: dec(statement.openingBalance),
    closingBalance: dec(statement.closingBalance),
    statementTotal,
    matchedTotal,
    // The statement's own arithmetic. If this does not hold, the statement was
    // entered wrong and matching it is pointless.
    statementConsistent: dec(statement.openingBalance)
      .plus(statementTotal)
      .toDecimalPlaces(2)
      .equals(dec(statement.closingBalance).toDecimalPlaces(2)),
    lines: statement.lines.map((l) => ({
      id: l.id,
      valueDate: l.valueDate,
      description: l.description,
      reference: l.reference,
      amount: dec(l.amount),
      status: l.status,
      note: l.note,
    })),
    inBooksNotOnStatement: unmatchedInBooks.map((l) => ({
      id: l.id,
      entryNumber: l.journalEntry.entryNumber,
      postingDate: l.journalEntry.postingDate,
      memo: l.journalEntry.memo,
      description: l.description,
      amount: dec(l.debit).minus(dec(l.credit)),
    })),
    unmatchedCount: statement.lines.filter((l) => l.status === "UNMATCHED").length,
  };
}

/** Matches a statement line to a ledger line by hand. */
export async function matchLine(
  input: { bankStatementLineId: string; journalLineId: string },
  ctx: AuditContext,
): Promise<void> {
  const [line, journalLine] = await Promise.all([
    db.bankStatementLine.findUnique({ where: { id: input.bankStatementLineId } }),
    db.journalLine.findUnique({
      where: { id: input.journalLineId },
      include: { bankStatementLine: true },
    }),
  ]);
  if (!line) throw new ReconciliationError("That statement line no longer exists.");
  if (!journalLine) throw new ReconciliationError("That ledger line no longer exists.");
  if (journalLine.bankStatementLine) {
    throw new ReconciliationError("That ledger line is already matched to another statement line.");
  }

  const bankAmount = dec(line.amount);
  const ledgerAmount = dec(journalLine.debit).minus(dec(journalLine.credit));
  if (!bankAmount.toDecimalPlaces(2).equals(ledgerAmount.toDecimalPlaces(2))) {
    throw new ReconciliationError(
      `Those do not agree: the statement says ${bankAmount.toFixed(2)} and the ledger says ${ledgerAmount.toFixed(2)}.`,
    );
  }

  await db.$transaction(async (tx) => {
    await tx.bankStatementLine.update({
      where: { id: line.id },
      data: { status: "MATCHED", matchedJournalLineId: journalLine.id },
    });
    await writeAudit(tx, {
      action: "BANK_LINE_MATCHED",
      entityName: "BankStatementLine",
      entityId: line.id,
      after: { journalLineId: journalLine.id, amount: bankAmount.toString() },
      ctx,
    });
  });
}

/**
 * Marks a line as real but not in the books.
 *
 * A bank charge nobody recorded is not noise to be silenced — it is an expense
 * that has to be entered. Kept in its own state so it stays on a list rather
 * than disappearing into "matched".
 */
export async function explainLine(
  input: { bankStatementLineId: string; note: string },
  ctx: AuditContext,
): Promise<void> {
  if (!input.note.trim()) {
    throw new ReconciliationError("Say what the line is, or it is not explained.");
  }

  const line = await db.bankStatementLine.findUnique({
    where: { id: input.bankStatementLineId },
  });
  if (!line) throw new ReconciliationError("That statement line no longer exists.");

  await db.$transaction(async (tx) => {
    await tx.bankStatementLine.update({
      where: { id: line.id },
      data: { status: "EXPLAINED", note: input.note.trim() },
    });
    await writeAudit(tx, {
      action: "BANK_LINE_EXPLAINED",
      entityName: "BankStatementLine",
      entityId: line.id,
      after: { note: input.note.trim(), amount: line.amount.toString() },
      ctx,
    });
  });
}

export async function recentStatements(limit = 20) {
  const statements = await db.bankStatement.findMany({
    include: {
      entity: true,
      createdBy: true,
      lines: { select: { status: true, amount: true } },
    },
    orderBy: [{ statementDate: "desc" }, { createdAt: "desc" }],
    take: limit,
  });

  return statements.map((s) => ({
    id: s.id,
    accountCode: s.accountCode,
    entityEn: s.entity.nameEn,
    entityAr: s.entity.nameAr,
    statementDate: s.statementDate,
    reference: s.reference,
    closingBalance: dec(s.closingBalance),
    lineCount: s.lines.length,
    unmatched: s.lines.filter((l) => l.status === "UNMATCHED").length,
    explained: s.lines.filter((l) => l.status === "EXPLAINED").length,
    by: s.createdBy?.name ?? "—",
  }));
}
