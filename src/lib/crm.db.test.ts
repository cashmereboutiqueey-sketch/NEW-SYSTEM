import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { receiveFinishedGoods } from "./inventory";
import { createSale } from "./sales";
import {
  customerProfiles, duplicateCandidates, mergeCustomers,
  marketableCustomers, upsertCustomerContact, CrmError,
} from "./crm";

/** CRM against a real database, driven by real orders. */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let brandId: string;
let channelId: string;
let locationId: string;
let variantId: string;
let userId: string;
let day: Date;

const ctx = { userId: null as string | null, reason: null };
let seq = 0;

beforeAll(async () => {
  brandId = (await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } })).id;
  channelId = (await db.salesChannel.findFirstOrThrow()).id;
  locationId = (await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } })).id;
  variantId = (await db.variant.findFirstOrThrow()).id;
  // Real user: audit rows carry a foreign key to users.
  userId = (await db.user.findFirstOrThrow({ where: { email: "owner@cashmere.eg" } })).id;

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
    await db.salesPayment.deleteMany({});
    await db.salesOrderLine.deleteMany({});
    await db.salesOrder.deleteMany({});
    await db.customer.updateMany({ data: { mergedIntoId: null } });
    await db.customer.deleteMany({ where: { code: { startsWith: "CRMT-" } } });
    await db.inventoryMovement.deleteMany({});
    await db.inventoryLot.deleteMany({});
    await db.bankStatementLine.deleteMany({});
    await db.bankStatement.deleteMany({});
    await db.journalLine.deleteMany({});
    await db.journalEntry.deleteMany({});
    await db.auditLog.deleteMany({});
    await db.documentSequence.deleteMany({});
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "journal_entries" ENABLE TRIGGER USER`);
    await db.$executeRawUnsafe(`ALTER TABLE "journal_lines" ENABLE TRIGGER USER`);
  }
}

async function makeCustomer(over: { name?: string; phone?: string | null; email?: string | null } = {}) {
  return db.customer.create({
    data: {
      code: `CRMT-${seq++}`,
      name: over.name ?? "نور",
      phone: over.phone ?? null,
      email: over.email ?? null,
      phoneNormalised: null,
      emailNormalised: null,
    },
  });
}

async function givenStock(quantity = "200") {
  await receiveFinishedGoods(
    {
      variantId, locationId, entityId: brandId,
      quantity, unitCost: "400", materialUnitCost: "320", receivedDate: day,
    },
    ctx,
  );
}

async function sell(customerId: string, opts: { when?: Date; qty?: number; price?: number } = {}) {
  return createSale(
    {
      source: "MODERATOR", channelId, entityId: brandId, locationId,
      customerId,
      orderDate: opts.when ?? day,
      lines: [{ variantId, quantity: opts.qty ?? 1, retailPrice: opts.price ?? 1000, discountPct: 0 }],
      payments: [],
    },
    { userId },
  );
}

beforeEach(async () => {
  await wipe();
  await givenStock();
});

afterAll(async () => { await wipe(); await db.$disconnect(); });

describe("customer profiles", () => {
  it("builds lifetime value from real orders", async () => {
    const c = await makeCustomer();
    await sell(c.id, { qty: 2, price: 1000 });
    await sell(c.id, { qty: 1, price: 1500 });

    const profile = (await customerProfiles(day)).find((p) => p.id === c.id)!;

    expect(profile.orders).toBe(2);
    expect(profile.units).toBe(3);
    expect(Number(profile.revenue)).toBe(3500);
    // Cost of 3 units at 400 each.
    expect(Number(profile.cogs)).toBe(1200);
    expect(Number(profile.lifetimeValue)).toBe(2300);
  });

  it("segments a single recent buyer as new", async () => {
    const c = await makeCustomer();
    await sell(c.id);
    const profile = (await customerProfiles(day)).find((p) => p.id === c.id)!;
    expect(profile.segment).toBe("NEW");
    expect(profile.recencyDays).toBe(0);
  });

  it("segments a repeat buyer as loyal or better", async () => {
    const c = await makeCustomer();
    for (let i = 0; i < 5; i++) await sell(c.id, { price: 2000 });
    const profile = (await customerProfiles(day)).find((p) => p.id === c.id)!;
    expect(["CHAMPION", "LOYAL"]).toContain(profile.segment);
  });

  it("reports a customer who has never bought", async () => {
    const c = await makeCustomer();
    const profile = (await customerProfiles(day)).find((p) => p.id === c.id)!;
    expect(profile.segment).toBe("NEVER_PURCHASED");
    expect(profile.orders).toBe(0);
    expect(Number(profile.lifetimeValue)).toBe(0);
  });

  it("ranks customers by value earned, not revenue billed", async () => {
    const big = await makeCustomer({ name: "big" });
    const small = await makeCustomer({ name: "small" });
    await sell(big.id, { qty: 5, price: 1000 });
    await sell(small.id, { qty: 1, price: 1000 });

    const profiles = await customerProfiles(day);
    const bigIdx = profiles.findIndex((p) => p.id === big.id);
    const smallIdx = profiles.findIndex((p) => p.id === small.id);
    expect(bigIdx).toBeLessThan(smallIdx);
  });

  it("hides merged records from the list", async () => {
    const keep = await makeCustomer({ name: "نور", phone: "01001234567" });
    const dupe = await makeCustomer({ name: "نور", phone: "+201001234567" });
    await mergeCustomers({ keepId: keep.id, mergeId: dupe.id, reason: "same phone" }, ctx);

    const profiles = await customerProfiles(day);
    expect(profiles.some((p) => p.id === dupe.id)).toBe(false);
    expect(profiles.some((p) => p.id === keep.id)).toBe(true);
  });
});

describe("duplicate detection", () => {
  it("finds the same phone written differently", async () => {
    const a = await makeCustomer({ phone: "01001234567" });
    const b = await makeCustomer({ phone: "+20 100 123 4567" });
    await upsertCustomerContact({ customerId: a.id, phone: a.phone }, ctx);
    await upsertCustomerContact({ customerId: b.id, phone: b.phone }, ctx);

    const candidates = await duplicateCandidates();
    const found = candidates.find(
      (c) => [c.aId, c.bId].includes(a.id) && [c.aId, c.bId].includes(b.id),
    );
    expect(found?.reason).toBe("PHONE");
  });

  it("flags matching contact with differing names for closer review", async () => {
    // A shared family phone, not necessarily a duplicate.
    const mother = await makeCustomer({ name: "سلمى", phone: "01111111111" });
    const daughter = await makeCustomer({ name: "منة", phone: "01111111111" });

    const candidates = await duplicateCandidates();
    const found = candidates.find(
      (c) => [c.aId, c.bId].includes(mother.id) && [c.aId, c.bId].includes(daughter.id),
    );
    expect(found?.namesDiffer).toBe(true);
  });

  it("stops surfacing a pair once it has been merged", async () => {
    const a = await makeCustomer({ phone: "01222222222" });
    const b = await makeCustomer({ phone: "01222222222" });
    expect((await duplicateCandidates()).length).toBeGreaterThan(0);

    await mergeCustomers({ keepId: a.id, mergeId: b.id, reason: "confirmed same person" }, ctx);

    const after = await duplicateCandidates();
    expect(
      after.some((c) => [c.aId, c.bId].includes(b.id)),
    ).toBe(false);
  });
});

describe("merging", () => {
  it("moves orders to the surviving record and keeps the duplicate", async () => {
    const keep = await makeCustomer({ name: "نور" });
    const dupe = await makeCustomer({ name: "نور" });
    await sell(dupe.id, { qty: 2 });
    await sell(keep.id, { qty: 1 });

    const result = await mergeCustomers(
      { keepId: keep.id, mergeId: dupe.id, reason: "same person, two records" }, ctx,
    );

    expect(result.ordersMoved).toBe(1);

    // The duplicate is retained so its history stays readable.
    const stillThere = await db.customer.findUnique({ where: { id: dupe.id } });
    expect(stillThere).not.toBeNull();
    expect(stillThere!.mergedIntoId).toBe(keep.id);

    const merged = (await customerProfiles(day)).find((p) => p.id === keep.id)!;
    expect(merged.orders).toBe(2);
    expect(merged.units).toBe(3);
  });

  it("records who merged and why", async () => {
    const keep = await makeCustomer();
    const dupe = await makeCustomer();
    await mergeCustomers(
      { keepId: keep.id, mergeId: dupe.id, reason: "confirmed by phone call" },
      { userId, reason: null },
    );

    const audit = await db.auditLog.findFirstOrThrow({
      where: { action: "CUSTOMER_MERGED", entityId: dupe.id },
    });
    expect(audit.reason).toMatch(/phone call/);
    expect(audit.userId).toBe(userId);
  });

  it("requires a reason", async () => {
    const keep = await makeCustomer();
    const dupe = await makeCustomer();
    await expect(
      mergeCustomers({ keepId: keep.id, mergeId: dupe.id, reason: "  " }, ctx),
    ).rejects.toThrow(/needs a reason/i);
  });

  it("refuses to merge a record into itself", async () => {
    const c = await makeCustomer();
    await expect(
      mergeCustomers({ keepId: c.id, mergeId: c.id, reason: "oops" }, ctx),
    ).rejects.toThrow(CrmError);
  });

  it("refuses to merge into a record that is already a duplicate", async () => {
    // Otherwise chains form and the surviving record becomes ambiguous.
    const a = await makeCustomer();
    const b = await makeCustomer();
    const c = await makeCustomer();
    await mergeCustomers({ keepId: a.id, mergeId: b.id, reason: "first" }, ctx);

    await expect(
      mergeCustomers({ keepId: b.id, mergeId: c.id, reason: "second" }, ctx),
    ).rejects.toThrow(/itself a duplicate/i);
  });
});

describe("marketing consent", () => {
  it("excludes anyone who has not opted in", async () => {
    const silent = await makeCustomer({ email: "silent@x.com" });
    const optedIn = await makeCustomer({ email: "yes@x.com" });
    await upsertCustomerContact({ customerId: optedIn.id, marketingConsent: true }, ctx);

    const list = await marketableCustomers();
    expect(list.some((c) => c.id === optedIn.id)).toBe(true);
    // Never asked is not a yes.
    expect(list.some((c) => c.id === silent.id)).toBe(false);
  });

  it("lets suppression override an old opt-in", async () => {
    const c = await makeCustomer({ email: "was-in@x.com" });
    await upsertCustomerContact({ customerId: c.id, marketingConsent: true }, ctx);
    await upsertCustomerContact({ customerId: c.id, isSuppressed: true }, ctx);

    expect((await marketableCustomers()).some((x) => x.id === c.id)).toBe(false);
  });

  it("records when consent was given", async () => {
    const c = await makeCustomer();
    await upsertCustomerContact({ customerId: c.id, marketingConsent: true }, ctx);
    const after = await db.customer.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.consentRecordedAt).not.toBeNull();
  });

  it("audits a consent change", async () => {
    const c = await makeCustomer();
    await upsertCustomerContact({ customerId: c.id, marketingConsent: true }, ctx);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { action: "CUSTOMER_CONTACT_UPDATED", entityId: c.id },
    });
    expect(audit.after).toMatchObject({ marketingConsent: true });
  });
});
