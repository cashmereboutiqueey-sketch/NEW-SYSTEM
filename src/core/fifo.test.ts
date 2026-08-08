import { describe, it, expect } from "vitest";
import {
  consumeFifo,
  sortFifo,
  valuation,
  averageUnitCost,
  ageBucket,
  agingProfile,
  type Lot,
} from "./fifo";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function lot(over: Partial<Lot> & Pick<Lot, "id">): Lot {
  return {
    receivedDate: d("2026-01-01"),
    sequence: 0,
    remainingQty: "100",
    unitCost: "100",
    ...over,
  };
}

describe("FIFO ordering", () => {
  it("takes the oldest lot first", () => {
    const lots = [
      lot({ id: "new", receivedDate: d("2026-03-01"), unitCost: "200" }),
      lot({ id: "old", receivedDate: d("2026-01-01"), unitCost: "100" }),
    ];
    const r = consumeFifo(lots, "50");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.allocations[0].lotId).toBe("old");
      expect(r.totalCost.toString()).toBe("5000");
    }
  });

  it("breaks same-day ties by entry order, so the result is deterministic", () => {
    const lots = [
      lot({ id: "b", sequence: 2, unitCost: "150" }),
      lot({ id: "a", sequence: 1, unitCost: "100" }),
    ];
    expect(sortFifo(lots).map((l) => l.id)).toEqual(["a", "b"]);
    // Repeated runs must not drift.
    expect(sortFifo(lots).map((l) => l.id)).toEqual(sortFifo(lots).map((l) => l.id));
  });

  it("spans several lots when one is not enough", () => {
    const lots = [
      lot({ id: "l1", receivedDate: d("2026-01-01"), remainingQty: "30", unitCost: "100" }),
      lot({ id: "l2", receivedDate: d("2026-02-01"), remainingQty: "50", unitCost: "120" }),
      lot({ id: "l3", receivedDate: d("2026-03-01"), remainingQty: "40", unitCost: "150" }),
    ];
    const r = consumeFifo(lots, "100");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.allocations.map((a) => [a.lotId, a.quantity.toString()])).toEqual([
        ["l1", "30"], ["l2", "50"], ["l3", "20"],
      ]);
      // 30×100 + 50×120 + 20×150 = 3000 + 6000 + 3000
      expect(r.totalCost.toString()).toBe("12000");
      expect(r.totalQuantity.toString()).toBe("100");
    }
  });

  it("skips exhausted lots", () => {
    const lots = [
      lot({ id: "empty", receivedDate: d("2026-01-01"), remainingQty: "0" }),
      lot({ id: "full", receivedDate: d("2026-02-01"), remainingQty: "50" }),
    ];
    const r = consumeFifo(lots, "20");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.allocations.map((a) => a.lotId)).toEqual(["full"]);
  });

  it("values old stock at what it cost, never at today's price", () => {
    // The whole point of FIFO: a price rise does not restate what is on hand.
    const lots = [
      lot({ id: "cheap", receivedDate: d("2026-01-01"), remainingQty: "100", unitCost: "95" }),
      lot({ id: "dear", receivedDate: d("2026-06-01"), remainingQty: "100", unitCost: "112" }),
    ];
    const r = consumeFifo(lots, "100");
    if (r.ok) expect(r.totalCost.toString()).toBe("9500");
  });
});

describe("shortfall", () => {
  it("refuses rather than issuing a partial quantity", () => {
    // A partial issue would leave production believing it had material.
    const lots = [lot({ id: "l1", remainingQty: "40" })];
    const r = consumeFifo(lots, "100");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.shortfall.toString()).toBe("60");
      expect(r.available.toString()).toBe("40");
      expect(r.requested.toString()).toBe("100");
    }
  });

  it("refuses when there is no stock at all", () => {
    const r = consumeFifo([], "5");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.shortfall.toString()).toBe("5");
  });

  it("allows an exact draw-down to zero", () => {
    const lots = [lot({ id: "l1", remainingQty: "40" })];
    const r = consumeFifo(lots, "40");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.totalQuantity.toString()).toBe("40");
  });

  it("treats a zero request as a no-op", () => {
    const r = consumeFifo([lot({ id: "l1" })], "0");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.allocations).toEqual([]);
      expect(r.totalCost.toString()).toBe("0");
    }
  });
});

