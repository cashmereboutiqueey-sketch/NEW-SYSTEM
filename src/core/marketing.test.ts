import { describe, it, expect } from "vitest";
import {
  campaignPerformance,
  marketingPerUnit,
  breakEvenUnits,
  parseMetaCsv,
} from "./marketing";

describe("campaign performance", () => {
  const base = {
    spend: "20000",
    revenue: "95000",
    cogs: "48000",
    orders: 40,
    units: 62,
    impressions: 240000,
    clicks: 3200,
  };

  it("reports contribution after the campaign has paid for itself", () => {
    const p = campaignPerformance(base);
    expect(p.grossMargin.toString()).toBe("47000");
    expect(p.contribution.toString()).toBe("27000");
    expect(p.profitable).toBe(true);
  });

  it("counts the creator fee as part of the spend", () => {
    const p = campaignPerformance({ ...base, creatorFee: "15000" });
    expect(p.spend.toString()).toBe("35000");
    expect(p.contribution.toString()).toBe("12000");
  });

  it("separates a flattering ROAS from margin per pound spent", () => {
    const p = campaignPerformance(base);
    // 95,000 revenue on 20,000 spend reads as 4.75×.
    expect(p.roas!.toFixed(2)).toBe("4.75");
    // On margin it is 2.35×, which is the figure that pays wages.
    expect(p.contributionRoas!.toFixed(2)).toBe("2.35");
  });

  it("shows a campaign that looks good on ROAS and still loses money", () => {
    // Heavy discounting: plenty of revenue, almost no margin.
    const p = campaignPerformance({
      spend: "30000", revenue: "120000", cogs: "100000", orders: 60, units: 90,
    });
    expect(p.roas!.toString()).toBe("4");
    expect(p.contributionRoas!.lessThan(1)).toBe(true);
    expect(p.contribution.toString()).toBe("-10000");
    expect(p.profitable).toBe(false);
  });

  it("computes the funnel figures", () => {
    const p = campaignPerformance(base);
    expect(p.clickThroughRate!.toFixed(4)).toBe("0.0133");
    expect(p.costPerClick!.toFixed(2)).toBe("6.25");
    expect(p.conversionRate!.toFixed(4)).toBe("0.0125");
    expect(p.costPerOrder!.toString()).toBe("500");
  });

  it("reports no rates for a campaign that has not run yet", () => {
    const p = campaignPerformance({
      spend: "0", revenue: "0", cogs: "0", orders: 0, units: 0,
    });
    expect(p.roas).toBeNull();
    expect(p.costPerOrder).toBeNull();
    expect(p.contribution.toString()).toBe("0");
  });

  it("reports the return rate, since a return costs margin twice", () => {
    const p = campaignPerformance({ ...base, returnedUnits: 8 });
    expect(p.returnRate!.toFixed(4)).toBe("0.1290");
  });
});

describe("allocating marketing to units", () => {
  it("spreads spend across the units sold", () => {
    expect(marketingPerUnit(45000, 300)!.toString()).toBe("150");
  });

  it("reports nothing rather than dividing by no sales", () => {
    expect(marketingPerUnit(45000, 0)).toBeNull();
  });

  it("reports how many units a campaign must sell to pay for itself", () => {
    expect(breakEvenUnits(20000, 250)!.toString()).toBe("80");
  });

  it("says a campaign can never pay for itself rather than printing a huge number", () => {
    // Selling garments at a loss, no amount of volume rescues it.
    expect(breakEvenUnits(20000, -30)).toBeNull();
    expect(breakEvenUnits(20000, 0)).toBeNull();
  });
});

describe("reading a Meta Ads export", () => {
  const csv = [
    "Campaign name,Day,Amount spent (EGP),Impressions,Link clicks,Purchases",
    "Autumn Launch,2026-08-01,1500.50,42000,610,12",
    "Autumn Launch,2026-08-02,1720.00,45500,702,15",
  ].join("\n");

  it("reads the rows Meta actually exports", () => {
    const { rows, errors } = parseMetaCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      campaignName: "Autumn Launch",
      date: "2026-08-01",
      amountSpent: "1500.50",
      clicks: "610",
    });
  });

  it("matches headers loosely, since Meta renames them between presets", () => {
    const alternative = [
      "Campaign Name,Reporting starts,Spend,Impressions",
      "Winter Teaser,2026-09-01,900.00,15000",
    ].join("\n");
    const { rows, errors } = parseMetaCsv(alternative);
    expect(errors).toEqual([]);
    expect(rows[0].campaignName).toBe("Winter Teaser");
  });

  it("handles a campaign name containing a comma", () => {
    const quoted = [
      "Campaign name,Day,Amount spent",
      '"Autumn, Alexandria",2026-08-01,500.00',
    ].join("\n");
    const { rows } = parseMetaCsv(quoted);
    expect(rows[0].campaignName).toBe("Autumn, Alexandria");
  });

  it("strips a currency symbol from the amount", () => {
    const withSymbol = [
      "Campaign name,Day,Amount spent",
      "Launch,2026-08-01,\"EGP 1,500.50\"",
    ].join("\n");
    const { rows } = parseMetaCsv(withSymbol);
    expect(rows[0].amountSpent).toBe("1500.50");
  });

  it("reports a bad row by line number instead of dropping it", () => {
    // A silently skipped day of spend makes a campaign look more profitable
    // than it was.
    const broken = [
      "Campaign name,Day,Amount spent",
      "Launch,2026-08-01,1500.00",
      "Launch,2026-08-02,not-a-number",
      ",2026-08-03,900.00",
    ].join("\n");

    const { rows, errors } = parseMetaCsv(broken);
    expect(rows).toHaveLength(1);
    expect(errors.map((e) => e.line)).toEqual([3, 4]);
    expect(errors[0].reason).toMatch(/not a number/i);
  });

  it("refuses a file whose columns it cannot recognise", () => {
    const { rows, errors } = parseMetaCsv("Foo,Bar\n1,2");
    expect(rows).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("reports an empty file rather than returning nothing quietly", () => {
    const { errors } = parseMetaCsv("Campaign name,Day,Amount spent");
    expect(errors[0].reason).toMatch(/no data rows/i);
  });
});
