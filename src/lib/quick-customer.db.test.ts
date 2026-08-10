import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { createCustomer } from "./master-data";
import { normalisePhone } from "@/core/crm";

/**
 * Adding a customer at the till, mid-queue.
 *
 * A queue is exactly where duplicate customer records are made: the cashier
 * cannot leave the screen to check, so they type the name again and somebody's
 * history splits in two — along with their credit limit and everything owed.
 *
 * These cover the lookup the till does before creating. The rule the codebase
 * already settled is that a matching phone is *flagged*, never merged, because
 * a shared family phone is common; the till follows it by offering the match
 * and letting the cashier say who it is.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const ctx = { userId: null as string | null, reason: null };

beforeAll(async () => {
  await db.customer.deleteMany({ where: { code: { startsWith: "QC-" } } });
});

beforeEach(async () => {
  await db.customer.deleteMany({ where: { name: { startsWith: "QuickTest" } } });
});

afterAll(async () => {
  await db.customer.deleteMany({ where: { name: { startsWith: "QuickTest" } } });
  await db.$disconnect();
});

/** What the till's action does before deciding to create. */
async function findByPhone(phone: string) {
  const normalised = normalisePhone(phone);
  if (!normalised) return null;
  return db.customer.findFirst({
    where: { phoneNormalised: normalised, mergedIntoId: null, isActive: true },
    select: { id: true, name: true, phone: true, code: true },
    orderBy: { createdAt: "asc" },
  });
}

describe("recognising somebody who is already known", () => {
  it("finds them however the number was written the first time", async () => {
    const { customer } = await createCustomer(
      { name: "QuickTest سلمى", phone: "01012345678" } as never,
      ctx,
    );

    // The same line, four ways somebody might type it at a counter.
    for (const typed of [
      "01012345678",
      "+201012345678",
      "00201012345678",
      "0101 234 5678",
    ]) {
      const found = await findByPhone(typed);
      expect(found?.id).toBe(customer.id);
    }
  });

  it("does not match a different number", async () => {
    await createCustomer({ name: "QuickTest نور", phone: "01099999999" } as never, ctx);
    expect(await findByPhone("01088888888")).toBeNull();
  });

  it("has nothing to match when no number was given", async () => {
    expect(await findByPhone("")).toBeNull();
    expect(await findByPhone("123")).toBeNull();
  });

  it("ignores somebody who has been merged away", async () => {
    const { customer: keeper } = await createCustomer(
      { name: "QuickTest الأصل", phone: "01055555555" } as never, ctx,
    );
    const { customer: dupe } = await createCustomer(
      { name: "QuickTest المكرر", phone: "01055555555" } as never, ctx,
    );
    await db.customer.update({
      where: { id: dupe.id },
      data: { mergedIntoId: keeper.id },
    });

    // The record that survived is the one the till should offer.
    const found = await findByPhone("01055555555");
    expect(found?.id).toBe(keeper.id);
  });

  it("offers the oldest record when two share a line", async () => {
    const first = await createCustomer(
      { name: "QuickTest الأم", phone: "01077777777" } as never, ctx,
    );
    await createCustomer(
      { name: "QuickTest البنت", phone: "01077777777" } as never, ctx,
    );

    // Both are real people on a family phone. The till shows one and lets the
    // cashier say it is somebody else.
    expect((await findByPhone("01077777777"))?.id).toBe(first.customer.id);
  });
});

describe("creating one at the counter", () => {
  it("invents a code, because nobody should have to mid-queue", async () => {
    const { customer } = await createCustomer(
      { name: "QuickTest بدون كود", phone: "01011112222" } as never,
      ctx,
    );
    expect(customer.code).toMatch(/^CUST-\d{5}$/);
  });

  it("records where they walked in", async () => {
    const { customer } = await createCustomer(
      { name: "QuickTest بازار", phone: "01033334444", acquiredVia: "EXHIBITION" } as never,
      ctx,
    );
    // A bazaar customer is not a showroom customer, and acquisition reporting
    // is worthless if every walk-in looks the same.
    expect(customer.acquiredVia).toBe("EXHIBITION");
  });

  it("stores the number in a form the next lookup will find", async () => {
    const { customer } = await createCustomer(
      { name: "QuickTest تنسيق", phone: "+20 101 555 6677" } as never,
      ctx,
    );
    expect(customer.phoneNormalised).toBe("01015556677");
    expect(await findByPhone("01015556677")).toBeTruthy();
  });

  it("flags the clash rather than refusing a real customer", async () => {
    await createCustomer({ name: "QuickTest أول", phone: "01066667777" } as never, ctx);
    const second = await createCustomer(
      { name: "QuickTest تاني", phone: "01066667777" } as never, ctx,
    );

    expect(second.customer.id).toBeTruthy();
    expect(second.possibleDuplicate?.name).toBe("QuickTest أول");
  });

  it("takes somebody with no phone at all", async () => {
    const { customer } = await createCustomer(
      { name: "QuickTest من غير رقم" } as never, ctx,
    );
    expect(customer.phoneNormalised).toBeNull();
  });
});
