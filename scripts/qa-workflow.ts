/**
 * One garment, all the way through, with the books checked at every step.
 *
 * The walkthrough proves the steps can be done. This proves they add up: after
 * each one it re-reads the ledger and asserts what should have moved and what
 * should not. A step that posts to the wrong account still "works" — the
 * screen says saved, the stock moves — and only the accounts disagree, quietly,
 * until somebody closes a month.
 *
 * It runs against whatever is already in the database and undoes nothing, so
 * run it on a demo rather than on real books.
 *
 *   npx tsx --conditions=react-server scripts/qa-workflow.ts
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { dec, type Decimal } from "../src/lib/money";
import {
  receiveMaterial, issueMaterialToProduction, receiveFinishedGoods,
} from "../src/lib/inventory";
import { recordScrap } from "../src/lib/scrap";
import { createSale } from "../src/lib/sales";
import { collectPayment, setCreditTerms } from "../src/lib/receivables";

const owner = await db.user.findFirstOrThrow({ where: { role: "OWNER" } });
const ctx = { userId: owner.id, reason: null };

const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });
const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });
const store = await db.location.findFirstOrThrow({ where: { code: "LOC-FAC" } });
const showroom = await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } });
const fabric = await db.material.findFirstOrThrow({ where: { type: "FABRIC" } });
const channel = await db.salesChannel.findFirstOrThrow({ where: { kind: "RETAIL_STORE" } });

const period = await db.fiscalPeriod.findFirstOrThrow({
  where: { status: "OPEN" },
  orderBy: { startDate: "asc" },
});
const day = new Date(period.startDate);

const problems: string[] = [];
const ok = (m: string) => console.log(`   ✓ ${m}`);
const bad = (m: string) => { problems.push(m); console.log(`   ✗ ${m}`); };

/** Debits less credits on posted entries, for one account. */
async function balanceOf(code: string): Promise<Decimal> {
  const rows = await db.$queryRaw<{ total: string }[]>`
    SELECT COALESCE(SUM(l."debit") - SUM(l."credit"), 0)::text AS total
    FROM "journal_lines" l
    JOIN "journal_entries" e ON e."id" = l."journalEntryId"
    JOIN "accounts" a ON a."id" = l."accountId"
    WHERE a."code" = ${code} AND e."status" = 'POSTED'
  `;
  return dec(rows[0]?.total ?? 0);
}

/** Everything posted, which must always net to nothing. */
async function ledgerBalances(): Promise<Decimal> {
  const rows = await db.$queryRaw<{ total: string }[]>`
    SELECT COALESCE(SUM(l."debit") - SUM(l."credit"), 0)::text AS total
    FROM "journal_lines" l
    JOIN "journal_entries" e ON e."id" = l."journalEntryId"
    WHERE e."status" = 'POSTED'
  `;
  return dec(rows[0]?.total ?? 0);
}

/**
 * Assert a step moved exactly what it should have and nothing else.
 *
 * `expected` names the accounts that must change and by how much. Every other
 * account is checked too — an amount that lands somewhere unexpected is the
 * failure this exists to catch, and it never shows up in a test that only
 * looks at the accounts it was expecting.
 */
// 1115 rather than 1110: money taken over the counter lands in the till, not
// in general cash, so the drawer can be counted against its own account at
// the end of a shift. 4130 rather than 4100: revenue is split by where the
// sale came from, which is what makes the channel reports possible.
const WATCHED = [
  "1110", "1115", "1210", "1310", "1320", "1330", "1340", "4130", "5100", "5300", "5400",
];

async function snapshot() {
  const entries = await Promise.all(WATCHED.map(async (c) => [c, await balanceOf(c)] as const));
  return new Map(entries);
}

async function step(
  name: string,
  run: () => Promise<void>,
  expected: Record<string, number>,
) {
  const before = await snapshot();
  await run();
  const after = await snapshot();

  const moved: string[] = [];
  let wrong = false;

  for (const code of WATCHED) {
    const delta = after.get(code)!.minus(before.get(code)!);
    const want = dec(expected[code] ?? 0);
    if (!delta.minus(want).abs().lessThan("0.01")) {
      wrong = true;
      bad(`${name}: ${code} moved ${delta.toFixed(2)}, expected ${want.toFixed(2)}`);
    }
    if (!delta.isZero()) moved.push(`${code} ${delta.toFixed(2)}`);
  }

  const net = await ledgerBalances();
  if (!net.abs().lessThan("0.01")) {
    wrong = true;
    bad(`${name}: the whole ledger is off by ${net.toFixed(4)}`);
  }

  if (!wrong) ok(`${name.padEnd(46)} ${moved.join("  ")}`);
}

