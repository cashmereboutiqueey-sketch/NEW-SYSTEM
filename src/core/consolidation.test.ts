import { describe, it, expect } from "vitest";
import {
  consolidate,
  unrealisedProfitInStock,
  intercompanyReconciliation,
  type EntityResult,
} from "./consolidation";

/**
 * The worked example from the specification:
 *
 *   The Factory invoices 1,000 units to the Brand. The Brand sells 400.
 *   The margin on the remaining 600 is not group profit — it is inventory.
 */
const FACTORY_COST = 400;
const TRANSFER_PRICE = 500;
const MARGIN_PER_UNIT = TRANSFER_PRICE - FACTORY_COST; // 100
const RETAIL = 900;

const UNITS_MADE = 1000;
const UNITS_SOLD = 400;
const UNITS_HELD = UNITS_MADE - UNITS_SOLD; // 600

const factory: EntityResult = {
  externalRevenue: 0,
  intercompanyRevenue: TRANSFER_PRICE * UNITS_MADE, // 500,000
  externalCogs: FACTORY_COST * UNITS_MADE, // 400,000 — the goods it made
  intercompanyCogs: 0,
  operatingExpenses: 0,
};

const brand: EntityResult = {
  externalRevenue: RETAIL * UNITS_SOLD, // 360,000
  intercompanyRevenue: 0,
  externalCogs: 0,
  intercompanyCogs: TRANSFER_PRICE * UNITS_SOLD, // 200,000 — only what sold
  operatingExpenses: 0,
};

describe("the specification's 1,000 made / 400 sold example", () => {
  const result = consolidate(factory, brand, {
    opening: 0,
    closing: MARGIN_PER_UNIT * UNITS_HELD, // 60,000 deferred
  });

  it("shows each entity's own result", () => {
    // Factory: 500,000 revenue less 400,000 cost.
    expect(result.factoryProfit.toString()).toBe("100000");
    // Brand: 360,000 revenue less 200,000 transfer-price cost.
    expect(result.brandProfit.toString()).toBe("160000");
  });

  it("shows the naive sum before elimination", () => {
    expect(result.combinedProfit.toString()).toBe("260000");
  });

  it("defers the margin on the 600 units still in stock", () => {
    expect(result.unrealisedProfitMovement.toString()).toBe("60000");
  });

  it("reports group profit net of both eliminations", () => {
    // 260,000 combined less 60,000 of margin the group charged itself on
    // goods nobody outside has bought.
    expect(result.groupProfit.toString()).toBe("200000");
  });

  it("equals what the group genuinely earned from outside", () => {
    // 400 units sold at 900 cost the group 400 each to make.
    const trueProfit = (RETAIL - FACTORY_COST) * UNITS_SOLD;
    expect(result.groupProfit.toString()).toBe(String(trueProfit));
  });

  it("counts only external revenue at group level", () => {
    // The 500,000 internal invoice is not group revenue.
    expect(result.groupExternalRevenue.toString()).toBe("360000");
  });

  it("cancels both sides of the internal sale", () => {
    expect(result.intercompanyRevenueEliminated.toString()).toBe("500000");
    expect(result.intercompanyCogsEliminated.toString()).toBe("200000");
  });

  it("reports group cost as the factory cost of the units that actually sold", () => {
    // 400 units that cost 400 each to make — not the transfer price, and not
    // the cost of the 600 still sitting in the Brand's warehouse.
    expect(result.groupCogs.toString()).toBe(String(FACTORY_COST * UNITS_SOLD));
  });

  it("keeps revenue less cost equal to group profit", () => {
    expect(
      result.groupExternalRevenue
        .minus(result.groupCogs)
        .minus(result.groupOperatingExpenses)
        .toString(),
    ).toBe(result.groupProfit.toString());
  });
});

