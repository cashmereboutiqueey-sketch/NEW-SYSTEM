import "dotenv/config";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { setCustomerCredit, MasterDataError } from "./master-data";

/**
 * Giving a customer credit.
 *
 * The rule that a part-paid sale needs a limit behind it was enforced from the
 * first day; the limit could be set nowhere, so every customer stood at zero
 * and every deposit was refused. These cover the half that was missing.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const CODE = "CREDIT-TEST-CUSTOMER";
const ctx = { userId: null as string | null, reason: null };
let customerId: string;

beforeEach(async () => {
  await db.customer.deleteMany({ where: { code: CODE } });
  customerId = (
    await db.customer.create({ data: { code: CODE, name: "Credit fixture" } })
  ).id;
});

afterAll(async () => {
  await db.customer.deleteMany({ where: { code: CODE } });
  await db.$disconnect();
});

describe("a customer's credit", () => {
  it("starts at nothing, which is cash in full", async () => {
    const customer = await db.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(Number(customer.creditLimit)).toBe(0);
    expect(customer.creditDays).toBe(0);
  });

  it("is granted with terms, and both are recorded", async () => {
    await setCustomerCredit({ customerId, creditLimit: 5000, creditDays: 14 }, ctx);

    const customer = await db.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(Number(customer.creditLimit)).toBe(5000);
    expect(customer.creditDays).toBe(14);
  });

  it("leaves what it was in the trail, because a bad debt asks who allowed it", async () => {
    await setCustomerCredit({ customerId, creditLimit: 5000, creditDays: 14 }, ctx);
    await setCustomerCredit({ customerId, creditLimit: 12000, creditDays: 30 }, ctx);

    const entry = await db.auditLog.findFirst({
      where: { entityId: customerId, action: "CUSTOMER_CREDIT_SET" },
      orderBy: { createdAt: "desc" },
    });
    expect(entry).not.toBeNull();
    expect(JSON.stringify(entry?.before)).toContain("5000");
    expect(JSON.stringify(entry?.after)).toContain("12000");
  });

  it("refuses a negative limit rather than storing a debt the shop owes", async () => {
    await expect(
      setCustomerCredit({ customerId, creditLimit: -1, creditDays: 0 }, ctx),
    ).rejects.toThrow(MasterDataError);

    const customer = await db.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(Number(customer.creditLimit)).toBe(0);
  });

  it("refuses part of a day", async () => {
    await expect(
      setCustomerCredit({ customerId, creditLimit: 100, creditDays: 2.5 }, ctx),
    ).rejects.toThrow(/whole days/i);
  });
});