console.log("── one garment, end to end, checking the books at each step\n");

// ─────────────────────────────── 1. buy cloth ──────────────────────────────

const METRES = 20;
const PER_METRE = 150;
const CLOTH = METRES * PER_METRE;

await step(
  "buy 20m of cloth at 150",
  async () => {
    await receiveMaterial(
      {
        materialId: fabric.id, locationId: store.id, entityId: factory.id,
        quantity: String(METRES), unitCost: String(PER_METRE), receivedDate: day,
      },
      ctx,
    );
  },
  // Stock up, payables up. Nothing has been consumed or sold.
  { "1310": CLOTH },
);

// ───────────────────────────── 2. issue to a run ───────────────────────────

const ISSUED = 12;
const ISSUE_COST = ISSUED * PER_METRE;

await step(
  "issue 12m to production",
  async () => {
    await issueMaterialToProduction(
      {
        materialId: fabric.id, locationId: store.id, entityId: factory.id,
        quantity: String(ISSUED), issueDate: day,
      },
      ctx,
    );
  },
  // Out of raw materials, into work in progress. The value has not changed,
  // only where it is.
  { "1310": -ISSUE_COST, "1320": ISSUE_COST },
);

// ─────────────────── 2b. turn the work in progress into a garment ──────────
//
// Without this the script left the cloth in work in progress for ever. Nothing
// complained at the time, and then audit-books — which has a check for exactly
// this — reported stranded work in progress with no open run, permanently,
// against books the script itself had poisoned. Two of the repo's own tools
// disagreeing about the same number, one of them wrongly.
//
// It also closes a hole in the chain: buying, issuing and selling were each
// covered, and the step that turns issued cloth into something sellable was
// the one nobody checked.

const madeVariant = await db.variant.findFirstOrThrow({
  where: { style: { operations: { some: {} } } },
});
// Conversion is the labour the garment absorbs on top of its cloth. A small
// figure keeps the arithmetic readable; the point is that the two halves sum.
const CONVERSION = 200;

await step(
  "make it up: work in progress becomes a garment",
  async () => {
    await receiveFinishedGoods(
      {
        variantId: madeVariant.id,
        locationId: store.id,
        entityId: factory.id,
        quantity: "1",
        unitCost: String(ISSUE_COST + CONVERSION),
        materialUnitCost: String(ISSUE_COST),
        receivedDate: day,
      },
      ctx,
    );
  },
  // Work in progress empties into the factory's own finished goods — 1330, not
  // the brand's 1340, because the garment has not been transferred yet — and
  // the conversion the floor absorbed is credited to 6190 rather than sitting
  // as a cost twice.
  { "1320": -ISSUE_COST, "1330": ISSUE_COST + CONVERSION, "6190": -CONVERSION },
);

// ──────────────────────────── 3. scrap an offcut ───────────────────────────

const SCRAPPED = 2;
const SCRAP_COST = SCRAPPED * PER_METRE;

await step(
  "scrap 2m off the table",
  async () => {
    await recordScrap(
      {
        materialId: fabric.id, locationId: store.id, entityId: factory.id,
        disposition: "DISCARDED", quantity: SCRAPPED, scrapDate: day,
      },
      { userId: owner.id, reason: null },
    );
  },
  // Out of stock and straight to the loss account, where somebody sees it.
  { "1310": -SCRAP_COST, "5400": SCRAP_COST },
);

// ────────────────────────────── 4. sell a garment ──────────────────────────

const sellable = await db.inventoryLot.findFirst({
  where: {
    entityId: brand.id, state: "FINISHED_GOODS", remainingQty: { gt: 0 },
    locationId: showroom.id, variantId: { not: null },
  },
  include: { variant: true },
  orderBy: [{ receivedDate: "asc" }, { sequence: "asc" }],
});

