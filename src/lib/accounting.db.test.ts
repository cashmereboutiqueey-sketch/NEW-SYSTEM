import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

/**
 * The accounting invariants, verified against a real PostgreSQL database.
 *
 * These rules are enforced by triggers in the `accounting_core` migration, so
 * they must hold even when the write bypasses every line of application code —
 * which is exactly what these tests do. They talk to Prisma directly, with no
 * service layer in between.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let factoryId: string;
let openPeriodId: string;
let closedPeriodId: string;
let debitAccountId: string;
let creditAccountId: string;
let parentAccountId: string;

const TEST_PREFIX = "ledgertest";
let seq = 0;
const nextRef = () => `${TEST_PREFIX}-${Date.now()}-${seq++}`;

beforeAll(async () => {
  const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });
  factoryId = factory.id;

  const open = await db.fiscalPeriod.findFirstOrThrow({ where: { status: "OPEN" } });
  openPeriodId = open.id;

  const closed = await db.fiscalPeriod.findFirstOrThrow({ where: { status: "CLOSED" } });
  closedPeriodId = closed.id;

  // Real accounts from the seeded chart, so the tests exercise the shipped
  // chart of accounts rather than fixtures invented for the test.
  debitAccountId = (await db.account.findUniqueOrThrow({ where: { code: "6120" } })).id; // Factory rent
  creditAccountId = (await db.account.findUniqueOrThrow({ where: { code: "2110" } })).id; // Trade payables
  parentAccountId = (await db.account.findUniqueOrThrow({ where: { code: "6100" } })).id; // rollup parent
});

afterAll(async () => {
  // Posted entries cannot be deleted — that is the point of the immutability
  // trigger, and it blocks this cleanup too. Suspending the trigger for the
  // teardown is the only way to remove test rows, and having to do so
  // explicitly is itself evidence the guard is real. Nothing outside a test
  // teardown may ever do this.
  await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
  await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
  try {
    await db.journalLine.deleteMany({
      where: { journalEntry: { entryNumber: { startsWith: TEST_PREFIX } } },
    });
    await db.journalEntry.deleteMany({ where: { entryNumber: { startsWith: TEST_PREFIX } } });
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
  }
  await db.$disconnect();
});

/** Writes an entry and its lines in one transaction, as a caller would. */
async function postEntry(opts: {
  status: "DRAFT" | "PENDING_REVIEW" | "POSTED";
  fiscalPeriodId?: string;
  lines: { accountId: string; debit?: string; credit?: string }[];
}) {
  const entryNumber = nextRef();
  return db.$transaction(async (tx) => {
    const entry = await tx.journalEntry.create({
      data: {
        entryNumber,
        entityId: factoryId,
        fiscalPeriodId: opts.fiscalPeriodId ?? openPeriodId,
        status: opts.status,
        postingDate: new Date(),
      },
    });
    for (const [i, l] of opts.lines.entries()) {
      await tx.journalLine.create({
        data: {
          journalEntryId: entry.id,
          lineNumber: i + 1,
          accountId: l.accountId,
          debit: l.debit ?? "0",
          credit: l.credit ?? "0",
          entityId: factoryId,
        },
      });
    }
    return entry;
  });
}