describe("releasing deferred margin", () => {
  it("adds back profit as previously held stock is sold", () => {
    // Next period: the Brand sells the remaining 600 and the Factory makes
    // nothing new, so deferred margin unwinds from 60,000 to zero.
    const result = consolidate(
      { externalRevenue: 0, intercompanyRevenue: 0, externalCogs: 0, intercompanyCogs: 0, operatingExpenses: 0 },
      {
        externalRevenue: RETAIL * UNITS_HELD,
        intercompanyRevenue: 0,
        externalCogs: 0,
        intercompanyCogs: TRANSFER_PRICE * UNITS_HELD,
        operatingExpenses: 0,
      },
      { opening: MARGIN_PER_UNIT * UNITS_HELD, closing: 0 },
    );

    // The released 60,000 is added back, because the group has now earned it.
    expect(result.unrealisedProfitMovement.toString()).toBe("-60000");
    expect(result.groupProfit.toString()).toBe(
      String((RETAIL - FACTORY_COST) * UNITS_HELD),
    );
  });

  it("sums across both periods to the same total either way", () => {
    const p1 = consolidate(factory, brand, { opening: 0, closing: MARGIN_PER_UNIT * UNITS_HELD });
    const p2 = consolidate(
      { externalRevenue: 0, intercompanyRevenue: 0, externalCogs: 0, intercompanyCogs: 0, operatingExpenses: 0 },
      {
        externalRevenue: RETAIL * UNITS_HELD, intercompanyRevenue: 0,
        externalCogs: 0, intercompanyCogs: TRANSFER_PRICE * UNITS_HELD, operatingExpenses: 0,
      },
      { opening: MARGIN_PER_UNIT * UNITS_HELD, closing: 0 },
    );

    // Deferral moves profit between periods; it never creates or destroys it.
    expect(p1.groupProfit.plus(p2.groupProfit).toString()).toBe(
      String((RETAIL - FACTORY_COST) * UNITS_MADE),
    );
  });
});

describe("producing into stock", () => {
  it("does not make the group look more profitable", () => {
    // The Factory makes 1,000 and the Brand sells none. Combined profit looks
    // like 100,000 of factory margin; group profit must be zero.
    const result = consolidate(
      factory,
      { externalRevenue: 0, intercompanyRevenue: 0, externalCogs: 0, intercompanyCogs: 0, operatingExpenses: 0 },
      { opening: 0, closing: MARGIN_PER_UNIT * UNITS_MADE },
    );

    expect(result.combinedProfit.toString()).toBe("100000");
    expect(result.groupProfit.toString()).toBe("0");
  });

  it("still charges group-level operating costs against the period", () => {
    // Overheads are consumed whether or not anything sold.
    const result = consolidate(
      { ...factory, operatingExpenses: 30000 },
      { externalRevenue: 0, intercompanyRevenue: 0, externalCogs: 0, intercompanyCogs: 0, operatingExpenses: 20000 },
      { opening: 0, closing: MARGIN_PER_UNIT * UNITS_MADE },
    );
    expect(result.groupProfit.toString()).toBe("-50000");
  });
});

describe("unrealised profit in stock", () => {
  it("values the margin held in each lot", () => {
    const value = unrealisedProfitInStock([
      { remainingQty: 600, transferMarginPerUnit: 100 },
      { remainingQty: 50, transferMarginPerUnit: 80 },
    ]);
    expect(value.toString()).toBe("64000");
  });

  it("ignores stock bought from outside the group", () => {
    // Goods the Brand bought from a third party carry no internal margin.
    const value = unrealisedProfitInStock([
      { remainingQty: 600, transferMarginPerUnit: 100 },
      { remainingQty: 200, transferMarginPerUnit: null },
    ]);
    expect(value.toString()).toBe("60000");
  });

  it("is zero when nothing is left on the shelf", () => {
    expect(
      unrealisedProfitInStock([{ remainingQty: 0, transferMarginPerUnit: 100 }]).toString(),
    ).toBe("0");
  });

  it("handles an empty warehouse", () => {
    expect(unrealisedProfitInStock([]).toString()).toBe("0");
  });
});

describe("intercompany reconciliation", () => {
  it("matches when both books agree", () => {
    expect(intercompanyReconciliation(500000, 500000).matched).toBe(true);
  });

  it("surfaces a mismatch rather than forcing it to zero", () => {
    // An invoice raised but not yet received is a real condition that belongs
    // in an exception queue.
    const r = intercompanyReconciliation(500000, 480000);
    expect(r.matched).toBe(false);
    expect(r.difference.toString()).toBe("20000");
  });
});
