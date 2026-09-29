import "server-only";
import { db } from "./db";
import { verifyPassword, IMPOSSIBLE_HASH } from "@/core/password";

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

export class QuickSwitchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuickSwitchError";
  }
}

/** Only ready cashier accounts can appear on the shared register. */
export async function quickSwitchCashiers(): Promise<{ id: string; name: string }[]> {
  return db.user.findMany({
    where: {
      role: "POS_CASHIER",
      isActive: true,
      mustChangePassword: false,
      quickPinHash: { not: null },
    },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

/** A PIN proves the operator's identity; it never grants a role on its own. */
export async function authenticateCashierPin(
  userId: string,
  pin: string,
): Promise<{ userId: string; sessionVersion: number }> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true, role: true, isActive: true, mustChangePassword: true,
      quickPinHash: true, failedQuickPins: true, quickPinLockedUntil: true,
      sessionVersion: true,
    },
  });
  const invalid = new QuickSwitchError("Wrong PIN or unavailable cashier account.");
  if (!user || user.role !== "POS_CASHIER" || !user.isActive
    || user.mustChangePassword || !user.quickPinHash) {
    await verifyPassword(pin, IMPOSSIBLE_HASH);
    throw invalid;
  }
  if (user.quickPinLockedUntil && user.quickPinLockedUntil > new Date()) {
    await verifyPassword(pin, user.quickPinHash);
    throw invalid;
  }

  const ok = /^[0-9]{6}$/.test(pin) && await verifyPassword(pin, user.quickPinHash);
  if (!ok) {
    const failures = user.failedQuickPins + 1;
    await db.user.update({
      where: { id: user.id },
      data: {
        failedQuickPins: failures,
        quickPinLockedUntil: failures >= MAX_FAILURES
          ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
      },
    });
    throw invalid;
  }

  await db.user.update({
    where: { id: user.id },
    data: { failedQuickPins: 0, quickPinLockedUntil: null, lastLoginAt: new Date() },
  });
  return { userId: user.id, sessionVersion: user.sessionVersion };
}
