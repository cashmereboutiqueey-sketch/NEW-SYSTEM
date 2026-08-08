import { describe, it, expect } from "vitest";
import {
  rfm,
  customerValue,
  segment,
  normalisePhone,
  normaliseEmail,
  findDuplicates,
  type CustomerOrder,
} from "./crm";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const asOf = d("2026-08-01");

function order(over: Partial<CustomerOrder> = {}): CustomerOrder {
  return {
    orderDate: d("2026-07-15"),
    netAmount: "1500",
    cogsAmount: "800",
    quantity: 2,
    ...over,
  };
}

describe("RFM", () => {
  it("scores a recent, frequent, high-spending customer highly", () => {
    const orders = Array.from({ length: 9 }, (_, i) =>
      order({ orderDate: d("2026-07-20"), netAmount: "3000" }),
    );
    const score = rfm(orders, asOf);

    expect(score.recencyDays).toBe(12);
    expect(score.frequency).toBe(9);
    expect(score.monetary.toString()).toBe("27000");
    expect(score.recencyScore).toBe(5);
    expect(score.frequencyScore).toBe(5);
    expect(score.monetaryScore).toBe(5);
  });

  it("measures recency from the most recent order, not the first", () => {
    const score = rfm(
      [order({ orderDate: d("2026-01-05") }), order({ orderDate: d("2026-07-25") })],
      asOf,
    );
    expect(score.recencyDays).toBe(7);
  });

  it("scores a long-lapsed customer low on recency", () => {
    const score = rfm([order({ orderDate: d("2025-06-01") })], asOf);
    expect(score.recencyScore).toBe(1);
  });

  it("returns nothing to score for someone who has never bought", () => {
    const score = rfm([], asOf);
    expect(score.frequency).toBe(0);
    expect(score.recencyDays).toBeNull();
    expect(score.recencyScore).toBeNull();
  });

  it("uses fixed thresholds so a segment means the same thing next week", () => {
    // With quintiles of the live base, the same customer's score would drift
    // whenever anyone else bought something.
    const alone = rfm([order({ orderDate: d("2026-07-25"), netAmount: "5000" })], asOf);
    const crowded = rfm([order({ orderDate: d("2026-07-25"), netAmount: "5000" })], asOf);
    expect(alone.monetaryScore).toBe(crowded.monetaryScore);
  });

  it("never reports negative recency for an order dated today", () => {
    expect(rfm([order({ orderDate: asOf })], asOf).recencyDays).toBe(0);
  });
});

describe("segments", () => {
  it("calls a recent frequent buyer a champion", () => {
    const orders = Array.from({ length: 6 }, () => order({ orderDate: d("2026-07-25") }));
    expect(segment(rfm(orders, asOf))).toBe("CHAMPION");
  });

  it("calls a single recent buyer new", () => {
    expect(segment(rfm([order({ orderDate: d("2026-07-28") })], asOf))).toBe("NEW");
  });

  it("flags a formerly frequent buyer who has gone quiet as at risk", () => {
    const orders = Array.from({ length: 6 }, () => order({ orderDate: d("2025-11-01") }));
    expect(segment(rfm(orders, asOf))).toBe("AT_RISK");
  });

  it("calls a lapsed one-time buyer lost", () => {
    expect(segment(rfm([order({ orderDate: d("2025-01-01"), netAmount: "500" })], asOf))).toBe(
      "LOST",
    );
  });

  it("distinguishes never-purchased from lost", () => {
    expect(segment(rfm([], asOf))).toBe("NEVER_PURCHASED");
  });
});