describe("fractional quantities", () => {
  it("handles metres to four decimal places without drift", () => {
    const lots = [
      lot({ id: "l1", receivedDate: d("2026-01-01"), remainingQty: "12.3456", unitCost: "168.75" }),
      lot({ id: "l2", receivedDate: d("2026-02-01"), remainingQty: "20", unitCost: "172.20" }),
    ];
    const r = consumeFifo(lots, "15.5");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.totalQuantity.toString()).toBe("15.5");
      // 12.3456×168.75 = 2083.3200, then 3.1544×172.20 = 543.1877
      expect(r.totalCost.toFixed(4)).toBe("2626.5077");
    }
  });

  it("keeps allocated quantity exactly equal to the request", () => {
    const lots = [
      lot({ id: "a", receivedDate: d("2026-01-01"), remainingQty: "0.1" }),
      lot({ id: "b", receivedDate: d("2026-01-02"), remainingQty: "0.2" }),
    ];
    const r = consumeFifo(lots, "0.3");
    expect(r.ok).toBe(true);
    // 0.1 + 0.2 === 0.3 exactly, which binary floats cannot promise.
    if (r.ok) expect(r.totalQuantity.toString()).toBe("0.3");
  });
});

describe("valuation", () => {
  it("values remaining stock at lot cost", () => {
    const lots = [
      lot({ id: "l1", remainingQty: "10", unitCost: "100" }),
      lot({ id: "l2", remainingQty: "5", unitCost: "120" }),
    ];
    expect(valuation(lots).toString()).toBe("1600");
  });

  it("reports the weighted average for information only", () => {
    const lots = [
      lot({ id: "l1", remainingQty: "10", unitCost: "100" }),
      lot({ id: "l2", remainingQty: "10", unitCost: "120" }),
    ];
    expect(averageUnitCost(lots)!.toString()).toBe("110");
  });

  it("returns no average when there is no stock, rather than zero", () => {
    expect(averageUnitCost([])).toBeNull();
    expect(averageUnitCost([lot({ id: "l1", remainingQty: "0" })])).toBeNull();
  });
});

describe("aging", () => {
  const asOf = d("2026-06-30");

  it("places lots in the right bucket", () => {
    expect(ageBucket(d("2026-06-20"), asOf)).toBe("0-30");
    expect(ageBucket(d("2026-05-20"), asOf)).toBe("31-60");
    expect(ageBucket(d("2026-04-20"), asOf)).toBe("61-90");
    expect(ageBucket(d("2026-01-20"), asOf)).toBe("90+");
  });

  it("puts a boundary day in the younger bucket", () => {
    expect(ageBucket(d("2026-05-31"), asOf)).toBe("0-30");
    expect(ageBucket(d("2026-05-30"), asOf)).toBe("31-60");
  });

  it("reports capital locked per bucket", () => {
    const lots = [
      lot({ id: "fresh", receivedDate: d("2026-06-15"), remainingQty: "10", unitCost: "100" }),
      lot({ id: "stale", receivedDate: d("2026-01-01"), remainingQty: "5", unitCost: "200" }),
    ];
    const profile = agingProfile(lots, asOf);
    expect(profile["0-30"].value.toString()).toBe("1000");
    expect(profile["90+"].value.toString()).toBe("1000");
    expect(profile["31-60"].quantity.toString()).toBe("0");
  });

  it("ignores exhausted lots, which lock up no capital", () => {
    const lots = [lot({ id: "gone", receivedDate: d("2026-01-01"), remainingQty: "0" })];
    expect(agingProfile(lots, asOf)["90+"].value.toString()).toBe("0");
  });
});
