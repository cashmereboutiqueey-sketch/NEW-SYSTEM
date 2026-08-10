/**
 * The system under a realistic weight of data.
 *
 * A screen that answers instantly on a demo of four orders can take thirty
 * seconds on a year of real trading, and the difference is almost always a
 * query that reads a whole table. This loads enough history to make that
 * visible, then times the queries the screens actually run.
 *
 * The data is deliberately crude — the point is volume and index behaviour,
 * not business realism, so it is written straight to the tables rather than
 * through the services, which would take hours.
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { dec } from "../src/lib/money";

const CUSTOMERS = Number(process.env.AUDIT_CUSTOMERS ?? 10_000);
const ORDERS = Number(process.env.AUDIT_ORDERS ?? 10_000);
const JOURNALS = Number(process.env.AUDIT_JOURNALS ?? 20_000);

const problems: string[] = [];
const ok = (m: string) => console.log(`   ✓ ${m}`);
const bad = (m: string) => { problems.push(m); console.log(`   ✗ ${m}`); };
const slow = (m: string) => console.log(`   • ${m}`);

/** Anything past this on a screen query is a problem a user will feel. */
const BUDGET_MS = 1_000;

async function timed<T>(what: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await run();
  const took = Math.round(performance.now() - started);
  if (took > BUDGET_MS) bad(`${what} took ${took}ms (budget ${BUDGET_MS}ms)`);
  else if (took > BUDGET_MS / 2) slow(`${what} took ${took}ms`);
  else ok(`${what} in ${took}ms`);
  return result;
}

console.log("── loading a year of trading");

const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });
const channel = await db.salesChannel.findFirstOrThrow();
const location = await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } });
const variant = await db.variant.findFirstOrThrow();
const period = await db.fiscalPeriod.findFirstOrThrow({ where: { status: "OPEN" } });
const account = await db.account.findFirstOrThrow({ where: { code: "1110" } });
const other = await db.account.findFirstOrThrow({ where: { code: "4130" } });

const startedAt = performance.now();
const existingCustomers = await db.customer.count();

if (existingCustomers < CUSTOMERS) {
  const wanted = CUSTOMERS - existingCustomers;
  for (let batch = 0; batch < wanted; batch += 2_000) {
    const size = Math.min(2_000, wanted - batch);
    await db.customer.createMany({
      data: Array.from({ length: size }, (_, i) => {
        const n = existingCustomers + batch + i;
        return {
          code: `VOL-${n}`,
          name: `Volume Customer ${n}`,
          phone: `0100${String(n).padStart(7, "0")}`,
          phoneNormalised: `+2010${String(n).padStart(7, "0")}`,
          acquiredVia: "SHOPIFY" as const,
        };
      }),
      skipDuplicates: true,
    });
  }
}
ok(`${await db.customer.count()} customers`);

const customerIds = (
  await db.customer.findMany({ select: { id: true }, take: 5_000 })
).map((c) => c.id);

const existingOrders = await db.salesOrder.count();
if (existingOrders < ORDERS) {
  const wanted = ORDERS - existingOrders;
  const day = new Date(period.startDate);

  for (let batch = 0; batch < wanted; batch += 1_000) {
    const size = Math.min(1_000, wanted - batch);
    const rows = Array.from({ length: size }, (_, i) => {
      const n = existingOrders + batch + i;
      const price = 500 + (n % 40) * 25;
      return {
        orderNumber: `VOL-SO-${n}`,
        source: "SHOPIFY" as const,
        channelId: channel.id,
        entityId: brand.id,
        locationId: location.id,
        customerId: customerIds[n % customerIds.length],
        status: "CONFIRMED" as const,
        orderDate: new Date(day.getTime() - (n % 365) * 86_400_000),
        grossAmount: dec(price).toString(),
        discountAmount: "0",
        netAmount: dec(price).toString(),
        shippingAmount: "0",
        paymentFee: "0",
        cogsAmount: dec(price).times("0.55").toString(),
      };
    });
    await db.salesOrder.createMany({ data: rows, skipDuplicates: true });
  }

  // One line each, so the joins the screens do are exercised.
  const created = await db.salesOrder.findMany({
    where: { orderNumber: { startsWith: "VOL-SO-" }, lines: { none: {} } },
    select: { id: true, netAmount: true },
    take: ORDERS,
  });
  for (let i = 0; i < created.length; i += 2_000) {
    await db.salesOrderLine.createMany({
      data: created.slice(i, i + 2_000).map((o) => ({
        salesOrderId: o.id,
        variantId: variant.id,
        quantity: 1,
        retailPrice: o.netAmount.toString(),
        discountPct: "0",
        netPrice: o.netAmount.toString(),
        lineTotal: o.netAmount.toString(),
        unitCost: dec(o.netAmount).times("0.55").toString(),
        lineCost: dec(o.netAmount).times("0.55").toString(),
      })),
    });
  }
}
ok(`${await db.salesOrder.count()} sales orders`);

