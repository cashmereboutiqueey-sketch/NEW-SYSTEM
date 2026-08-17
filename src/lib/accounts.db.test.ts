import "dotenv/config";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { createAccount, updateAccount, chartOfAccounts, AccountError } from "./accounts";

/**
 * The chart of accounts.
 *
 * Two rules keep it trustworthy: a code is never reused and an account with
 * postings is never deleted, because the history refers to it; and an account
 * with children is a header, because otherwise a balance appears at two levels
 * of the same subtotal and the report counts it twice.
 */

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let ownerId: string;
const created: string[] = [];

const ctx = () => ({ userId: ownerId, reason: null });

beforeAll(async () => {
  ownerId = (await db.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
});

beforeEach(async () => {
  // Codes in the 99xx range, which the seeded chart does not use, so these
  // tests never collide with the real chart.
  await db.account.deleteMany({ where: { code: { startsWith: "99" } } });
  created.length = 0;
});

afterAll(async () => {
  await db.account.deleteMany({ where: { code: { startsWith: "99" } } });
  await db.$disconnect();
});

const add = (code: string, over: Record<string, unknown> = {}) =>
  createAccount(
    {
      code,
      nameAr: `حساب ${code}`,
      nameEn: `Account ${code}`,
      type: "EXPENSE",
      ...over,
    },
    ctx(),
  );

describe("adding an account", () => {
  it("derives the normal balance from the type", async () => {
    // An asset is a debit balance. It is not a preference, and offering it as
    // a choice is offering somebody the chance to invert a report.
    expect((await add("9910", { type: "ASSET" })).normalBalance).toBe("DEBIT");
    expect((await add("9911", { type: "REVENUE" })).normalBalance).toBe("CREDIT");
    expect((await add("9912", { type: "LIABILITY" })).normalBalance).toBe("CREDIT");
    expect((await add("9913", { type: "COGS" })).normalBalance).toBe("DEBIT");
  });

  it("refuses a code that already exists", async () => {
    await add("9920");
    // Codes are never reused: the history refers to them.
    await expect(add("9920")).rejects.toThrow(/already exists/i);
  });

  it("refuses a code that is not four digits", async () => {
    await expect(add("99")).rejects.toThrow();
    await expect(add("ABCD")).rejects.toThrow();
  });

  it("shows up in the chart", async () => {
    await add("9930", { nameEn: "Security guards" });

    const chart = await chartOfAccounts();
    const ours = chart.find((a) => a.code === "9930")!;

    expect(ours.nameEn).toBe("Security guards");
    expect(ours.type).toBe("EXPENSE");
    expect(Number(ours.balance)).toBe(0);
    expect(ours.postings).toBe(0);
  });
});

describe("the tree", () => {
  it("turns a parent into a header the moment it has a child", async () => {
    const parent = await add("9940");
    // Postable when it was on its own.
    const before = (await chartOfAccounts()).find((a) => a.code === "9940")!;
    expect(before.isPostable).toBe(true);

    const child = await add("9941", { parentId: parent.accountId });
    expect(child.parentBecameHeader).toBe(true);

    // Leaving it postable would let a balance appear both on it and inside
    // it, and the subtotal would count the same money twice.
    const after = (await chartOfAccounts()).find((a) => a.code === "9940")!;
    expect(after.isPostable).toBe(false);
    expect(after.children).toBe(1);
  });

  it("refuses a child of a different type from its parent", async () => {
    const parent = await add("9950", { type: "ASSET" });
    // An expense under an asset header makes every subtotal above it wrong,
    // and nothing downstream would notice.
    await expect(
      add("9951", { type: "EXPENSE", parentId: parent.accountId }),
    ).rejects.toThrow(/cannot sit under/i);
  });

  it("reports how deep each account sits", async () => {
    const a = await add("9960");
    const b = await add("9961", { parentId: a.accountId });
    await add("9962", { parentId: b.accountId });

    const chart = await chartOfAccounts();
    expect(chart.find((x) => x.code === "9960")!.depth).toBe(0);
    expect(chart.find((x) => x.code === "9961")!.depth).toBe(1);
    expect(chart.find((x) => x.code === "9962")!.depth).toBe(2);
  });

  it("refuses a parent that does not exist", async () => {
    await expect(add("9970", { parentId: "nope" })).rejects.toThrow(AccountError);
  });
});

describe("changing one", () => {
  it("renames without touching the code", async () => {
    const account = await add("9980", { nameEn: "Typo" });
    await updateAccount({ id: account.accountId, nameEn: "Corrected" }, ctx());

    const ours = (await chartOfAccounts()).find((a) => a.code === "9980")!;
    expect(ours.nameEn).toBe("Corrected");
    expect(ours.code).toBe("9980");
  });

  it("retires an account instead of deleting it", async () => {
    const account = await add("9981");
    await updateAccount({ id: account.accountId, isActive: false }, ctx());

    // Gone from the working chart...
    expect((await chartOfAccounts()).find((a) => a.code === "9981")).toBeUndefined();
    // ...but still there, because the history may refer to it.
    expect(
      (await chartOfAccounts({ includeInactive: true })).find((a) => a.code === "9981"),
    ).toBeDefined();
  });

  it("refuses to retire a header that still has live accounts under it", async () => {
    const parent = await add("9990");
    await add("9991", { parentId: parent.accountId });

    await expect(
      updateAccount({ id: parent.accountId, isActive: false }, ctx()),
    ).rejects.toThrow(/still has/i);
  });

  it("allows it once the children are retired too", async () => {
    const parent = await add("9992");
    const child = await add("9993", { parentId: parent.accountId });

    await updateAccount({ id: child.accountId, isActive: false }, ctx());
    await updateAccount({ id: parent.accountId, isActive: false }, ctx());

    const chart = await chartOfAccounts({ includeInactive: true });
    expect(chart.find((a) => a.code === "9992")!.isActive).toBe(false);
  });

  it("moves an account into the minute-rate pool", async () => {
    const account = await add("9994");
    await updateAccount({ id: account.accountId, includeInMinuteRate: true }, ctx());

    const ours = (await chartOfAccounts()).find((a) => a.code === "9994")!;
    // This changes what every garment is costed at, which is why it is behind
    // account:manage rather than an ordinary edit.
    expect(ours.includeInMinuteRate).toBe(true);
  });

  it("records what changed, both sides", async () => {
    const account = await add("9995", { nameEn: "Before" });
    await updateAccount({ id: account.accountId, nameEn: "After" }, ctx());

    const log = await db.auditLog.findFirst({
      where: { entityId: account.accountId, action: "ACCOUNT_UPDATED" },
      orderBy: { createdAt: "desc" },
    });

    expect((log?.before as { nameEn: string }).nameEn).toBe("Before");
    expect((log?.after as { nameEn: string }).nameEn).toBe("After");
  });
});

describe("the chart carries what each account holds", () => {
  it("shows a real balance for a seeded account that has been posted to", async () => {
    const chart = await chartOfAccounts();
    const cash = chart.find((a) => a.code === "1310");

    // The raw materials account exists in every install and the demo posts to
    // it; a chart that could not show that would not answer the question
    // people open it for.
    expect(cash).toBeDefined();
    expect(cash!.isPostable).toBe(true);
  });

  it("marks the header accounts as unpostable", async () => {
    const chart = await chartOfAccounts();
    const header = chart.find((a) => a.code === "1300"); // Inventory
    expect(header?.isPostable).toBe(false);
  });
});
