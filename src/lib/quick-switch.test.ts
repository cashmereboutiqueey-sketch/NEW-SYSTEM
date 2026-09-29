import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "@/core/password";
import { authenticateCashierPin } from "./quick-switch";

const fixture = vi.hoisted(() => ({
  user: {
    id: "cashier-1", role: "POS_CASHIER", isActive: true,
    mustChangePassword: false, quickPinHash: "", failedQuickPins: 0,
    quickPinLockedUntil: null as Date | null, sessionVersion: 4,
  },
}));

vi.mock("./db", () => ({
  db: {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === fixture.user.id ? fixture.user : null,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(fixture.user, data);
        return fixture.user;
      },
    },
  },
}));

beforeAll(async () => {
  fixture.user.quickPinHash = await hashPassword("604281");
});

beforeEach(() => {
  fixture.user.isActive = true;
  fixture.user.mustChangePassword = false;
  fixture.user.failedQuickPins = 0;
  fixture.user.quickPinLockedUntil = null;
});

describe("cashier quick switch", () => {
  it("accepts the personal PIN and clears previous failures", async () => {
    fixture.user.failedQuickPins = 2;
    await expect(authenticateCashierPin("cashier-1", "604281"))
      .resolves.toEqual({ userId: "cashier-1", sessionVersion: 4 });
    expect(fixture.user.failedQuickPins).toBe(0);
  });

  it("locks a PIN after five wrong guesses, including the right PIN until the lock expires", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(authenticateCashierPin("cashier-1", "111111"))
        .rejects.toThrow(/wrong PIN/i);
    }
    expect(fixture.user.quickPinLockedUntil?.getTime()).toBeGreaterThan(Date.now());
    await expect(authenticateCashierPin("cashier-1", "604281"))
      .rejects.toThrow(/wrong PIN/i);
  }, 15_000);

  it("does not switch to a deactivated account", async () => {
    fixture.user.isActive = false;
    await expect(authenticateCashierPin("cashier-1", "604281"))
      .rejects.toThrow(/wrong PIN/i);
  });
});
