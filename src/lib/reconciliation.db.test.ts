import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { receiveFinishedGoods } from "./inventory";
import { createSale } from "./sales";
import {
  awaitingSettlement,
  clearingBalance,
  recordSettlement,
  importStatement,
  reconciliationView,
  matchLine,
  explainLine,
} from "./reconciliation";
import { dec } from "./money";

/**
 * Reconciliation exists to catch the money that is real but not where the
 * books say it is. These tests hold both halves honest: the clearing account
 * must equal what couriers actually owe, and the statement must surface what
 * is on one side and not the other.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let brandId: string;
let showroomId: string;
let variantId: string;
let channelId: string;
let day: Date;

const ctx = { userId: null as string | null, reason: null };

beforeAll(async () => {
  brandId = (await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } })).id;
  showroomId = (await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } })).id;
  variantId = (await db.variant.findFirstOrThrow()).id;
  channelId = (await db.salesChannel.findFirstOrThrow()).id;

  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" }, orderBy: { startDate: "asc" },
  });
  day = new Date(period.startDate);
});

async function wipe() {
  await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
  await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
  try {
    await db.settlementLine.deleteMany({});
    await db.settlement.deleteMany({});
    await db.bankStatementLine.deleteMany({});
    await db.bankStatement.deleteMany({});
    await db.garmentUnit.deleteMany({});
    await db.salesPayment.deleteMany({});
    await db.salesOrderLine.deleteMany({});
    await db.salesOrder.deleteMany({});
    await db.inventoryMovement.deleteMany({});
    await db.inventoryLot.deleteMany({});
    await db.journalLine.deleteMany({});
    await db.journalEntry.deleteMany({});
    await db.auditLog.deleteMany({});
    await db.documentSequence.deleteMany({});
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
  }
}

beforeEach(wipe);
afterAll(async () => { await wipe(); await db.$disconnect(); });

/** Stock on the shelf, ready to be sold. */
async function givenStock(quantity: number) {
  await receiveFinishedGoods(
    {
      variantId, locationId: showroomId, entityId: brandId,
      quantity: String(quantity), unitCost: "500", materialUnitCost: "400",
      receivedDate: day,
    },
    ctx,
  );
}

/** A sale paid on delivery: the courier holds the money. */
async function codSale(price: number, fee = 0) {
  return createSale(
    {
      source: "SHOPIFY", channelId, entityId: brandId, locationId: showroomId,
      orderDate: day,
      lines: [{ variantId, quantity: 1, retailPrice: price, discountPct: 0 }],
      payments: [{ method: "COD", amount: price, fee, collected: false }],
    },
    ctx,
  );
}

async function accountBalance(code: string): Promise<number> {
  const [row] = await db.$queryRaw<{ balance: string }[]>`
    SELECT COALESCE(SUM(l."debit") - SUM(l."credit"), 0)::text AS balance
    FROM "journal_lines" l
    JOIN "journal_entries" e ON e."id" = l."journalEntryId"
    JOIN "accounts" a ON a."id" = l."accountId"
    WHERE a."code" = ${code} AND e."status" = 'POSTED'
  `;
  return Number(row.balance);
}

async function ledgerBalances(): Promise<boolean> {
  const [row] = await db.$queryRaw<{ d: string; c: string }[]>`
    SELECT COALESCE(SUM(l."debit"),0)::text AS d, COALESCE(SUM(l."credit"),0)::text AS c
    FROM "journal_lines" l JOIN "journal_entries" e ON e."id" = l."journalEntryId"
    WHERE e."status" = 'POSTED'
  `;
  return row.d === row.c;
}