// Journals are written raw and balanced, so the deferred balance trigger is
// satisfied without going through the posting service for twenty thousand
// entries.
const existingJournals = await db.journalEntry.count();
if (existingJournals < JOURNALS) {
  const wanted = JOURNALS - existingJournals;
  for (let batch = 0; batch < wanted; batch += 2_000) {
    const size = Math.min(2_000, wanted - batch);
    const entries = Array.from({ length: size }, (_, i) => {
      const n = existingJournals + batch + i;
      return {
        id: `vol-je-${n}`,
        entryNumber: `VOL-JE-${n}`,
        entityId: brand.id,
        fiscalPeriodId: period.id,
        status: "POSTED" as const,
        postingDate: new Date(period.startDate),
        sourceType: "MANUAL" as const,
      };
    });
    // Entries and their lines go in together: the balance check is a deferred
    // constraint trigger, so a batch of entries committed without lines is
    // rejected at commit — correctly.
    await db.$transaction(async (tx) => {
      await tx.journalEntry.createMany({ data: entries, skipDuplicates: true });
      await tx.journalLine.createMany({
        data: entries.flatMap((e) => [
          {
            id: `${e.id}-a`, journalEntryId: e.id, accountId: account.id,
            entityId: brand.id, lineNumber: 1, debit: "10", credit: "0",
          },
          {
            id: `${e.id}-b`, journalEntryId: e.id, accountId: other.id,
            entityId: brand.id, lineNumber: 2, debit: "0", credit: "10",
          },
        ]),
        skipDuplicates: true,
      });
    }, { timeout: 60_000 });
  }
}
ok(`${await db.journalEntry.count()} journal entries, ${await db.journalLine.count()} lines`);
ok(`loaded in ${Math.round((performance.now() - startedAt) / 1000)}s`);

console.log("\n── the queries the screens run");

await timed("customer list, first page", () =>
  db.customer.findMany({ orderBy: { name: "asc" }, take: 50 }),
);

await timed("sales list, first page with joins", () =>
  db.salesOrder.findMany({
    include: { customer: true, channel: true, lines: true, payments: true },
    orderBy: [{ orderDate: "desc" }, { createdAt: "desc" }],
    take: 100,
  }),
);

await timed("trial balance over every posted line", () =>
  db.$queryRaw`
    SELECT a."code", SUM(l."debit")::text AS d, SUM(l."credit")::text AS c
    FROM "journal_lines" l
    JOIN "journal_entries" e ON e."id" = l."journalEntryId"
    JOIN "accounts" a ON a."id" = l."accountId"
    WHERE e."status" = 'POSTED'
    GROUP BY a."code"`,
);

await timed("ledger balance check", () =>
  db.$queryRaw`
    SELECT COALESCE(SUM(l."debit"),0)::text AS d, COALESCE(SUM(l."credit"),0)::text AS c
    FROM "journal_lines" l JOIN "journal_entries" e ON e."id" = l."journalEntryId"
    WHERE e."status" = 'POSTED'`,
);

await timed("stock on hand by lot", () =>
  db.inventoryLot.findMany({
    where: { remainingQty: { gt: 0 } },
    include: { material: true, variant: true, location: true },
  }),
);

await timed("outstanding courier money", () =>
  db.salesPayment.findMany({
    where: { status: "PENDING", method: "COD", settlementLine: null },
    include: { salesOrder: { include: { channel: true, customer: true } } },
  }),
);

await timed("audit log, most recent page", () =>
  db.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
);

console.log("\n── what the reports do");

const { ownerDashboard } = await import("../src/lib/dashboard");
await timed("owner dashboard", () => ownerDashboard());

const { apAging } = await import("../src/lib/reports");
await timed("payables aging", () => apAging());

const { cashForecast } = await import("../src/lib/cash-flow");
await timed("thirteen-week cash forecast", () => cashForecast(brand.id));

console.log("\n── whether the planner uses the indexes");

// Judged on selectivity, not on plan shape. Nearly every order belongs to one
// entity, so reading the table and sorting is the correct plan there and an
// index would rightly be ignored. What matters is a needle: one customer out
// of ten thousand, or one scanned tag out of hundreds, must not read
// everything.
const planFor = async (sql: string) => {
  const rows = await db.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN ANALYZE ${sql}`);
  const text = rows.map((r) => r["QUERY PLAN"]).join("\n");
  const ms = Number(/actual time=[\d.]+\.\.([\d.]+)/.exec(text)?.[1] ?? 0);
  return { text, ms };
};

const byCustomer = await planFor(
  `SELECT * FROM sales_orders WHERE "customerId" = '${customerIds[0]}'
   ORDER BY "orderDate" DESC LIMIT 50`,
);
if (/Seq Scan on sales_orders/.test(byCustomer.text)) {
  bad(`one customer's history reads the whole orders table (${byCustomer.ms}ms)`);
} else {
  ok(`one customer's history uses an index (${byCustomer.ms}ms)`);
}

const byTag = await planFor(`SELECT * FROM garment_units WHERE serial = 'AAAAAAAA'`);
if (/Seq Scan on garment_units/.test(byTag.text)) {
  bad(`a tag scanned at the till reads the whole garment table (${byTag.ms}ms)`);
} else {
  ok(`a scanned tag is found by index (${byTag.ms}ms)`);
}

const byOrderNumber = await planFor(`SELECT * FROM sales_orders WHERE "orderNumber" = 'VOL-SO-9999'`);
if (/Seq Scan on sales_orders/.test(byOrderNumber.text)) {
  bad(`looking an order up by its number reads the whole table (${byOrderNumber.ms}ms)`);
} else {
  ok(`an order is found by its number using an index (${byOrderNumber.ms}ms)`);
}

console.log("\n" + "═".repeat(58));
if (problems.length === 0) console.log("Every screen query stayed inside its budget.");
else {
  console.log(`${problems.length} performance problem(s):\n`);
  problems.forEach((p, i) => console.log(`${i + 1}. ${p}`));
}

await db.$disconnect();
process.exit(problems.length === 0 ? 0 : 1);
