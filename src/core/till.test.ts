import { describe, it, expect } from "vitest";
import { shiftFor, locationsFree } from "./till";

/** One drawer, one shift, and being told so before a basket is built. */

const hager = "u-hager";
const ahmed = "u-ahmed";

const alexandria = { locationId: "loc-alex", cashierUserId: hager, sessionNumber: "TILL-1" };
const market = { locationId: "loc-market", cashierUserId: ahmed, sessionNumber: "TILL-2" };

describe("which till somebody is standing at", () => {
  it("gives a cashier their own, wherever it is", () => {
    const view = shiftFor([market, alexandria], hager, false);
    expect(view.use?.sessionNumber).toBe("TILL-1");
    expect(view.blockedBy).toBeNull();
  });

  it("gives a cashier nothing when the only drawer is somebody else's", () => {
    const view = shiftFor([market], hager, false);
    expect(view.use).toBeNull();
    // Named, so the screen can say whose rather than refusing at the moment of
    // sale with the customer standing there.
    expect(view.blockedBy?.sessionNumber).toBe("TILL-2");
  });

  it("gives whoever counts the drawer the one that is open, whosever it is", () => {
    // The accountant never sells. Closing somebody else's till at the end of
    // their shift is the entire reason they open this screen.
    const view = shiftFor([alexandria], ahmed, true);
    expect(view.use?.sessionNumber).toBe("TILL-1");
    expect(view.blockedBy).toBeNull();
  });

  it("still prefers their own to somebody else's, even for a supervisor", () => {
    const view = shiftFor([alexandria, market], ahmed, true);
    expect(view.use?.sessionNumber).toBe("TILL-2");
  });

  it("gives nobody anything when no drawer is open", () => {
    expect(shiftFor([], hager, false)).toEqual({ use: null, blockedBy: null });
    expect(shiftFor([], ahmed, true)).toEqual({ use: null, blockedBy: null });
  });
});

describe("where a till may be started", () => {
  const locations = [{ id: "loc-alex" }, { id: "loc-market" }, { id: "loc-bazaar" }];

  it("offers only the counters with no drawer open", () => {
    expect(locationsFree(locations, [alexandria]).map((l) => l.id)).toEqual([
      "loc-market",
      "loc-bazaar",
    ]);
  });

  it("offers everything when nothing is open", () => {
    expect(locationsFree(locations, [])).toHaveLength(3);
  });

  it("offers nothing when every counter is taken", () => {
    expect(locationsFree(locations, [alexandria, market, { ...market, locationId: "loc-bazaar" }]))
      .toEqual([]);
  });

  it("does not care whose the open drawer is — one drawer is one drawer", () => {
    expect(locationsFree(locations, [alexandria]).map((l) => l.id)).not.toContain("loc-alex");
  });
});
