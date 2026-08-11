/**
 * The books against themselves.
 *
 * Two questions. Does the general ledger agree with the records it is supposed
 * to summarise — stock, sales, payables? And do the rules that protect it hold
 * when pushed: a closed period, a FIFO consumption, a reversal that must be a
 * reversal rather than an edit.
 *
 * A difference here is not a rounding matter. It means one of the two is
 * wrong and nothing in the application knows which.
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { dec } from "../src/lib/money";
import { postEntry } from "../src/lib/ledger";
import { createExpense } from "../src/lib/expenses";

const problems: string[] = [];
const ok = (m: string) => console.log(`   ✓ ${m}`);
const bad = (m: string) => { problems.push(m); console.log(`   ✗ ${m}`); };

const owner = await db.user.findFirstOrThrow({ where: { email: "owner@cashmere.eg" } });
const ctx = { userId: owner.id, reason: null };

async function balanceOf(code: string, entityId?: string) {
  const rows = await db.$queryRaw<{ b: string }[]>`
    SELECT COALESCE(SUM(l."debit") - SUM(l."credit"), 0)::text AS b
    FROM "journal_lines" l
    JOIN "journal_entries" e ON e."id" = l."journalEntryId"
    JOIN "accounts" a ON a."id" = l."accountId"
    WHERE a."code" = ${code} AND e."status" = 'POSTED'
      AND (${entityId ?? null}::text IS NULL OR l."entityId" = ${entityId ?? null})`;
  return dec(rows[0]?.b ?? 0);
}

/* ───────────────── 1. the ledger agrees with what it summarises ────────── */

console.log("── general ledger against the subledgers");

// Stock: the inventory accounts must equal the lots that are actually there.
const lots = await db.inventoryLot.findMany({
  where: { remainingQty: { gt: 0 } },
  include: { entity: true },
});

const stockByAccount = new Map<string, ReturnType<typeof dec>>();
for (const lot of lots) {
  const isBrand = lot.entity?.kind === "BRAND";
  const code =
    lot.state === "RAW_MATERIAL" ? "1310"
    : lot.state === "WIP" ? "1320"
    : isBrand ? "1340" : "1330";
  const value = dec(lot.remainingQty).times(dec(lot.unitCost));
  stockByAccount.set(code, (stockByAccount.get(code) ?? dec(0)).plus(value));
}

for (const code of ["1310", "1320", "1330", "1340"]) {
  const ledger = await balanceOf(code);
  const subledger = stockByAccount.get(code) ?? dec(0);
  const gap = ledger.minus(subledger).abs();
  // A piastre of rounding across hundreds of lots is tolerable; anything more
  // means the two have genuinely diverged.
  if (gap.greaterThan(0.05)) {
    bad(`account ${code}: ledger ${ledger.toFixed(2)} vs lots ${subledger.toFixed(2)} (out by ${gap.toFixed(2)})`);
  } else {
    ok(`account ${code} matches the lots: ${ledger.toFixed(2)}`);
  }
}

// Payables: the account carries two different debts. Expenses put one there,
// and so do goods receipts — a delivery of cloth is owed to the supplier
// without ever being an expense, because the value went into stock.
const openExpenses = await db.expense.findMany({
  where: { status: { in: ["UNPAID", "PARTIALLY_PAID"] } },
});
const owedOnExpenses = openExpenses.reduce(
  (s, e) => s.plus(dec(e.amount).minus(dec(e.paidAmount))),
  dec(0),
);

const receiptRows = await db.$queryRaw<{ b: string }[]>`
  SELECT COALESCE(SUM(l."credit") - SUM(l."debit"), 0)::text AS b
  FROM "journal_lines" l
  JOIN "journal_entries" e ON e."id" = l."journalEntryId"
  JOIN "accounts" a ON a."id" = l."accountId"
  WHERE a."code" = '2110' AND e."status" = 'POSTED'
    AND e."sourceType" = 'GOODS_RECEIPT'`;
const owedOnDeliveries = dec(receiptRows[0]?.b ?? 0);

const payablesLedger = (await balanceOf("2110")).negated();
const owed = owedOnExpenses.plus(owedOnDeliveries);
if (payablesLedger.minus(owed).abs().greaterThan(0.05)) {
  bad(
    `payables: ledger ${payablesLedger.toFixed(2)} vs ${owedOnExpenses.toFixed(2)} of expenses ` +
      `plus ${owedOnDeliveries.toFixed(2)} of deliveries = ${owed.toFixed(2)}`,
  );
} else {
  ok(`payables match: ${owedOnExpenses.toFixed(2)} expenses + ${owedOnDeliveries.toFixed(2)} deliveries`);
}

