import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { postEntry, reverseEntry, nextDocumentNumber, LedgerError } from "./ledger";

/** The posting service, against a real database. */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let factoryId: string;
let rentAccountId: string;
let payableAccountId: string;
let openDate: Date;
let closedDate: Date;

const ctx = { userId: null, reason: null };

beforeAll(async () => {
  factoryId = (await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } })).id;
  rentAccountId = (await db.account.findUniqueOrThrow({ where: { code: "6120" } })).id;
  payableAccountId = (await db.account.findUniqueOrThrow({ where: { code: "2110" } })).id;

  const open = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" }, orderBy: { startDate: "asc" },
  });
  openDate = new Date(open.startDate);

  const closed = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "CLOSED" }, orderBy: { startDate: "asc" },
  });
  closedDate = new Date(closed.startDate);
});

afterAll(async () => {
  await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
  await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
  try {
    await db.bankStatementLine.deleteMany({});
    await db.bankStatement.deleteMany({});
    await db.journalLine.deleteMany({});
    await db.journalEntry.deleteMany({});
    await db.auditLog.deleteMany({ where: { entityName: "JournalEntry" } });
    await db.documentSequence.deleteMany({});
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
  }
  await db.$disconnect();
});

/** Factory rent 55,000 ex-VAT — the worked example from the accounting spec. */
function rentLines(amount = "55000") {
  return [
    { accountId: rentAccountId, debit: amount, entityId: factoryId },
    { accountId: payableAccountId, credit: amount, entityId: factoryId },
  ];
}

describe("postEntry", () => {
  it("posts a balanced entry and returns its number", async () => {
    const result = await db.$transaction((tx) =>
      postEntry(tx, {
        entityId: factoryId,
        postingDate: openDate,
        sourceType: "EXPENSE",
        memo: "Factory rent",
        lines: rentLines(),
        ctx,
      }),
    );

    expect(result.entryNumber).toMatch(/^JE-\d{4}-\d{2}-\d{4}$/);

    const entry = await db.journalEntry.findUniqueOrThrow({
      where: { id: result.id },
      include: { lines: true },
    });
    expect(entry.status).toBe("POSTED");
    expect(entry.postedAt).not.toBeNull();
    expect(entry.lines).toHaveLength(2);
    expect(entry.lines.map((l) => l.lineNumber).sort()).toEqual([1, 2]);
  });

  it("writes an audit row in the same transaction", async () => {
    const result = await db.$transaction((tx) =>
      postEntry(tx, {
        entityId: factoryId, postingDate: openDate, sourceType: "EXPENSE",
        lines: rentLines("1234.5678"), ctx,
      }),
    );

    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityName: "JournalEntry", entityId: result.id },
    });
    expect(audit.action).toBe("JOURNAL_POSTED");
    // Decimals must survive as readable strings, not as `{}`.
    expect(audit.after).toMatchObject({ totalDebit: "1234.5678" });
  });

  it("rejects an unbalanced entry with a specific message, not a raw pg error", async () => {
    await expect(
      db.$transaction((tx) =>
        postEntry(tx, {
          entityId: factoryId, postingDate: openDate, sourceType: "MANUAL",
          lines: [
            { accountId: rentAccountId, debit: "100", entityId: factoryId },
            { accountId: payableAccountId, credit: "60", entityId: factoryId },
          ],
          ctx,
        }),
      ),
    ).rejects.toThrow(/does not balance.*debits 100.*credits 60/i);
  });

  it("rolls back the journal when the surrounding transaction fails", async () => {
    const before = await db.journalEntry.count();

    await expect(
      db.$transaction(async (tx) => {
        await postEntry(tx, {
          entityId: factoryId, postingDate: openDate, sourceType: "EXPENSE",
          lines: rentLines(), ctx,
        });
        throw new Error("subledger write failed");
      }),
    ).rejects.toThrow("subledger write failed");

    expect(await db.journalEntry.count()).toBe(before);
  });

  it("refuses to post into a closed period", async () => {
    await expect(
      db.$transaction((tx) =>
        postEntry(tx, {
          entityId: factoryId, postingDate: closedDate, sourceType: "EXPENSE",
          lines: rentLines(), ctx,
        }),
      ),
    ).rejects.toThrow(/closed/i);
  });

  it("refuses a date no fiscal period covers", async () => {
    await expect(
      db.$transaction((tx) =>
        postEntry(tx, {
          entityId: factoryId, postingDate: new Date("2019-03-15T00:00:00.000Z"),
          sourceType: "EXPENSE", lines: rentLines(), ctx,
        }),
      ),
    ).rejects.toThrow(LedgerError);
  });

  it("allows a draft in a closed period but not a posting", async () => {
    const draft = await db.$transaction((tx) =>
      postEntry(tx, {
        entityId: factoryId, postingDate: closedDate, sourceType: "MANUAL",
        lines: rentLines(), ctx, status: "DRAFT",
      }),
    );
    const entry = await db.journalEntry.findUniqueOrThrow({ where: { id: draft.id } });
    expect(entry.status).toBe("DRAFT");
    expect(entry.postedAt).toBeNull();
  });
});

