import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import {
  receiveMaterial,
  issueMaterialToProduction,
  receiveFinishedGoods,
  relieveFinishedGoodsForSale,
  reconcileLot,
} from "./inventory";
import { dec } from "./money";

/**
 * The required business scenario, verbatim from the specification:
 *
 *   Buy fabric for 10 garments. Manufacture 4. Sell 2.
 *
 * Expected afterwards:
 *   - only the 2 sold garments contribute cost of goods sold
 *   - 2 finished garments remain in inventory at cost
 *   - the unused fabric remains as raw material
 *   - the accounting balances and the stock ledger reconciles
 *   - no phantom profit
 *
 * This is the scenario the whole system exists to get right: profit must not
 * be reported as if all the purchased fabric had already been sold.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

// One garment needs 2 metres. Fabric is bought for 10 garments = 20 metres.
const METRES_PER_GARMENT = 2;
const GARMENTS_PLANNED = 10;
const FABRIC_METRES = METRES_PER_GARMENT * GARMENTS_PLANNED; // 20
const FABRIC_COST_PER_METRE = 172.2;
const FABRIC_TOTAL = FABRIC_METRES * FABRIC_COST_PER_METRE; // 3,444

const GARMENTS_MADE = 4;
const GARMENTS_SOLD = 2;
// Frozen factory cost per garment: 2m of fabric plus 33 min of conversion.
const CONVERSION_PER_GARMENT = 78.2265;
const COST_PER_GARMENT = METRES_PER_GARMENT * FABRIC_COST_PER_METRE + CONVERSION_PER_GARMENT;

let factoryId: string;
let materialId: string;
let variantId: string;
let locationId: string;
let day: Date;

const ctx = { userId: null as string | null, reason: null };

beforeAll(async () => {
  factoryId = (await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } })).id;
  materialId = (await db.material.findFirstOrThrow({ where: { type: "FABRIC" } })).id;
  variantId = (await db.variant.findFirstOrThrow()).id;
  locationId = (await db.location.findFirstOrThrow({ where: { code: "LOC-FAC" } })).id;

  const period = await db.fiscalPeriod.findFirstOrThrow({
    where: { status: "OPEN" }, orderBy: { startDate: "asc" },
  });
  day = new Date(period.startDate);
});

async function wipe() {
  await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" DISABLE TRIGGER USER`);
  await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" DISABLE TRIGGER USER`);
  try {
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

/** Balance of an account from the posted ledger, in its normal direction. */
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

/** Runs the whole scenario end to end. */
async function runScenario() {
  await receiveMaterial(
    {
      materialId, locationId, entityId: factoryId,
      quantity: String(FABRIC_METRES),
      unitCost: String(FABRIC_COST_PER_METRE),
      receivedDate: day,
    },
    ctx,
  );

  // Only the fabric for the 4 garments actually cut is issued.
  const issued = await issueMaterialToProduction(
    {
      materialId, locationId, entityId: factoryId,
      quantity: String(GARMENTS_MADE * METRES_PER_GARMENT),
      issueDate: day,
    },
    ctx,
  );

  await receiveFinishedGoods(
    {
      variantId, locationId, entityId: factoryId,
      quantity: String(GARMENTS_MADE),
      unitCost: String(COST_PER_GARMENT),
      materialUnitCost: String(METRES_PER_GARMENT * FABRIC_COST_PER_METRE),
      receivedDate: day,
    },
    ctx,
  );

  const sale = await relieveFinishedGoodsForSale(
    {
      variantId, locationId, entityId: factoryId,
      quantity: String(GARMENTS_SOLD),
      saleDate: day,
    },
    ctx,
  );

  return { issued, sale };
}

