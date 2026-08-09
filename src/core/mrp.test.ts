import { describe, it, expect } from "vitest";
import {
  roundToPurchasable,
  planRequirements,
  checkCapacity,
  belowReorderPoint,
  type MaterialPosition,
} from "./mrp";
import { dec } from "@/lib/money";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const asOf = d("2026-08-09");

function position(over: Partial<MaterialPosition> = {}): MaterialPosition {
  return {
    materialId: "m1",
    materialCode: "FAB-JER-180",
    materialNameEn: "Cotton jersey",
    materialNameAr: "جيرسيه قطن",
    uom: "M",
    required: dec(600),
    onHand: dec(100),
    onOrder: dec(0),
    safetyStock: dec(0),
    leadTimeDays: 14,
    moq: null,
    packSize: null,
    unitCost: dec(172.2),
    ...over,
  };
}

describe("rounding to something a supplier will sell", () => {
  it("leaves a shortfall alone when there is no constraint", () => {
    const r = roundToPurchasable(dec(420), null, null);
    expect(r.quantity.toString()).toBe("420");
    expect(r.reason).toBeNull();
  });

  it("raises a small order to the minimum and says why", () => {
    // The specification's own example: the run needs 42 metres, the roll is 100.
    const r = roundToPurchasable(dec(42), 100, null);
    expect(r.quantity.toString()).toBe("100");
    expect(r.reason).toBe("MOQ");
  });

  it("rounds up to whole packs", () => {
    const r = roundToPurchasable(dec(120), null, 50);
    expect(r.quantity.toString()).toBe("150");
    expect(r.reason).toBe("PACK_SIZE");
  });

  it("applies the minimum first, then whole packs on top", () => {
    // 42 short, minimum 100, sold in 30s → 120.
    const r = roundToPurchasable(dec(42), 100, 30);
    expect(r.quantity.toString()).toBe("120");
    // The minimum is the more surprising rule, so it keeps the explanation.
    expect(r.reason).toBe("MOQ");
  });

  it("does not round an exact multiple of the pack size", () => {
    const r = roundToPurchasable(dec(150), null, 50);
    expect(r.quantity.toString()).toBe("150");
    expect(r.reason).toBeNull();
  });

  it("suggests nothing when there is no shortfall", () => {
    expect(roundToPurchasable(dec(0), 100, 50).quantity.toString()).toBe("0");
    expect(roundToPurchasable(dec(-40), 100, 50).quantity.toString()).toBe("0");
  });
});