describe("debit = credit", () => {
  it("accepts a balanced posted entry", async () => {
    const entry = await postEntry({
      status: "POSTED",
      lines: [
        { accountId: debitAccountId, debit: "55000" },
        { accountId: creditAccountId, credit: "55000" },
      ],
    });

    const lines = await db.journalLine.findMany({ where: { journalEntryId: entry.id } });
    expect(lines).toHaveLength(2);
  });

  it("rejects an unbalanced posted entry at commit time", async () => {
    await expect(
      postEntry({
        status: "POSTED",
        lines: [
          { accountId: debitAccountId, debit: "100" },
          { accountId: creditAccountId, credit: "60" },
        ],
      }),
    ).rejects.toThrow(/does not balance/i);
  });

  it("rejects a one-piastre imbalance", async () => {
    await expect(
      postEntry({
        status: "POSTED",
        lines: [
          { accountId: debitAccountId, debit: "100.0001" },
          { accountId: creditAccountId, credit: "100" },
        ],
      }),
    ).rejects.toThrow(/does not balance/i);
  });

  it("allows a draft to be unbalanced while it is still being worked on", async () => {
    const entry = await postEntry({
      status: "DRAFT",
      lines: [{ accountId: debitAccountId, debit: "77" }],
    });
    expect(entry.status).toBe("DRAFT");
  });

  it("rejects promoting an unbalanced draft to posted", async () => {
    const entry = await postEntry({
      status: "DRAFT",
      lines: [
        { accountId: debitAccountId, debit: "100" },
        { accountId: creditAccountId, credit: "40" },
      ],
    });

    await expect(
      db.journalEntry.update({ where: { id: entry.id }, data: { status: "POSTED" } }),
    ).rejects.toThrow(/does not balance/i);
  });

  it("rejects a line carrying both a debit and a credit", async () => {
    await expect(
      postEntry({
        status: "DRAFT",
        lines: [{ accountId: debitAccountId, debit: "50", credit: "50" }],
      }),
    ).rejects.toThrow(/debit_xor_credit/i);
  });

  it("rejects a negative amount", async () => {
    await expect(
      postEntry({
        status: "DRAFT",
        lines: [{ accountId: debitAccountId, debit: "-100" }],
      }),
    ).rejects.toThrow(/debit_xor_credit/i);
  });
});

describe("posted entries are immutable", () => {
  it("refuses to modify a posted entry", async () => {
    const entry = await postEntry({
      status: "POSTED",
      lines: [
        { accountId: debitAccountId, debit: "1000" },
        { accountId: creditAccountId, credit: "1000" },
      ],
    });

    await expect(
      db.journalEntry.update({ where: { id: entry.id }, data: { memo: "tampered" } }),
    ).rejects.toThrow(/POSTED and cannot be modified/i);
  });

  it("refuses to modify the lines of a posted entry", async () => {
    const entry = await postEntry({
      status: "POSTED",
      lines: [
        { accountId: debitAccountId, debit: "1000" },
        { accountId: creditAccountId, credit: "1000" },
      ],
    });
    const line = await db.journalLine.findFirstOrThrow({
      where: { journalEntryId: entry.id, lineNumber: 1 },
    });

    await expect(
      db.journalLine.update({ where: { id: line.id }, data: { debit: "999999" } }),
    ).rejects.toThrow(/POSTED; its lines cannot be modified/i);
  });

  it("refuses to delete a posted entry", async () => {
    const entry = await postEntry({
      status: "POSTED",
      lines: [
        { accountId: debitAccountId, debit: "1000" },
        { accountId: creditAccountId, credit: "1000" },
      ],
    });

    await expect(db.journalEntry.delete({ where: { id: entry.id } })).rejects.toThrow(
      /POSTED and cannot be deleted/i,
    );
  });

  it("allows a draft to be edited and deleted", async () => {
    const entry = await postEntry({
      status: "DRAFT",
      lines: [
        { accountId: debitAccountId, debit: "10" },
        { accountId: creditAccountId, credit: "10" },
      ],
    });

    await db.journalEntry.update({ where: { id: entry.id }, data: { memo: "revised" } });
    await db.journalLine.deleteMany({ where: { journalEntryId: entry.id } });
    await db.journalEntry.delete({ where: { id: entry.id } });

    expect(await db.journalEntry.findUnique({ where: { id: entry.id } })).toBeNull();
  });

  it("corrects a posted entry through a linked reversal, leaving the original intact", async () => {
    const original = await postEntry({
      status: "POSTED",
      lines: [
        { accountId: debitAccountId, debit: "2500" },
        { accountId: creditAccountId, credit: "2500" },
      ],
    });

    const reversal = await db.$transaction(async (tx) => {
      const entry = await tx.journalEntry.create({
        data: {
          entryNumber: nextRef(),
          entityId: factoryId,
          fiscalPeriodId: openPeriodId,
          status: "POSTED",
          postingDate: new Date(),
          reversesEntryId: original.id,
          reversalReason: "Posted against the wrong supplier",
        },
      });
      // Sides swapped relative to the original.
      await tx.journalLine.create({
        data: {
          journalEntryId: entry.id, lineNumber: 1, accountId: debitAccountId,
          debit: "0", credit: "2500", entityId: factoryId,
        },
      });
      await tx.journalLine.create({
        data: {
          journalEntryId: entry.id, lineNumber: 2, accountId: creditAccountId,
          debit: "2500", credit: "0", entityId: factoryId,
        },
      });
      return entry;
    });

    const originalAfter = await db.journalEntry.findUniqueOrThrow({
      where: { id: original.id },
      include: { reversedBy: true },
    });

    expect(originalAfter.status).toBe("POSTED");
    expect(originalAfter.memo).toBeNull();
    expect(originalAfter.reversedBy?.id).toBe(reversal.id);
    expect(reversal.reversalReason).toMatch(/wrong supplier/);
  });
});