// Cost of sales: what the order lines relieved, less what came back.
//
// A return relieves cost of sales for a sale that was undone, so comparing
// against the order lines alone reports a difference the size of every return
// ever taken. The lines are the record of what was sold; they are not amended
// when a garment comes back, and should not be.
const soldCost = (await db.salesOrderLine.findMany({ select: { lineCost: true } })).reduce(
  (s, l) => s.plus(dec(l.lineCost)),
  dec(0),
);

const returned = await db.return.findMany({
  select: { salesOrderId: true, variantId: true, quantity: true },
});
let returnedCost = dec(0);
for (const r of returned) {
  // The cost the garment left at, frozen on the line that sold it — which is
  // exactly what the return credited.
  const line = await db.salesOrderLine.findFirst({
    where: { salesOrderId: r.salesOrderId, variantId: r.variantId },
    select: { unitCost: true },
  });
  if (line) returnedCost = returnedCost.plus(dec(line.unitCost).times(r.quantity));
}

const netSoldCost = soldCost.minus(returnedCost);
const cogsLedger = await balanceOf("5300");
if (cogsLedger.minus(netSoldCost).abs().greaterThan(0.05)) {
  bad(
    `brand COGS: ledger ${cogsLedger.toFixed(2)} vs order lines less returns ${netSoldCost.toFixed(2)}`,
  );
} else {
  ok(
    returnedCost.greaterThan(0)
      ? `brand COGS matches the order lines less ${returnedCost.toFixed(2)} returned: ${cogsLedger.toFixed(2)}`
      : `brand COGS matches the order lines: ${cogsLedger.toFixed(2)}`,
  );
}

// Clearing: what couriers and gateways owe must equal the pending payments.
const pending = await db.salesPayment.findMany({
  where: { status: "PENDING" },
});
const cod = pending.filter((p) => p.method === "COD")
  .reduce((s, p) => s.plus(dec(p.amount).minus(dec(p.fee))), dec(0));
const gateway = pending.filter((p) => p.method === "CARD" || p.method === "WALLET")
  .reduce((s, p) => s.plus(dec(p.amount).minus(dec(p.fee))), dec(0));

for (const [code, expected, what] of [["1135", cod, "couriers"], ["1130", gateway, "gateways"]] as const) {
  const ledger = await balanceOf(code);
  if (ledger.minus(expected).abs().greaterThan(0.05)) {
    bad(`${what}: ledger ${ledger.toFixed(2)} vs outstanding payments ${expected.toFixed(2)}`);
  } else ok(`what ${what} owe matches the ledger: ${ledger.toFixed(2)}`);
}

// Customers: account 1210 must equal what the orders say is still owed.
//
// This check exists because it was missing when credit was built, and the
// first thing written against it — a refund set against a customer's balance
// — credited the ledger without settling the order. The two views disagreed
// and nothing noticed. A balance derived one way and posted another has to be
// reconciled, or the derivation is decoration.
const customerOrders = await db.salesOrder.findMany({
  where: { status: { not: "CANCELLED" } },
  select: {
    netAmount: true,
    shippingAmount: true,
    payments: { select: { amount: true } },
  },
});
const owedByCustomers = customerOrders.reduce((total, o) => {
  const due = dec(o.netAmount).plus(dec(o.shippingAmount));
  const paid = o.payments.reduce((s, p) => s.plus(dec(p.amount)), dec(0));
  const owed = due.minus(paid);
  // Overpaid orders are somebody else's problem; they do not net against
  // what other customers owe.
  return owed.greaterThan(0) ? total.plus(owed) : total;
}, dec(0));

const receivableLedger = await balanceOf("1210");
if (receivableLedger.minus(owedByCustomers).abs().greaterThan(0.05)) {
  bad(
    `customers: ledger ${receivableLedger.toFixed(2)} vs what the orders say they owe ${owedByCustomers.toFixed(2)}`,
  );
} else {
  ok(`what customers owe matches the ledger: ${receivableLedger.toFixed(2)}`);
}

/* ───────────────── 2. the accounting equation holds ────────────────────── */

console.log("\n── the accounting equation");

const rows = await db.$queryRaw<{ type: string; b: string }[]>`
  SELECT a."type"::text AS type, COALESCE(SUM(l."debit") - SUM(l."credit"), 0)::text AS b
  FROM "journal_lines" l
  JOIN "journal_entries" e ON e."id" = l."journalEntryId"
  JOIN "accounts" a ON a."id" = l."accountId"
  WHERE e."status" = 'POSTED'
  GROUP BY a."type"`;