describe("customer value", () => {
  it("reports lifetime value as gross profit actually earned", () => {
    const v = customerValue([
      order({ netAmount: "1500", cogsAmount: "800" }),
      order({ netAmount: "2500", cogsAmount: "1200" }),
    ]);
    expect(v.revenue.toString()).toBe("4000");
    expect(v.cogs.toString()).toBe("2000");
    expect(v.grossProfit.toString()).toBe("2000");
    // Earned, not forecast — no modelled future purchases.
    expect(v.lifetimeValue.toString()).toBe("2000");
  });

  it("computes average order value", () => {
    const v = customerValue([order({ netAmount: "1000" }), order({ netAmount: "3000" })]);
    expect(v.averageOrderValue!.toString()).toBe("2000");
  });

  it("computes return rate against units bought", () => {
    const v = customerValue([
      order({ quantity: 4, returnedQty: 1 }),
      order({ quantity: 6, returnedQty: 0 }),
    ]);
    expect(v.returnRate!.toString()).toBe("0.1");
  });

  it("gives no average or return rate for a customer with no orders", () => {
    const v = customerValue([]);
    expect(v.averageOrderValue).toBeNull();
    expect(v.returnRate).toBeNull();
    expect(v.lifetimeValue.toString()).toBe("0");
  });

  it("can report a loss-making customer", () => {
    // Heavy discounting plus returns genuinely can cost more than it earns.
    const v = customerValue([order({ netAmount: "500", cogsAmount: "800" })]);
    expect(v.grossProfit.toString()).toBe("-300");
  });
});

describe("phone normalisation", () => {
  it("treats every Egyptian format as the same line", () => {
    const forms = ["01001234567", "+201001234567", "00201001234567", "20 100 123 4567", "0100-123-4567"];
    const normalised = forms.map(normalisePhone);
    expect(new Set(normalised).size).toBe(1);
    expect(normalised[0]).toBe("01001234567");
  });

  it("ignores unusable input", () => {
    expect(normalisePhone(null)).toBeNull();
    expect(normalisePhone("")).toBeNull();
    expect(normalisePhone("123")).toBeNull();
  });

  it("lowercases and trims email", () => {
    expect(normaliseEmail("  Nour@Example.COM ")).toBe("nour@example.com");
    expect(normaliseEmail("not-an-email")).toBeNull();
  });
});

describe("duplicate detection", () => {
  it("flags records sharing a phone in different formats", () => {
    const dupes = findDuplicates([
      { id: "a", phone: "01001234567", email: null },
      { id: "b", phone: "+20 100 123 4567", email: null },
    ]);
    expect(dupes).toHaveLength(1);
    expect(dupes[0]).toMatchObject({ aId: "a", bId: "b", reason: "PHONE" });
  });

  it("flags records sharing an email", () => {
    const dupes = findDuplicates([
      { id: "a", phone: null, email: "Nour@example.com" },
      { id: "b", phone: null, email: "nour@example.com" },
    ]);
    expect(dupes[0].reason).toBe("EMAIL");
  });

  it("returns candidates rather than merging", () => {
    // A shared family phone is common; merging two real customers loses
    // history that cannot be recovered, so a human confirms.
    const dupes = findDuplicates([
      { id: "mother", phone: "01001234567", email: null },
      { id: "daughter", phone: "01001234567", email: null },
    ]);
    expect(dupes).toHaveLength(1);
    expect(dupes[0]).toHaveProperty("aId");
  });

  it("does not flag distinct customers", () => {
    expect(
      findDuplicates([
        { id: "a", phone: "01001234567", email: "a@x.com" },
        { id: "b", phone: "01119876543", email: "b@x.com" },
      ]),
    ).toEqual([]);
  });

  it("ignores records with nothing to match on", () => {
    expect(
      findDuplicates([
        { id: "a", phone: null, email: null },
        { id: "b", phone: null, email: null },
      ]),
    ).toEqual([]);
  });

  it("pairs every combination when three records collide", () => {
    const dupes = findDuplicates([
      { id: "a", phone: "01001234567", email: null },
      { id: "b", phone: "01001234567", email: null },
      { id: "c", phone: "01001234567", email: null },
    ]);
    expect(dupes).toHaveLength(3);
  });
});