describe("period lock", () => {
  it("refuses to post into a closed period", async () => {
    await expect(
      postEntry({
        status: "POSTED",
        fiscalPeriodId: closedPeriodId,
        lines: [
          { accountId: debitAccountId, debit: "500" },
          { accountId: creditAccountId, credit: "500" },
        ],
      }),
    ).rejects.toThrow(/CLOSED/i);
  });

  it("allows a draft in a closed period, since a draft is not accounting history", async () => {
    const entry = await postEntry({
      status: "DRAFT",
      fiscalPeriodId: closedPeriodId,
      lines: [
        { accountId: debitAccountId, debit: "500" },
        { accountId: creditAccountId, credit: "500" },
      ],
    });
    expect(entry.status).toBe("DRAFT");
  });
});

describe("account restrictions", () => {
  it("refuses to post to a rollup parent account", async () => {
    await expect(
      postEntry({
        status: "DRAFT",
        lines: [{ accountId: parentAccountId, debit: "100" }],
      }),
    ).rejects.toThrow(/rollup parent/i);
  });
});

describe("seeded chart of accounts", () => {
  it("keeps factory overhead out of the brand fixed-cost pool", async () => {
    // The specs warn repeatedly that factory overhead is already absorbed into
    // transfer price; counting it again in the brand pool double-charges it.
    const doubleCounted = await db.account.findMany({
      where: { includeInMinuteRate: true, includeInBrandFixedPool: true },
    });
    expect(doubleCounted).toEqual([]);
  });

  it("marks only factory-scoped accounts as part of the minute-rate pool", async () => {
    const pool = await db.account.findMany({ where: { includeInMinuteRate: true } });
    expect(pool.length).toBeGreaterThan(0);
    expect(pool.every((a) => a.scope === "FACTORY")).toBe(true);
  });

  it("excludes materials and finance costs from the minute-rate pool", async () => {
    // Fabric enters style cost directly; including it here would count it twice.
    const materials = await db.account.findUniqueOrThrow({ where: { code: "5100" } });
    const finance = await db.account.findUniqueOrThrow({ where: { code: "7510" } });
    expect(materials.includeInMinuteRate).toBe(false);
    expect(finance.includeInMinuteRate).toBe(false);
  });

  it("classifies owner drawings as equity, never as an expense", async () => {
    const drawings = await db.account.findUniqueOrThrow({ where: { code: "3200" } });
    expect(drawings.type).toBe("EQUITY");
    expect(drawings.includeInMinuteRate).toBe(false);
    expect(drawings.includeInBrandFixedPool).toBe(false);
  });

  it("pairs every intercompany account so group elimination has both sides", async () => {
    const intercompany = await db.account.findMany({ where: { isIntercompany: true } });
    const codes = intercompany.map((a) => a.code).sort();
    // Factory receivable/revenue and the matching Brand payable/COGS.
    expect(codes).toEqual(["1250", "2150", "4400", "5300"]);
  });

  it("gives every account a normal balance consistent with its type", async () => {
    const accounts = await db.account.findMany();
    const expected: Record<string, "DEBIT" | "CREDIT"> = {
      ASSET: "DEBIT",
      LIABILITY: "CREDIT",
      EQUITY: "CREDIT",
      REVENUE: "CREDIT",
      COGS: "DEBIT",
      EXPENSE: "DEBIT",
      OTHER_INCOME: "CREDIT",
      OTHER_EXPENSE: "DEBIT",
    };
    // Contra accounts intentionally invert their class's normal balance.
    const contraCodes = new Set(["1590", "3200", "4200", "4210"]);

    const mismatched = accounts.filter(
      (a) => !contraCodes.has(a.code) && a.normalBalance !== expected[a.type],
    );
    expect(mismatched.map((a) => `${a.code} ${a.nameEn}`)).toEqual([]);
  });
});