describe("what the courier owes", () => {
  it("matches the clearing account to the piastre", async () => {
    await givenStock(5);
    await codSale(1000, 30);
    await codSale(1500, 45);

    const outstanding = await awaitingSettlement("COURIER");
    const expected = outstanding.reduce((s, p) => s.plus(p.expected), dec(0));
    const clearing = await clearingBalance("COURIER", brandId);

    // The whole reconciliation rests on these two agreeing. If they drift, the
    // screen is reporting a debt that does not exist.
    expect(Number(expected)).toBeCloseTo(Number(clearing), 2);
    // Net of the fees, which were posted when the sale was.
    expect(Number(expected)).toBeCloseTo(1000 - 30 + 1500 - 45, 2);
  });

  it("does not park money in clearing that was collected on the spot", async () => {
    await givenStock(2);
    await createSale(
      {
        source: "MANUAL", channelId, entityId: brandId, locationId: showroomId,
        orderDate: day,
        lines: [{ variantId, quantity: 1, retailPrice: 800, discountPct: 0 }],
        payments: [{ method: "CARD", amount: 800, fee: 0, collected: true }],
      },
      ctx,
    );

    // A card taken at the till and marked collected has reached the bank.
    // Sending it to a clearing account would leave it stranded there, with
    // nothing that could ever clear it.
    expect(await accountBalance("1130")).toBeCloseTo(0, 2);
    expect(await accountBalance("1120")).toBeCloseTo(800, 2);
    expect(await awaitingSettlement("PAYMENT_GATEWAY")).toHaveLength(0);
  });

  it("counts how long they have been holding it", async () => {
    await givenStock(2);
    await codSale(1000);

    const [row] = await awaitingSettlement("COURIER");
    expect(row.daysOutstanding).toBeGreaterThanOrEqual(0);
    expect(row.orderNumber).toMatch(/^SO-/);
  });
});

describe("recording a remittance", () => {
  it("clears the account and puts the money in the bank", async () => {
    await givenStock(5);
    await codSale(1000, 30);
    const outstanding = await awaitingSettlement("COURIER");

    const result = await recordSettlement(
      {
        provider: "COURIER", entityId: brandId, settlementDate: day,
        netReceived: outstanding[0].expected.toString(),
        paymentIds: [outstanding[0].paymentId],
        reference: "BATCH-1",
      },
      ctx,
    );

    expect(result.variance).toBe("0");
    expect(result.cleared).toBe(1);
    expect(await accountBalance("1135")).toBeCloseTo(0, 2);
    expect(await accountBalance("1120")).toBeCloseTo(970, 2);
    expect(await ledgerBalances()).toBe(true);
  });

  it("marks the payments collected", async () => {
    await givenStock(3);
    await codSale(1000);
    const outstanding = await awaitingSettlement("COURIER");

    await recordSettlement(
      {
        provider: "COURIER", entityId: brandId, settlementDate: day,
        netReceived: "1000", paymentIds: [outstanding[0].paymentId],
      },
      ctx,
    );

    expect(await awaitingSettlement("COURIER")).toHaveLength(0);
    const payment = await db.salesPayment.findFirstOrThrow();
    expect(payment.status).toBe("COLLECTED");
  });

  it("refuses to clear the same payment twice", async () => {
    await givenStock(3);
    await codSale(1000);
    const outstanding = await awaitingSettlement("COURIER");

    await recordSettlement(
      {
        provider: "COURIER", entityId: brandId, settlementDate: day,
        netReceived: "1000", paymentIds: [outstanding[0].paymentId],
      },
      ctx,
    );

    // The same batch pasted in twice would credit the bank for money that
    // only ever arrived once.
    await expect(
      recordSettlement(
        {
          provider: "COURIER", entityId: brandId, settlementDate: day,
          netReceived: "1000", paymentIds: [outstanding[0].paymentId],
        },
        ctx,
      ),
    ).rejects.toThrow(/already settled/i);
  });

  it("refuses an unexplained shortfall", async () => {
    await givenStock(3);
    await codSale(1000);
    const outstanding = await awaitingSettlement("COURIER");

    await expect(
      recordSettlement(
        {
          provider: "COURIER", entityId: brandId, settlementDate: day,
          netReceived: "600", paymentIds: [outstanding[0].paymentId],
        },
        ctx,
      ),
    ).rejects.toThrow(/short of/i);
  });

  it("charges an explained shortfall to fees and stays balanced", async () => {
    await givenStock(3);
    await codSale(1000);
    const outstanding = await awaitingSettlement("COURIER");

    const result = await recordSettlement(
      {
        provider: "COURIER", entityId: brandId, settlementDate: day,
        netReceived: "940", paymentIds: [outstanding[0].paymentId],
        varianceNote: "extra handling charge",
      },
      ctx,
    );

    expect(Number(result.variance)).toBeCloseTo(-60, 2);
    expect(await accountBalance("6230")).toBeCloseTo(60, 2);
    expect(await accountBalance("1135")).toBeCloseTo(0, 2);
    expect(await ledgerBalances()).toBe(true);
  });

  it("leaves an unticked order outstanding rather than absorbing it", async () => {
    await givenStock(5);
    await codSale(1000);
    await codSale(700);
    const outstanding = await awaitingSettlement("COURIER");

    // The courier paid for one parcel and not the other. Settling only the one
    // they paid for keeps the other visible instead of hiding it in a variance.
    await recordSettlement(
      {
        provider: "COURIER", entityId: brandId, settlementDate: day,
        netReceived: outstanding[0].expected.toString(),
        paymentIds: [outstanding[0].paymentId],
      },
      ctx,
    );

    const left = await awaitingSettlement("COURIER");
    expect(left).toHaveLength(1);
    expect(Number(await clearingBalance("COURIER", brandId))).toBeCloseTo(
      Number(left[0].expected),
      2,
    );
  });

  it("refuses an empty remittance", async () => {
    await expect(
      recordSettlement(
        {
          provider: "COURIER", entityId: brandId, settlementDate: day,
          netReceived: "500", paymentIds: [],
        },
        ctx,
      ),
    ).rejects.toThrow(/Tick the orders/i);
  });
});