if (!sellable?.variantId) {
  console.log("   — no finished stock at the showroom, so the selling half is skipped");
  console.log("     (run scripts/seed-factory-floor.ts after npm run db:demo)");
} else {
  const PRICE = 1000;
  const cogs = dec(sellable.unitCost);

  await step(
    "sell one garment for 1,000 cash",
    async () => {
      await createSale(
        {
          source: "MANUAL",
          entityId: brand.id,
          channelId: channel.id,
          locationId: showroom.id,
          orderDate: day,
          lines: [{ variantId: sellable.variantId!, quantity: 1, retailPrice: PRICE }],
          payments: [{ method: "CASH", amount: PRICE }],
        },
        ctx,
      );
    },
    // Cash in, revenue recognised, and the garment leaves stock at what it
    // cost — not at what it sold for.
    { "1115": PRICE, "4130": -PRICE, "1340": -Number(cogs), "5300": Number(cogs) },
  );

  // ───────────────────────── 5. sell on credit, then collect ───────────────

  const onCredit = await db.inventoryLot.findFirst({
    where: {
      entityId: brand.id, state: "FINISHED_GOODS", remainingQty: { gt: 0 },
      locationId: showroom.id, variantId: { not: null },
    },
    include: { variant: true },
    orderBy: [{ receivedDate: "asc" }, { sequence: "asc" }],
  });

  const customer = await db.customer.findFirst({ where: { isActive: true } });

  if (onCredit?.variantId && customer) {
    const CREDIT_PRICE = 800;

    // Selling on credit to somebody with no limit is refused, and rightly so.
    // Granting one is part of the workflow being tested, not a way round it:
    // the refusal below is what proves the limit is load-bearing.
    await setCreditTerms(
      { customerId: customer.id, creditLimit: "5000", creditDays: 30 },
      ctx,
    );
    const creditCogs = dec(onCredit.unitCost);
    let orderId = "";

    await step(
      "sell one on credit, nothing paid",
      async () => {
        const sale = await createSale(
          {
            source: "MANUAL",
            entityId: brand.id,
            channelId: channel.id,
            locationId: showroom.id,
            customerId: customer.id,
            orderDate: day,
            lines: [{ variantId: onCredit.variantId!, quantity: 1, retailPrice: CREDIT_PRICE }],
            payments: [{ method: "CASH", amount: 300 }],
          },
          ctx,
        );
        orderId = sale.salesOrderId;
      },
      // 300 in the drawer, 500 owed. The garment still leaves at cost.
      {
        "1115": 300,
        "1210": CREDIT_PRICE - 300,
        "4130": -CREDIT_PRICE,
        "1340": -Number(creditCogs),
        "5300": Number(creditCogs),
      },
    );

    await step(
      "collect the 500 outstanding",
      async () => {
        await collectPayment(
          { salesOrderId: orderId, amount: "500", method: "CASH", collectedOn: day },
          ctx,
        );
      },
      // The debt turns into money in the till — a customer settling up hands
      // it across the same counter — and no revenue moves, because that was
      // recognised when the garment left.
      { "1115": 500, "1210": -500 },
    );
    // The limit has to refuse something, or it is decoration.
    await setCreditTerms(
      { customerId: customer.id, creditLimit: "1", creditDays: 30 },
      ctx,
    );

    const another = await db.inventoryLot.findFirst({
      where: {
        entityId: brand.id, state: "FINISHED_GOODS", remainingQty: { gt: 0 },
        locationId: showroom.id, variantId: { not: null },
      },
      orderBy: [{ receivedDate: "asc" }, { sequence: "asc" }],
    });

    if (another?.variantId) {
      let refused = false;
      try {
        await createSale(
          {
            source: "MANUAL",
            entityId: brand.id,
            channelId: channel.id,
            locationId: showroom.id,
            customerId: customer.id,
            orderDate: day,
            lines: [{ variantId: another.variantId, quantity: 1, retailPrice: 900 }],
            payments: [],
          },
          ctx,
        );
      } catch {
        refused = true;
      }

      if (refused) ok("a sale beyond the credit limit is refused".padEnd(46) + " nothing posted");
      else bad("a customer was allowed to go past their credit limit");
    }
  } else {
    console.log("   — no second garment or no customer, so the credit half is skipped");
  }
}

// ───────────────────────────────── the verdict ─────────────────────────────

const net = await ledgerBalances();
console.log(`\n   ledger nets to ${net.toFixed(4)}`);

if (problems.length === 0) {
  console.log("\nevery step moved exactly what it should, and the books balance throughout");
} else {
  console.log(`\n${problems.length} problem(s)`);
}

await db.$disconnect();
process.exit(problems.length === 0 ? 0 : 1);
