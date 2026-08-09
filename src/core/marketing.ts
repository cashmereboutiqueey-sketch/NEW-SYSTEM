import { Decimal, dec, safeDiv, type Numeric } from "@/lib/money";

/**
 * Campaign performance.
 *
 * The headline number is contribution after marketing, not return on ad
 * spend. A campaign can post a ROAS of four and still lose money if the
 * garments it sold were discounted to move — revenue is not margin, and only
 * one of the two pays wages.
 */

export type CampaignTotals = {
  spend: Numeric;
  creatorFee?: Numeric;
  /** Revenue from orders attributed to this campaign, net of discount. */
  revenue: Numeric;
  /** FIFO cost of what those orders actually relieved. */
  cogs: Numeric;
  orders: number;
  units: number;
  clicks?: number;
  impressions?: number;
  /** Units sent back, which cost margin twice — the sale and the handling. */
  returnedUnits?: number;
};

export type CampaignPerformance = {
  spend: Decimal;
  revenue: Decimal;
  cogs: Decimal;
  grossMargin: Decimal;
  /** Gross margin less what the campaign cost. The number that matters. */
  contribution: Decimal;
  /** Revenue per pound spent. Flattering and frequently misleading. */
  roas: Decimal | null;
  /** Margin per pound spent. Above 1 means the campaign paid for itself. */
  contributionRoas: Decimal | null;
  costPerOrder: Decimal | null;
  costPerUnit: Decimal | null;
  averageOrderValue: Decimal | null;
  clickThroughRate: Decimal | null;
  costPerClick: Decimal | null;
  conversionRate: Decimal | null;
  returnRate: Decimal | null;
  profitable: boolean;
};

export function campaignPerformance(t: CampaignTotals): CampaignPerformance {
  // The creator's fee is as much a cost of the campaign as the ad spend.
  const spend = dec(t.spend).plus(dec(t.creatorFee ?? 0));
  const revenue = dec(t.revenue);
  const cogs = dec(t.cogs);
  const grossMargin = revenue.minus(cogs);
  const contribution = grossMargin.minus(spend);

  return {
    spend,
    revenue,
    cogs,
    grossMargin,
    contribution,
    roas: safeDiv(revenue, spend),
    contributionRoas: safeDiv(grossMargin, spend),
    costPerOrder: safeDiv(spend, t.orders),
    costPerUnit: safeDiv(spend, t.units),
    averageOrderValue: safeDiv(revenue, t.orders),
    clickThroughRate: t.impressions ? safeDiv(t.clicks ?? 0, t.impressions) : null,
    costPerClick: t.clicks ? safeDiv(spend, t.clicks) : null,
    conversionRate: t.clicks ? safeDiv(t.orders, t.clicks) : null,
    returnRate: t.units ? safeDiv(t.returnedUnits ?? 0, t.units) : null,
    profitable: contribution.greaterThan(0),
  };
}

/**
 * Spreads marketing cost across the units it helped sell.
 *
 * The default basis is units sold, which is what the specification settled
 * on. A campaign for one style can be charged wholly to that style instead;
 * anything unattributed is spread across everything, because brand spend does
 * genuinely help sell whatever is on the shelf.
 */
export function marketingPerUnit(
  totalSpend: Numeric,
  unitsSold: Numeric,
): Decimal | null {
  return safeDiv(dec(totalSpend), dec(unitsSold));
}

/**
 * What a campaign must earn back before it is worth running again.
 *
 * Expressed in units so it can be compared with the run size, rather than in
 * revenue, which invites the wrong comparison.
 */
export function breakEvenUnits(
  spend: Numeric,
  contributionPerUnit: Numeric,
): Decimal | null {
  const perUnit = dec(contributionPerUnit);
  // A campaign selling garments that lose money can never pay for itself, so
  // there is no number to report rather than a very large one.
  if (perUnit.lessThanOrEqualTo(0)) return null;
  return dec(spend).div(perUnit);
}

export type MetaCsvRow = {
  campaignName: string;
  date: string;
  amountSpent: string;
  impressions?: string;
  clicks?: string;
  purchases?: string;
};

/**
 * Reads a Meta Ads Manager export.
 *
 * Meta's column names shift between report presets and locales, so headers
 * are matched loosely rather than by exact position. A row that cannot be
 * read is reported with its line number instead of being skipped silently —
 * a missing day of spend makes a campaign look more profitable than it was.
 */
export function parseMetaCsv(csv: string): {
  rows: MetaCsvRow[];
  errors: { line: number; reason: string }[];
} {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    return { rows: [], errors: [{ line: 1, reason: "The file has no data rows." }] };
  }

  const headers = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const find = (...candidates: string[]) =>
    headers.findIndex((h) => candidates.some((c) => h.includes(c)));

  const idx = {
    name: find("campaign name", "campaign_name", "اسم الحملة"),
    date: find("day", "date", "reporting starts", "التاريخ"),
    spend: find("amount spent", "spend", "cost", "المبلغ"),
    impressions: find("impression", "مرات الظهور"),
    clicks: find("link click", "clicks", "النقرات"),
    purchases: find("purchase", "results", "عمليات الشراء"),
  };

  const errors: { line: number; reason: string }[] = [];
  if (idx.name < 0) errors.push({ line: 1, reason: "No campaign name column found." });
  if (idx.date < 0) errors.push({ line: 1, reason: "No date column found." });
  if (idx.spend < 0) errors.push({ line: 1, reason: "No amount spent column found." });
  if (errors.length > 0) return { rows: [], errors };

  const rows: MetaCsvRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const campaignName = cells[idx.name]?.trim();
    const date = cells[idx.date]?.trim();
    const amountSpent = cells[idx.spend]?.trim();

    if (!campaignName || !date || !amountSpent) {
      errors.push({ line: i + 1, reason: "Missing campaign name, date or amount." });
      continue;
    }
    if (Number.isNaN(Number(amountSpent.replace(/[^0-9.-]/g, "")))) {
      errors.push({ line: i + 1, reason: `Amount "${amountSpent}" is not a number.` });
      continue;
    }

    rows.push({
      campaignName,
      date,
      amountSpent: amountSpent.replace(/[^0-9.-]/g, ""),
      impressions: idx.impressions >= 0 ? cells[idx.impressions]?.trim() : undefined,
      clicks: idx.clicks >= 0 ? cells[idx.clicks]?.trim() : undefined,
      purchases: idx.purchases >= 0 ? cells[idx.purchases]?.trim() : undefined,
    });
  }

  return { rows, errors };
}

/** Splits one CSV line, respecting quoted fields that contain commas. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      // A doubled quote inside a quoted field is one literal quote.
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}
