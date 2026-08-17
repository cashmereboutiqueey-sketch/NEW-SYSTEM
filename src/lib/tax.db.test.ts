import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import {
  effectiveRate, taxStatus, taxRates, addTaxRate, vatPosition, setVatRegistered, TaxError,
} from "./tax";

/**
 * VAT, and the reason it is switched off.
 *
 * Rates are effective-dated and never edited: a posting made last year was
 * made at last year's rate, and rewriting the rate would restate it.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let ownerId: string;
const ctx = () => ({ userId: ownerId, reason: null });

const TEST_CODE = "VAT-TEST";

beforeAll(async () => {
  ownerId = (await db.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
});

beforeEach(async () => {
  await db.taxRate.deleteMany({ where: { code: TEST_CODE } });
  // Left as the seed has it, so the demo is not changed by running tests.
  await db.setting.updateMany({ where: { key: "vat.registered" }, data: { value: "false" } });
  await db.setting.updateMany({
    where: { key: "vat.defaultRateCode" },
    data: { value: "VAT-EXEMPT" },
  });
});

afterAll(async () => {
  await db.taxRate.deleteMany({ where: { code: TEST_CODE } });
  await db.setting.updateMany({ where: { key: "vat.registered" }, data: { value: "false" } });
  await db.setting.updateMany({
    where: { key: "vat.defaultRateCode" },
    data: { value: "VAT-EXEMPT" },
  });
  await db.$disconnect();
});

const on = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const add = (rate: number, from: string) =>
  addTaxRate(
    { code: TEST_CODE, nameAr: "ضريبة اختبار", nameEn: "Test VAT", rate, effectiveFrom: on(from) },
    ctx(),
  );

describe("the rate in force", () => {
  it("finds the one covering the day", async () => {
    await add(0.14, "2020-01-01");

    const found = await effectiveRate(TEST_CODE, on("2023-06-15"));
    expect(Number(found?.rate)).toBeCloseTo(0.14, 6);
  });

  it("reports nothing rather than zero when no rate covers the day", async () => {
    await add(0.14, "2020-01-01");

    // Zero would post a sale as exempt because somebody forgot to extend a
    // rate, and nothing would say so.
    expect(await effectiveRate(TEST_CODE, on("2019-12-31"))).toBeNull();
  });

  it("reports nothing for a code that does not exist", async () => {
    expect(await effectiveRate("NOPE")).toBeNull();
  });

  it("finds the seeded Egyptian rate", async () => {
    const found = await effectiveRate("VAT-EG", on("2026-01-01"));
    expect(Number(found?.rate)).toBeCloseTo(0.14, 6);
  });
});

describe("when a rate changes", () => {
  it("closes the old row instead of editing it", async () => {
    await add(0.10, "2020-01-01");
    const result = await add(0.14, "2024-01-01");

    expect(result.supersededPrevious).toBe(true);

    // The old posting's rate is still 10% and always will be.
    expect(Number((await effectiveRate(TEST_CODE, on("2022-05-01")))?.rate)).toBeCloseTo(0.10, 6);
    expect(Number((await effectiveRate(TEST_CODE, on("2025-05-01")))?.rate)).toBeCloseTo(0.14, 6);
  });

  it("ends the old rate the day before the new one starts, leaving no gap", async () => {
    await add(0.10, "2020-01-01");
    await add(0.14, "2024-01-01");

    // The last day of the old rate and the first of the new one are
    // consecutive: no day falls through.
    expect(Number((await effectiveRate(TEST_CODE, on("2023-12-31")))?.rate)).toBeCloseTo(0.10, 6);
    expect(Number((await effectiveRate(TEST_CODE, on("2024-01-01")))?.rate)).toBeCloseTo(0.14, 6);
  });

  it("refuses two rates starting the same day", async () => {
    await add(0.14, "2024-01-01");
    await expect(add(0.15, "2024-01-01")).rejects.toThrow(TaxError);
  });

  it("refuses a rate given as a percentage", async () => {
    // 14 would be a 1,400% tax.
    await expect(add(14, "2024-01-01")).rejects.toThrow(/fraction/i);
  });

  it("keeps both rows visible, marking which is current", async () => {
    await add(0.10, "2020-01-01");
    await add(0.14, "2024-01-01");

    const rows = (await taxRates()).filter((r) => r.code === TEST_CODE);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.current)).toHaveLength(1);
    expect(Number(rows.find((r) => r.current)!.rate)).toBeCloseTo(0.14, 6);
  });
});

describe("whether anything is charged at all", () => {
  it("charges nothing while unregistered, whatever the default says", async () => {
    await db.setting.updateMany({
      where: { key: "vat.defaultRateCode" },
      data: { value: "VAT-EG" },
    });

    const status = await taxStatus();

    // Being registered is what creates the obligation, not which code is
    // selected. A system charging VAT it does not owe is worse than one
    // charging none.
    expect(status.registered).toBe(false);
    expect(Number(status.applicable)).toBe(0);
    expect(Number(status.rate?.rate)).toBeCloseTo(0.14, 6);
  });

  it("applies the rate once registration is switched on", async () => {
    await db.setting.updateMany({
      where: { key: "vat.defaultRateCode" },
      data: { value: "VAT-EG" },
    });
    await setVatRegistered(true, ctx());

    const status = await taxStatus();
    expect(status.registered).toBe(true);
    expect(Number(status.applicable)).toBeCloseTo(0.14, 6);
  });

  it("says so when the default names a code with no rate", async () => {
    await db.setting.updateMany({
      where: { key: "vat.defaultRateCode" },
      data: { value: "DOES-NOT-EXIST" },
    });

    const status = await taxStatus();
    expect(status.misconfigured).toBe(true);
    expect(Number(status.applicable)).toBe(0);
  });

  it("records the day the obligation changed", async () => {
    await setVatRegistered(true, ctx());

    const log = await db.auditLog.findFirst({
      where: { action: "VAT_REGISTRATION_CHANGED" },
      orderBy: { createdAt: "desc" },
    });

    // The day this flips is the day the business's obligations change, and
    // that date has to be findable afterwards.
    expect((log?.before as { registered: string }).registered).toBe("false");
    expect((log?.after as { registered: string }).registered).toBe("true");
  });
});

describe("what would be owed", () => {
  it("is zero on both sides while nothing has been charged", async () => {
    const position = await vatPosition(on("2020-01-01"), on("2030-01-01"));

    expect(Number(position.outputVat)).toBe(0);
    expect(Number(position.inputVat)).toBe(0);
    expect(Number(position.net)).toBe(0);
  });

  it("reads the two accounts that already exist for it", async () => {
    // Both are in every install from the first migration, waiting.
    const accounts = await db.account.findMany({
      where: { code: { in: ["1450", "2300"] } },
      select: { code: true, type: true },
    });

    expect(accounts).toHaveLength(2);
    expect(accounts.find((a) => a.code === "1450")?.type).toBe("ASSET");
    expect(accounts.find((a) => a.code === "2300")?.type).toBe("LIABILITY");
  });
});
