/**
 * Which till a person is standing at, and which they may not touch.
 *
 * One drawer takes one shift. A supervisor may share that shift with other
 * signed-in cashiers; the sale keeps the actual cashier's name, while a cash
 * variance belongs to the shared drawer and must be investigated as a team.
 *
 * Pure, because getting it wrong is silent in two directions. Hand somebody
 * a till that is not theirs and they build a basket and are refused with the
 * customer standing there. Hide a till from whoever is meant to count it and
 * the shop cannot close for the night.
 */

export type OpenTill = {
  locationId: string;
  cashierUserId: string;
  sharedWithCashiers?: boolean;
};

export type ShiftView<T> = {
  /** The one to sell on, or to count. Null when this person has neither. */
  use: T | null;
  /** Somebody else's, when that is why `use` is null. Null otherwise. */
  blockedBy: T | null;
};

/** Same rule for choosing a till and for accepting the sale at checkout. */
export function mayWorkTill(
  till: OpenTill,
  userId: string,
  mayClose: boolean,
  isCashier: boolean,
): boolean {
  return till.cashierUserId === userId || mayClose ||
    (isCashier && till.sharedWithCashiers === true);
}

/**
 * Sorts the open tills into the one this person works with.
 *
 * Their own comes first wherever it is, so a cashier who reloads the screen
 * lands back in their own shift rather than being asked to open another.
 *
 * Failing that, whoever may close a drawer gets whichever is open, whosever
 * name is on it — counting somebody else's till at the end of their shift is
 * the entire reason that right exists.
 *
 * A cashier may use a supervisor-shared drawer. Everybody else gets nothing
 * and is told whose it is, before a basket is built.
 */
export function shiftFor<T extends OpenTill>(
  open: T[],
  userId: string,
  mayClose: boolean,
  maySellOnShared = false,
): ShiftView<T> {
  const mine = open.find((t) => t.cashierUserId === userId) ?? null;
  if (mine) return { use: mine, blockedBy: null };

  const shared = maySellOnShared
    ? open.find((t) => mayWorkTill(t, userId, false, true)) ?? null : null;
  if (shared) return { use: shared, blockedBy: null };

  const other = open[0] ?? null;
  if (mayClose && other) return { use: other, blockedBy: null };

  return { use: null, blockedBy: other };
}

/**
 * Where a till may be started.
 *
 * Only where none is open, because the drawer is the thing being opened and
 * there is one of it. A shop with a second branch free is worth saying so to:
 * being blocked at one counter does not mean being blocked.
 */
export function locationsFree<L extends { id: string }>(
  locations: L[],
  open: OpenTill[],
): L[] {
  return locations.filter((l) => !open.some((t) => t.locationId === l.id));
}
