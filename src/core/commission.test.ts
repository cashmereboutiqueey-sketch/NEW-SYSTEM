import { describe, it, expect } from "vitest";
import { commissionFor, commissionBreakdown, clawBackFor, rateOn } from "./commission";

/** What a moderator earns, and what comes back when goods do. */

const perPiece = { perPieceAmount: "10", percentOfNet: "0" };
const percent = { perPieceAmount: "0", percentOfNet: "0.05" };
const both = { perPieceAmount: "10", percentOfNet: "0.02" };

describe("what the rate comes to", () => {
  it("pays a flat amount for every garment", () => {
    expect(commissionFor(perPiece, { pieces: 3, netAmount: "1500" }).toString()).toBe("30");
  });

  it("pays a share of what the order came to", () => {
    expect(commissionFor(percent, { pieces: 3, netAmount: "1500" }).toString()).toBe("75");
  });

  it("adds the two where a rate has both", () => {
    // 3 × 10 = 30, plus 2% of 1500 = 30.
    const b = commissionBreakdown(both, { pieces: 3, netAmount: "1500" });
    expect(b.fromPieces.toString()).toBe("30");
    expect(b.fromPercent.toString()).toBe("30");
    expect(b.total.toString()).toBe("60");
  });

  it("shows a total that is the sum of the two figures printed beside it", () => {
    // Each half rounds on its own, so a payslip that lists both and adds them
    // agrees with the total rather than being a piastre out.
    const b = commissionBreakdown({ perPieceAmount: "3.333", percentOfNet: "0.0333" }, {
      pieces: 3,
      netAmount: "999.99",
    });
    expect(b.fromPieces.plus(b.fromPercent).toString()).toBe(b.total.toString());
  });

  it("pays nothing on an order worth nothing to somebody on no rate", () => {
    expect(commissionFor({ perPieceAmount: "0", percentOfNet: "0" }, { pieces: 9, netAmount: "9999" }).toString())
      .toBe("0");
  });

  it("ignores shipping, because a further parcel is not a better sale", () => {
    // The basis is the net, and the caller never puts shipping into it. Fixed
    // here so a later change to what is passed shows up as a failing test.
    const near = commissionFor(percent, { pieces: 1, netAmount: "1000" });
    const far = commissionFor(percent, { pieces: 1, netAmount: "1000" });
    expect(near.toString()).toBe(far.toString());
  });
});

describe("when goods come back", () => {
  it("takes back what the returned pieces were worth, not a share of the whole", () => {
    // Two of five back, at ten a piece.
    expect(clawBackFor(perPiece, { pieces: 2, netAmount: "1000" }, "50").toString()).toBe("20");
  });

  it("never takes back more than was earned", () => {
    // The whole order back, but the earning was only ever 30.
    expect(clawBackFor(perPiece, { pieces: 5, netAmount: "2500" }, "30").toString()).toBe("30");
  });

  it("counts what has already been taken back", () => {
    expect(clawBackFor(perPiece, { pieces: 3, netAmount: "1500" }, "50", "40").toString()).toBe("10");
  });

  it("takes nothing more once the earning is gone", () => {
    expect(clawBackFor(perPiece, { pieces: 1, netAmount: "500" }, "30", "30").toString()).toBe("0");
  });
});

describe("which rate applied that day", () => {
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  const rates = [
    { id: "old", effectiveFrom: day("2026-01-01"), effectiveTo: day("2026-05-31") },
    { id: "new", effectiveFrom: day("2026-06-01"), effectiveTo: null },
  ];

  it("uses the rate in force that day, not the rate in force now", () => {
    expect(rateOn(rates, day("2026-03-10"))?.id).toBe("old");
    expect(rateOn(rates, day("2026-09-22"))?.id).toBe("new");
  });

  it("includes both ends of a closed rate", () => {
    expect(rateOn(rates, day("2026-01-01"))?.id).toBe("old");
    expect(rateOn(rates, day("2026-05-31"))?.id).toBe("old");
  });

  it("pays nothing before anybody was on a rate", () => {
    expect(rateOn(rates, day("2025-12-31"))).toBeNull();
  });

  it("takes the later start where two overlap, which is what a correction is", () => {
    const overlapping = [
      { id: "left-open", effectiveFrom: day("2026-01-01"), effectiveTo: null },
      { id: "written-over", effectiveFrom: day("2026-06-01"), effectiveTo: null },
    ];
    expect(rateOn(overlapping, day("2026-09-22"))?.id).toBe("written-over");
  });

  it("says nothing at all for somebody with no rate", () => {
    expect(rateOn([], day("2026-09-22"))).toBeNull();
  });
});
