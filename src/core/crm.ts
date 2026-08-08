import { Decimal, dec, safeDiv, type Numeric } from "@/lib/money";

/**
 * Customer intelligence.
 *
 * Everything here is derived from orders that actually happened. No predicted
 * lifetime value, no modelled churn probability — the specification is
 * explicit that no AI is required, and a number the owner cannot trace back to
 * receipts is not worth acting on.
 */

export type CustomerOrder = {
  orderDate: Date;
  /** Revenue net of discount, excluding shipping. */
  netAmount: Numeric;
  /** FIFO cost relieved for the order. */
  cogsAmount: Numeric;
  /** Units returned, if the order was wholly or partly sent back. */
  returnedQty?: number;
  quantity: number;
};

export type RfmScore = {
  /** Days since the most recent order. Null when they have never bought. */
  recencyDays: number | null;
  frequency: number;
  monetary: Decimal;
  /** 1–5 each, higher is better. Null until there is an order to score. */
  recencyScore: number | null;
  frequencyScore: number | null;
  monetaryScore: number | null;
};

/**
 * Scores are cut at fixed, stated thresholds rather than quintiles of the
 * current customer base. Quintiles shift every time anyone buys anything,
 * which makes a segment mean something different week to week and quietly
 * invalidates any campaign measured against it.
 */
const RECENCY_BANDS = [30, 60, 120, 240]; // days: ≤30 → 5, ≤60 → 4, …
const FREQUENCY_BANDS = [1, 2, 4, 8]; // orders: ≥8 → 5, ≥4 → 4, …
const MONETARY_BANDS = [1000, 3000, 8000, 20000]; // EGP lifetime spend

function bandAscending(value: number, bands: number[]): number {
  // Lower is better (recency).
  for (let i = 0; i < bands.length; i++) {
    if (value <= bands[i]) return 5 - i;
  }
  return 1;
}

function bandDescending(value: Numeric, bands: number[]): number {
  // Higher is better (frequency, monetary).
  const v = dec(value);
  for (let i = bands.length - 1; i >= 0; i--) {
    if (v.greaterThanOrEqualTo(bands[i])) return i + 2 > 5 ? 5 : i + 2;
  }
  return 1;
}

export function rfm(orders: CustomerOrder[], asOf: Date): RfmScore {
  if (orders.length === 0) {
    return {
      recencyDays: null, frequency: 0, monetary: dec(0),
      recencyScore: null, frequencyScore: null, monetaryScore: null,
    };
  }

  const latest = orders.reduce(
    (max, o) => (o.orderDate > max ? o.orderDate : max),
    orders[0].orderDate,
  );
  const recencyDays = Math.max(
    0,
    Math.floor((asOf.getTime() - latest.getTime()) / 86_400_000),
  );
  const monetary = orders.reduce((s, o) => s.plus(dec(o.netAmount)), dec(0));

  return {
    recencyDays,
    frequency: orders.length,
    monetary,
    recencyScore: bandAscending(recencyDays, RECENCY_BANDS),
    frequencyScore: bandDescending(orders.length, FREQUENCY_BANDS),
    monetaryScore: bandDescending(monetary, MONETARY_BANDS),
  };
}

export type CustomerValue = {
  orders: number;
  units: number;
  revenue: Decimal;
  cogs: Decimal;
  /** Revenue less the cost of what they actually kept. */
  grossProfit: Decimal;
  averageOrderValue: Decimal | null;
  returnRate: Decimal | null;
  /** Gross profit to date. Not a forecast. */
  lifetimeValue: Decimal;
};

export function customerValue(orders: CustomerOrder[]): CustomerValue {
  const revenue = orders.reduce((s, o) => s.plus(dec(o.netAmount)), dec(0));
  const cogs = orders.reduce((s, o) => s.plus(dec(o.cogsAmount)), dec(0));
  const units = orders.reduce((s, o) => s + o.quantity, 0);
  const returned = orders.reduce((s, o) => s + (o.returnedQty ?? 0), 0);
  const grossProfit = revenue.minus(cogs);

  return {
    orders: orders.length,
    units,
    revenue,
    cogs,
    grossProfit,
    averageOrderValue: safeDiv(revenue, orders.length),
    returnRate: safeDiv(returned, units),
    lifetimeValue: grossProfit,
  };
}

export type Segment =
  | "CHAMPION"
  | "LOYAL"
  | "PROMISING"
  | "AT_RISK"
  | "LOST"
  | "NEW"
  | "NEVER_PURCHASED";

/**
 * A plain-language segment, so the label says what to do rather than
 * requiring the reader to decode three digits.
 */
export function segment(score: RfmScore): Segment {
  if (score.frequency === 0 || score.recencyScore === null) return "NEVER_PURCHASED";

  const r = score.recencyScore;
  const f = score.frequencyScore ?? 1;
  const m = score.monetaryScore ?? 1;

  if (r >= 4 && f >= 4) return "CHAMPION";
  if (r >= 3 && f >= 3) return "LOYAL";
  if (r >= 4 && f <= 2) return score.frequency === 1 ? "NEW" : "PROMISING";
  if (r <= 2 && (f >= 3 || m >= 4)) return "AT_RISK";
  if (r <= 2) return "LOST";
  return "PROMISING";
}

/**
 * Normalises an Egyptian mobile number for comparison.
 *
 * Used only to *find* possible duplicates. Two records that normalise the same
 * are flagged for review, never merged automatically — a shared family phone
 * is common, and silently merging two real customers loses history that
 * cannot be recovered.
 */
export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7) return null;

  // 00201..., +201..., 201... and 01... all describe the same line.
  let local = digits;
  if (local.startsWith("00")) local = local.slice(2);
  if (local.startsWith("20")) local = local.slice(2);
  if (!local.startsWith("0")) local = `0${local}`;
  return local;
}

export function normaliseEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.includes("@") ? trimmed : null;
}

export type DuplicateCandidate = {
  aId: string;
  bId: string;
  reason: "PHONE" | "EMAIL";
  value: string;
};

/**
 * Finds records that look like the same person.
 *
 * Returns candidates for a human to confirm. Conflicting names on a matching
 * phone are exactly the case that must not be resolved automatically.
 */
export function findDuplicates(
  customers: { id: string; phone: string | null; email: string | null }[],
): DuplicateCandidate[] {
  const byPhone = new Map<string, string[]>();
  const byEmail = new Map<string, string[]>();

  for (const c of customers) {
    const phone = normalisePhone(c.phone);
    if (phone) byPhone.set(phone, [...(byPhone.get(phone) ?? []), c.id]);
    const email = normaliseEmail(c.email);
    if (email) byEmail.set(email, [...(byEmail.get(email) ?? []), c.id]);
  }

  const candidates: DuplicateCandidate[] = [];
  const emit = (map: Map<string, string[]>, reason: "PHONE" | "EMAIL") => {
    for (const [value, ids] of map) {
      if (ids.length < 2) continue;
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          candidates.push({ aId: ids[i], bId: ids[j], reason, value });
        }
      }
    }
  };

  emit(byPhone, "PHONE");
  emit(byEmail, "EMAIL");
  return candidates;
}