const by = (t: string) => dec(rows.find((r) => r.type === t)?.b ?? 0);
const assets = by("ASSET");
const liabilities = by("LIABILITY").negated();
const equity = by("EQUITY").negated();
const revenue = by("REVENUE").negated();
const cogs = by("COGS");
const expenses = by("EXPENSE");
const profit = revenue.minus(cogs).minus(expenses);

const left = assets;
const right = liabilities.plus(equity).plus(profit);
if (left.minus(right).abs().greaterThan(0.05)) {
  bad(`assets ${left.toFixed(2)} ≠ liabilities + equity + profit ${right.toFixed(2)}`);
} else {
  ok(`assets ${left.toFixed(2)} = liabilities + equity + profit ${right.toFixed(2)}`);
}

/* ───────────────── 3. a closed period refuses new postings ─────────────── */

console.log("\n── the period lock");

const openPeriod = await db.fiscalPeriod.findFirstOrThrow({
  where: { status: "OPEN" }, orderBy: { startDate: "asc" },
});
const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });
const cat = await db.costCategory.findFirstOrThrow({
  where: { entityId: factory.id },
});

// Post into it while open — must work.
const before = await db.journalEntry.count();
await createExpense(
  {
    entityId: factory.id, costCategoryId: cat.id, description: "Period lock probe",
    amount: 100, incurredDate: new Date(openPeriod.startDate), dueDate: new Date(openPeriod.startDate),
  },
  ctx,
);
if ((await db.journalEntry.count()) <= before) bad("could not post into an open period");
else ok("an open period accepts a posting");

// Close it, try again — must fail.
await db.fiscalPeriod.update({ where: { id: openPeriod.id }, data: { status: "CLOSED" } });

let refused = false;
try {
  await createExpense(
    {
      entityId: factory.id, costCategoryId: cat.id, description: "Post into a closed period",
      amount: 100, incurredDate: new Date(openPeriod.startDate), dueDate: new Date(openPeriod.startDate),
    },
    ctx,
  );
} catch {
  refused = true;
}
if (!refused) bad("a closed period accepted a new posting");
else ok("a closed period refuses a new posting");

// And directly in SQL, bypassing the application entirely.
let sqlRefused = false;
try {
  await db.$executeRawUnsafe(`
    INSERT INTO journal_entries (id,"entryNumber","entityId","fiscalPeriodId",status,"postingDate","sourceType","createdAt","updatedAt")
    VALUES ('lockprobe','LOCK-1','${factory.id}','${openPeriod.id}','POSTED',CURRENT_DATE,'MANUAL',NOW(),NOW())`);
} catch {
  sqlRefused = true;
}
if (!sqlRefused) bad("raw SQL posted into a closed period");
else ok("raw SQL is refused too, not just the application");

await db.fiscalPeriod.update({ where: { id: openPeriod.id }, data: { status: "OPEN" } });
ok("period reopened for the rest of the audit");

/* ───────────────── 4. correction is reversal, not mutation ─────────────── */

console.log("\n── correcting a posted entry");

const target = await db.journalEntry.findFirstOrThrow({
  where: { status: "POSTED" },
  include: { lines: true },
});

let mutationRefused = false;
try {
  await db.journalLine.update({
    where: { id: target.lines[0].id },
    data: { debit: dec(target.lines[0].debit).plus(1).toString() },
  });
} catch {
  mutationRefused = true;
}
if (!mutationRefused) bad("a posted line was edited through the application's own client");
else ok("a posted line cannot be edited, even from application code");

const balanced = await db.$queryRaw<{ d: string; c: string }[]>`
  SELECT COALESCE(SUM(l."debit"),0)::text AS d, COALESCE(SUM(l."credit"),0)::text AS c
  FROM "journal_lines" l JOIN "journal_entries" e ON e."id" = l."journalEntryId"
  WHERE e."status" = 'POSTED'`;
if (balanced[0].d !== balanced[0].c) bad(`ledger out of balance: ${balanced[0].d} vs ${balanced[0].c}`);
else ok(`ledger balances at ${Number(balanced[0].d).toFixed(2)}`);

console.log("\n" + "═".repeat(58));
if (problems.length === 0) console.log("The books agree with themselves and refuse to be edited.");
else {
  console.log(`${problems.length} problem(s):\n`);
  problems.forEach((p, i) => console.log(`${i + 1}. ${p}`));
}

await db.$disconnect();
process.exit(problems.length === 0 ? 0 : 1);