describe("the bank statement", () => {
  it("matches a line that has exactly one counterpart", async () => {
    await givenStock(3);
    await codSale(1000);
    const outstanding = await awaitingSettlement("COURIER");
    await recordSettlement(
      {
        provider: "COURIER", entityId: brandId, settlementDate: day,
        netReceived: "1000", paymentIds: [outstanding[0].paymentId],
      },
      ctx,
    );

    const result = await importStatement(
      {
        accountCode: "1120", entityId: brandId, statementDate: day,
        openingBalance: "0", closingBalance: "1000",
        lines: [
          { valueDate: day, description: "Courier transfer", reference: null, amount: "1000" },
        ],
      },
      ctx,
    );

    expect(result.imported).toBe(1);
    expect(result.matched).toBe(1);
  });

  it("leaves an ambiguous line alone rather than guessing", async () => {
    await givenStock(5);
    // Two identical payments in the same week: precisely where an automatic
    // match goes wrong quietly.
    await codSale(1000);
    await codSale(1000);
    const outstanding = await awaitingSettlement("COURIER");
    for (const p of outstanding) {
      await recordSettlement(
        {
          provider: "COURIER", entityId: brandId, settlementDate: day,
          netReceived: "1000", paymentIds: [p.paymentId],
        },
        ctx,
      );
    }

    const result = await importStatement(
      {
        accountCode: "1120", entityId: brandId, statementDate: day,
        openingBalance: "0", closingBalance: "1000",
        lines: [{ valueDate: day, description: "A transfer", reference: null, amount: "1000" }],
      },
      ctx,
    );

    expect(result.matched).toBe(0);
  });

  it("shows a bank charge nobody recorded", async () => {
    const result = await importStatement(
      {
        accountCode: "1120", entityId: brandId, statementDate: day,
        openingBalance: "0", closingBalance: "-250",
        lines: [{ valueDate: day, description: "Bank charges", reference: null, amount: "-250" }],
      },
      ctx,
    );

    const view = await reconciliationView(result.statementId);
    expect(view!.unmatchedCount).toBe(1);
    expect(view!.lines[0].status).toBe("UNMATCHED");
  });

  it("keeps an explained line apart from a matched one", async () => {
    const result = await importStatement(
      {
        accountCode: "1120", entityId: brandId, statementDate: day,
        openingBalance: "0", closingBalance: "-250",
        lines: [{ valueDate: day, description: "Bank charges", reference: null, amount: "-250" }],
      },
      ctx,
    );
    const view = await reconciliationView(result.statementId);

    await explainLine(
      { bankStatementLineId: view!.lines[0].id, note: "monthly account fee" },
      ctx,
    );

    const after = await reconciliationView(result.statementId);
    // Explained is not matched: it still needs entering as an expense, so it
    // stays distinguishable rather than disappearing into the matched pile.
    expect(after!.lines[0].status).toBe("EXPLAINED");
    expect(after!.unmatchedCount).toBe(0);
  });

  it("refuses to explain a line with nothing said", async () => {
    const result = await importStatement(
      {
        accountCode: "1120", entityId: brandId, statementDate: day,
        openingBalance: "0", closingBalance: "-250",
        lines: [{ valueDate: day, description: "Bank charges", reference: null, amount: "-250" }],
      },
      ctx,
    );
    const view = await reconciliationView(result.statementId);

    await expect(
      explainLine({ bankStatementLineId: view!.lines[0].id, note: "   " }, ctx),
    ).rejects.toThrow(/Say what the line is/i);
  });

  it("refuses a hand match where the amounts disagree", async () => {
    await givenStock(3);
    await codSale(1000);
    const outstanding = await awaitingSettlement("COURIER");
    await recordSettlement(
      {
        provider: "COURIER", entityId: brandId, settlementDate: day,
        netReceived: "1000", paymentIds: [outstanding[0].paymentId],
      },
      ctx,
    );

    const result = await importStatement(
      {
        accountCode: "1120", entityId: brandId, statementDate: day,
        openingBalance: "0", closingBalance: "900",
        lines: [{ valueDate: day, description: "Part transfer", reference: null, amount: "900" }],
      },
      ctx,
    );
    const view = await reconciliationView(result.statementId);
    const candidate = view!.inBooksNotOnStatement[0];

    await expect(
      matchLine(
        { bankStatementLineId: view!.lines[0].id, journalLineId: candidate.id },
        ctx,
      ),
    ).rejects.toThrow(/do not agree/i);
  });

  it("notices a statement whose own arithmetic is wrong", async () => {
    const result = await importStatement(
      {
        accountCode: "1120", entityId: brandId, statementDate: day,
        // 0 + 500 is not 900. Matching a statement entered wrong means nothing.
        openingBalance: "0", closingBalance: "900",
        lines: [{ valueDate: day, description: "A transfer", reference: null, amount: "500" }],
      },
      ctx,
    );

    const view = await reconciliationView(result.statementId);
    expect(view!.statementConsistent).toBe(false);
  });

  it("accepts a statement that adds up", async () => {
    const result = await importStatement(
      {
        accountCode: "1120", entityId: brandId, statementDate: day,
        openingBalance: "100", closingBalance: "600",
        lines: [{ valueDate: day, description: "A transfer", reference: null, amount: "500" }],
      },
      ctx,
    );

    const view = await reconciliationView(result.statementId);
    expect(view!.statementConsistent).toBe(true);
  });

  it("refuses a statement with no lines", async () => {
    await expect(
      importStatement(
        {
          accountCode: "1120", entityId: brandId, statementDate: day,
          openingBalance: "0", closingBalance: "0", lines: [],
        },
        ctx,
      ),
    ).rejects.toThrow(/nothing to reconcile/i);
  });
});