describe("fabric for 10, make 4, sell 2", () => {
  it("leaves the unused fabric as raw material", async () => {
    await runScenario();

    const lots = await db.inventoryLot.findMany({
      where: { materialId, state: "RAW_MATERIAL" },
    });
    const remaining = lots.reduce((s, l) => s.plus(dec(l.remainingQty)), dec(0));

    // 20 metres bought, 8 issued for the 4 garments made.
    expect(remaining.toString()).toBe("12");

    const rawValue = lots.reduce(
      (s, l) => s.plus(dec(l.remainingQty).times(dec(l.unitCost))), dec(0),
    );
    expect(rawValue.toFixed(2)).toBe((12 * FABRIC_COST_PER_METRE).toFixed(2));
  });

  it("leaves the 2 unsold garments in finished goods at cost", async () => {
    await runScenario();

    const lots = await db.inventoryLot.findMany({
      where: { variantId, state: "FINISHED_GOODS" },
    });
    const remaining = lots.reduce((s, l) => s.plus(dec(l.remainingQty)), dec(0));
    expect(remaining.toString()).toBe("2");

    const fgValue = lots.reduce(
      (s, l) => s.plus(dec(l.remainingQty).times(dec(l.unitCost))), dec(0),
    );
    expect(fgValue.toFixed(2)).toBe((2 * COST_PER_GARMENT).toFixed(2));
  });

  it("charges cost of goods sold for the 2 sold garments only", async () => {
    const { sale } = await runScenario();

    // Not the 4 made, and emphatically not the 10 the fabric could have made.
    expect(Number(sale.cogs)).toBeCloseTo(GARMENTS_SOLD * COST_PER_GARMENT, 2);
    expect(await accountBalance("5100")).toBeCloseTo(GARMENTS_SOLD * COST_PER_GARMENT, 2);
  });

  it("does not treat unsold stock as an expense", async () => {
    await runScenario();

    const cogs = await accountBalance("5100");
    const rawAsset = await accountBalance("1310");
    const fgAsset = await accountBalance("1330");

    // The cost of everything not yet sold sits on the balance sheet, not in
    // the P&L. This is the phantom-profit check.
    expect(rawAsset).toBeCloseTo(12 * FABRIC_COST_PER_METRE, 2);
    expect(fgAsset).toBeCloseTo(2 * COST_PER_GARMENT, 2);
    expect(cogs).toBeLessThan(FABRIC_TOTAL);
  });

  it("accounts for every piastre spent", async () => {
    await runScenario();

    const raw = await accountBalance("1310");
    const wip = await accountBalance("1320");
    const fg = await accountBalance("1330");
    const cogs = await accountBalance("5100");
    const absorbed = -(await accountBalance("6190")); // contra-expense, credit-normal
    const payables = -(await accountBalance("2110")); // a liability, so credit-normal

    // Fabric bought is either still an asset or has become a cost. The
    // conversion absorbed into inventory is added on top, and nothing has
    // evaporated in between.
    expect(raw + wip + fg + cogs).toBeCloseTo(FABRIC_TOTAL + absorbed, 2);

    // The fabric purchase is the only thing owed to a supplier here.
    expect(payables).toBeCloseTo(FABRIC_TOTAL, 2);
  });

  it("clears WIP exactly, leaving nothing stranded", async () => {
    await runScenario();

    // 8 metres of fabric went into WIP and all 8 came out inside the 4
    // garments, so WIP is flat. A non-zero balance here would mean material
    // issued but never accounted for.
    expect(await accountBalance("1320")).toBeCloseTo(0, 2);
  });

  it("absorbs conversion only for the garments actually made", async () => {
    await runScenario();

    // Conversion absorbed into stock is 4 garments' worth. What was incurred
    // but not absorbed stays in the 61xx accounts as the cost of idle
    // capacity — which is exactly the number the minute rate exists to expose.
    const absorbed = -(await accountBalance("6190"));
    expect(absorbed).toBeCloseTo(GARMENTS_MADE * CONVERSION_PER_GARMENT, 2);
  });

  it("keeps the whole ledger balanced", async () => {
    await runScenario();

    const [row] = await db.$queryRaw<{ debit: string; credit: string }[]>`
      SELECT COALESCE(SUM(l."debit"), 0)::text AS debit,
             COALESCE(SUM(l."credit"), 0)::text AS credit
      FROM "journal_lines" l
      JOIN "journal_entries" e ON e."id" = l."journalEntryId"
      WHERE e."status" = 'POSTED'
    `;
    expect(row.debit).toBe(row.credit);
  });

  it("reconciles every lot against its own movements", async () => {
    await runScenario();

    const lots = await db.inventoryLot.findMany();
    expect(lots.length).toBeGreaterThan(0);

    for (const lot of lots) {
      const check = await reconcileLot(lot.id);
      expect({ lot: lot.lotNumber, ...check }).toMatchObject({ ok: true });
    }
  });

  it("ties every stock movement to a journal", async () => {
    await runScenario();

    const movements = await db.inventoryMovement.findMany();
    expect(movements.length).toBe(4); // receipt, issue, output, sale
    for (const m of movements) {
      expect(m.journalEntryId).not.toBeNull();
      expect(m.referenceType).not.toBeNull();
    }
  });

  it("refuses to sell a third garment out of two", async () => {
    await runScenario();

    await expect(
      relieveFinishedGoodsForSale(
        { variantId, locationId, entityId: factoryId, quantity: "3", saleDate: day },
        ctx,
      ),
    ).rejects.toThrow(/Not enough finished goods/i);
  });

  it("refuses to cut more garments than the remaining fabric allows", async () => {
    await runScenario();

    // 12 metres left is 6 garments; asking for 7 must fail rather than
    // silently issuing what is there.
    await expect(
      issueMaterialToProduction(
        { materialId, locationId, entityId: factoryId, quantity: "14", issueDate: day },
        ctx,
      ),
    ).rejects.toThrow(/short by 2/i);
  });
});