describe("planning requirements", () => {
  it("counts stock and open orders as available", () => {
    const [s] = planRequirements(
      [position({ required: dec(600), onHand: dec(100), onOrder: dec(200) })],
      { asOf },
    );
    expect(s.shortfall.toString()).toBe("300");
    expect(s.suggestedQty.toString()).toBe("300");
  });

  it("keeps safety stock out of what can be planned against", () => {
    // 100 on hand but 40 held back leaves 60 usable.
    const [s] = planRequirements(
      [position({ required: dec(200), onHand: dec(100), safetyStock: dec(40) })],
      { asOf },
    );
    expect(s.shortfall.toString()).toBe("140");
  });

  it("suggests nothing when stock already covers the plan", () => {
    const suggestions = planRequirements(
      [position({ required: dec(80), onHand: dec(500) })],
      { asOf },
    );
    expect(suggestions).toEqual([]);
  });

  it("costs the suggestion at the material's landed cost", () => {
    const [s] = planRequirements(
      [position({ required: dec(600), onHand: dec(100), unitCost: dec(172.2) })],
      { asOf },
    );
    expect(s.estimatedCost.toString()).toBe("86100");
  });

  it("works back from when the material is wanted", () => {
    const [s] = planRequirements(
      [position({ leadTimeDays: 14 })],
      { asOf, needBy: d("2026-09-01") },
    );
    // Fourteen days before the first of September.
    expect(s.orderBy?.toISOString().slice(0, 10)).toBe("2026-08-18");
  });

  it("reports an order date already past as overdue", () => {
    const [s] = planRequirements(
      [position({ leadTimeDays: 30 })],
      { asOf, needBy: d("2026-08-20") },
    );
    // Thirty days before 20 August is 21 July, already gone.
    expect(s.urgency).toBe("OVERDUE");
  });

  it("marks an order due within the week as urgent", () => {
    const [s] = planRequirements(
      [position({ leadTimeDays: 14 })],
      { asOf, needBy: d("2026-08-27") },
    );
    expect(s.urgency).toBe("URGENT");
  });

  it("puts the most pressing shortfalls first", () => {
    const suggestions = planRequirements(
      [
        position({ materialId: "later", materialCode: "LATER", leadTimeDays: 2 }),
        position({ materialId: "overdue", materialCode: "OVERDUE", leadTimeDays: 60 }),
      ],
      { asOf, needBy: d("2026-08-25") },
    );
    expect(suggestions[0].materialCode).toBe("OVERDUE");
  });

  it("orders equally urgent items by what they cost", () => {
    const suggestions = planRequirements(
      [
        position({ materialId: "cheap", materialCode: "CHEAP", unitCost: dec(10) }),
        position({ materialId: "dear", materialCode: "DEAR", unitCost: dec(500) }),
      ],
      { asOf },
    );
    expect(suggestions[0].materialCode).toBe("DEAR");
  });
});

describe("capacity", () => {
  it("checks a run against what is actually left", () => {
    const c = checkCapacity({
      productiveMinutes: 239616,
      alreadyBookedMinutes: 100000,
      minutesRequired: 80000,
    });
    expect(c.minutesFree.toString()).toBe("139616");
    expect(c.fits).toBe(true);
    expect(c.shortfallMinutes.toString()).toBe("0");
  });

  it("reports how much capacity is missing when a run does not fit", () => {
    const c = checkCapacity({
      productiveMinutes: 239616,
      alreadyBookedMinutes: 200000,
      minutesRequired: 80000,
    });
    expect(c.fits).toBe(false);
    expect(c.shortfallMinutes.toString()).toBe("40384");
  });

  it("measures against productive minutes, not the full clock", () => {
    // A factory at 60% utilisation and 80% efficiency does not have its gross
    // minutes available; planning against them promises dates it cannot meet.
    const gross = checkCapacity({
      productiveMinutes: 499200,
      alreadyBookedMinutes: 0,
      minutesRequired: 300000,
    });
    const productive = checkCapacity({
      productiveMinutes: 239616,
      alreadyBookedMinutes: 0,
      minutesRequired: 300000,
    });
    expect(gross.fits).toBe(true);
    expect(productive.fits).toBe(false);
  });

  it("treats a fully booked month as having nothing free", () => {
    const c = checkCapacity({
      productiveMinutes: 100000,
      alreadyBookedMinutes: 100000,
      minutesRequired: 1,
    });
    expect(c.minutesFree.toString()).toBe("0");
    expect(c.fits).toBe(false);
  });
});

describe("reorder points", () => {
  it("flags stock at or below its reorder point", () => {
    const flagged = belowReorderPoint([
      { materialId: "a", materialCode: "LOW", onHand: 80, reorderPoint: 100 },
      { materialId: "b", materialCode: "EXACT", onHand: 100, reorderPoint: 100 },
      { materialId: "c", materialCode: "FINE", onHand: 400, reorderPoint: 100 },
    ]);
    expect(flagged.map((f) => f.materialCode)).toEqual(["LOW", "EXACT"]);
  });

  it("ignores materials with no reorder point set", () => {
    expect(
      belowReorderPoint([{ materialId: "a", materialCode: "X", onHand: 0, reorderPoint: null }]),
    ).toEqual([]);
  });
});
