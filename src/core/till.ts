/**
 * Which till a person is standing at, and which they may not touch.
 *
 * One drawer takes one shift. That is the rule the whole thing turns on: a
 * difference between what was counted in and what was counted out has to have
 * exactly one name against it, and it stops meaning anything the moment two
 * people have been in the same drawer.
 *
 * Pure, because getting it wrong is silent in two directions. Hand somebody
 * a till that is not theirs and they build a basket and are refused with the
 * customer standing there. Hide a till from whoever is meant to count it and
 * the shop cannot close for the night.
 */

export type OpenTill = {
  locationId: string;
  cashierUserId: string;
};

export type ShiftView<T> = {
  /** The one to sell on, or to count. Null when this person has neither. */
  use: T | null;
  /** Somebody else's, when that is why `use` is null. Null otherwise. */
  blockedBy: T | null;
};

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
 * Everybody else gets nothing and is told whose it is, which is the part that
 * was missing: the refusal used to arrive at the moment of sale.
 */
export function shiftFor<T extends OpenTill>(
  open: T[],
  userId: string,
  mayClose: boolean,
): ShiftView<T> {
  const mine = open.find((t) => t.cashierUserId === userId) ?? null;
  if (mine) return { use: mine, blockedBy: null };

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