describe("FIFO across two purchases at different prices", () => {
  it("costs the sale from the older, cheaper lot first", async () => {
    const earlier = new Date(day.getTime());
    const later = new Date(day.getTime() + 5 * 86_400_000);

    await receiveMaterial(
      { materialId, locationId, entityId: factoryId, quantity: "10", unitCost: "95", receivedDate: earlier },
      ctx,
    );
    await receiveMaterial(
      { materialId, locationId, entityId: factoryId, quantity: "10", unitCost: "112", receivedDate: later },
      ctx,
    );

    // 15 metres: all 10 of the cheap lot, then 5 of the dearer one.
    const issued = await issueMaterialToProduction(
      { materialId, locationId, entityId: factoryId, quantity: "15", issueDate: later },
      ctx,
    );

    // 10×95 + 5×112 = 950 + 560
    expect(Number(issued.totalCost)).toBeCloseTo(1510, 4);
    expect(issued.allocations).toHaveLength(2);

    // The dearer lot keeps 5 metres at its own cost — not restated to 95.
    const dear = await db.inventoryLot.findFirstOrThrow({ where: { unitCost: "112" } });
    expect(dear.remainingQty.toString()).toBe("5");
  });

  it("does not restate older stock when a later purchase is dearer", async () => {
    await receiveMaterial(
      { materialId, locationId, entityId: factoryId, quantity: "10", unitCost: "95", receivedDate: day },
      ctx,
    );
    const cheapValueBefore = await accountBalance("1310");

    await receiveMaterial(
      { materialId, locationId, entityId: factoryId, quantity: "10", unitCost: "112", receivedDate: day },
      ctx,
    );

    // The first lot still carries 950, not 1,120.
    const cheap = await db.inventoryLot.findFirstOrThrow({ where: { unitCost: "95" } });
    expect(dec(cheap.remainingQty).times(dec(cheap.unitCost)).toString()).toBe("950");
    expect(cheapValueBefore).toBeCloseTo(950, 2);
    expect(await accountBalance("1310")).toBeCloseTo(950 + 1120, 2);
  });
});