describe("document numbering", () => {
  it("issues sequential numbers within a period", async () => {
    const a = await db.$transaction((tx) => nextDocumentNumber(tx, "TESTSEQ", openDate));
    const b = await db.$transaction((tx) => nextDocumentNumber(tx, "TESTSEQ", openDate));
    const seqA = Number(a.split("-").pop());
    const seqB = Number(b.split("-").pop());
    expect(seqB).toBe(seqA + 1);
  });

  it("never issues a duplicate under concurrent transactions", async () => {
    // The real reason for UPDATE … RETURNING instead of counting rows: twenty
    // simultaneous postings must produce twenty distinct numbers.
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        db.$transaction((tx) => nextDocumentNumber(tx, "CONCUR", openDate)),
      ),
    );
    expect(new Set(results).size).toBe(20);
  });

  it("keeps separate counters per document type", async () => {
    const je = await db.$transaction((tx) => nextDocumentNumber(tx, "TYPEA", openDate));
    const po = await db.$transaction((tx) => nextDocumentNumber(tx, "TYPEB", openDate));
    expect(je.split("-").pop()).toBe("0001");
    expect(po.split("-").pop()).toBe("0001");
  });
});

describe("reverseEntry", () => {
  it("posts a mirror image and leaves the original untouched", async () => {
    const original = await db.$transaction((tx) =>
      postEntry(tx, {
        entityId: factoryId, postingDate: openDate, sourceType: "EXPENSE",
        memo: "Rent booked to the wrong supplier", lines: rentLines("2500"), ctx,
      }),
    );

    const reversal = await db.$transaction((tx) =>
      reverseEntry(tx, {
        entryId: original.id, postingDate: openDate,
        reason: "Posted against the wrong supplier", ctx,
      }),
    );

    const originalAfter = await db.journalEntry.findUniqueOrThrow({
      where: { id: original.id }, include: { lines: true, reversedBy: true },
    });
    const reversalAfter = await db.journalEntry.findUniqueOrThrow({
      where: { id: reversal.id }, include: { lines: true },
    });

    expect(originalAfter.memo).toBe("Rent booked to the wrong supplier");
    expect(originalAfter.reversedBy?.id).toBe(reversal.id);

    // Debits and credits swapped, dimensions preserved.
    const origDebitLine = originalAfter.lines.find((l) => l.debit.toString() === "2500");
    const revCreditLine = reversalAfter.lines.find((l) => l.credit.toString() === "2500");
    expect(origDebitLine?.accountId).toBe(revCreditLine?.accountId);

    // The pair nets to zero, which is what makes the correction honest.
    const all = [...originalAfter.lines, ...reversalAfter.lines];
    const netDebit = all.reduce((s, l) => s + Number(l.debit), 0);
    const netCredit = all.reduce((s, l) => s + Number(l.credit), 0);
    expect(netDebit).toBe(netCredit);
  });

  it("refuses to reverse the same entry twice", async () => {
    const original = await db.$transaction((tx) =>
      postEntry(tx, {
        entityId: factoryId, postingDate: openDate, sourceType: "EXPENSE",
        lines: rentLines("300"), ctx,
      }),
    );
    await db.$transaction((tx) =>
      reverseEntry(tx, { entryId: original.id, postingDate: openDate, reason: "first", ctx }),
    );

    await expect(
      db.$transaction((tx) =>
        reverseEntry(tx, { entryId: original.id, postingDate: openDate, reason: "second", ctx }),
      ),
    ).rejects.toThrow(/already reversed/i);
  });

  it("requires a reason", async () => {
    const original = await db.$transaction((tx) =>
      postEntry(tx, {
        entityId: factoryId, postingDate: openDate, sourceType: "EXPENSE",
        lines: rentLines("400"), ctx,
      }),
    );

    await expect(
      db.$transaction((tx) =>
        reverseEntry(tx, { entryId: original.id, postingDate: openDate, reason: "   ", ctx }),
      ),
    ).rejects.toThrow(/needs a reason/i);
  });

  it("refuses to reverse a draft", async () => {
    const draft = await db.$transaction((tx) =>
      postEntry(tx, {
        entityId: factoryId, postingDate: openDate, sourceType: "MANUAL",
        lines: rentLines("500"), ctx, status: "DRAFT",
      }),
    );

    await expect(
      db.$transaction((tx) =>
        reverseEntry(tx, { entryId: draft.id, postingDate: openDate, reason: "nope", ctx }),
      ),
    ).rejects.toThrow(/Only a posted entry can be reversed/i);
  });
});

describe("trial balance", () => {
  it("balances across every posted entry", async () => {
    // The single check that proves the ledger as a whole is sound.
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
