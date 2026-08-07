import Decimal from "decimal.js";

/**
 * Money and quantity handling.
 *
 * Rule from the specification: Decimal everywhere, never float. Rounding is a
 * *display* concern only — intermediate arithmetic keeps full precision so a
 * chain of calculations never drifts.
 */

// Enough precision that no realistic chain of costing operations loses a
// piastre before it reaches the display layer.
Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };

export type Numeric = Decimal | string | number;

export function dec(value: Numeric | null | undefined): Decimal {
  if (value === null || value === undefined) return new Decimal(0);
  if (value instanceof Decimal) return value;
  return new Decimal(value.toString());
}

/** Sum a list without ever touching a float. */
export function sum(values: Numeric[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(dec(v)), new Decimal(0));
}

/**
 * Guarded division. Returns null rather than Infinity/NaN when the divisor is
 * zero — callers must decide what "undefined" means in their context. Silent
 * Infinity is how a break-even chart ends up claiming a style needs
 * 8,000,000 units.
 */
export function safeDiv(
  numerator: Numeric,
  divisor: Numeric,
): Decimal | null {
  const d = dec(divisor);
  if (d.isZero()) return null;
  return dec(numerator).div(d);
}

// --- display helpers -------------------------------------------------------

/**
 * Arabic UI, Latin digits.
 *
 * `ar-EG` on its own formats with Eastern Arabic numerals (١٦٥). Egyptian
 * accounting practice — and every accounting package this system will sit
 * beside — uses Latin digits for money, so the `-u-nu-latn` extension keeps
 * the language Arabic while keeping figures in the numerals an accountant
 * reconciles against.
 */
export const AR_NUMERIC_LOCALE = "ar-EG-u-nu-latn";

export const MONEY_DP = 2; // EGP to the piastre
export const RATE_DP = 4; // minute rates read naturally at 4dp
export const QTY_DP = 2;
export const PCT_DP = 1;

export function roundMoney(value: Numeric): Decimal {
  return dec(value).toDecimalPlaces(MONEY_DP, Decimal.ROUND_HALF_UP);
}

export function formatMoney(
  value: Numeric | null | undefined,
  locale: string = "ar-EG",
  withSymbol = true,
): string {
  if (value === null || value === undefined) return "—";
  const n = roundMoney(value).toNumber();
  const formatted = new Intl.NumberFormat(
    locale === "ar" ? AR_NUMERIC_LOCALE : "en-EG",
    { minimumFractionDigits: MONEY_DP, maximumFractionDigits: MONEY_DP },
  ).format(n);
  if (!withSymbol) return formatted;
  return locale === "ar" ? `${formatted} ج.م` : `EGP ${formatted}`;
}

/** Compact form for dashboard tiles: 1.2M / 420k */
export function formatMoneyCompact(
  value: Numeric | null | undefined,
  locale: string = "ar",
): string {
  if (value === null || value === undefined) return "—";
  const n = dec(value).toNumber();
  const abs = Math.abs(n);
  const suffix = locale === "ar" ? ["", " ألف", " م"] : ["", "k", "M"];
  let out: string;
  if (abs >= 1_000_000) out = (n / 1_000_000).toFixed(2) + suffix[2];
  else if (abs >= 1_000) out = Math.round(n / 1_000) + suffix[1];
  else out = n.toFixed(0);
  return locale === "ar" ? `${out} ج.م` : `EGP ${out}`;
}

export function formatRate(
  value: Numeric | null | undefined,
  locale: string = "ar",
): string {
  if (value === null || value === undefined) return "—";
  const n = dec(value).toDecimalPlaces(RATE_DP, Decimal.ROUND_HALF_UP).toNumber();
  const formatted = new Intl.NumberFormat(
    locale === "ar" ? AR_NUMERIC_LOCALE : "en-EG",
    { minimumFractionDigits: RATE_DP, maximumFractionDigits: RATE_DP },
  ).format(n);
  return locale === "ar" ? `${formatted} ج.م/د` : `EGP ${formatted}/min`;
}

export function formatQty(
  value: Numeric | null | undefined,
  locale: string = "ar",
  unit?: string,
): string {
  if (value === null || value === undefined) return "—";
  const n = dec(value).toDecimalPlaces(QTY_DP, Decimal.ROUND_HALF_UP).toNumber();
  const formatted = new Intl.NumberFormat(
    locale === "ar" ? AR_NUMERIC_LOCALE : "en-EG",
    { maximumFractionDigits: QTY_DP },
  ).format(n);
  return unit ? `${formatted} ${unit}` : formatted;
}

export function formatNumber(
  value: Numeric | null | undefined,
  locale: string = "ar",
): string {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat(
    locale === "ar" ? AR_NUMERIC_LOCALE : "en-EG",
  ).format(dec(value).toNumber());
}

/** Percentages are stored as fractions (0.14) and displayed as 14.0%. */
export function formatPercent(
  fraction: Numeric | null | undefined,
  locale: string = "ar",
  dp: number = PCT_DP,
): string {
  if (fraction === null || fraction === undefined) return "—";
  const n = dec(fraction).times(100).toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toNumber();
  const formatted = new Intl.NumberFormat(
    locale === "ar" ? AR_NUMERIC_LOCALE : "en-EG",
    { minimumFractionDigits: dp, maximumFractionDigits: dp },
  ).format(n);
  return `${formatted}%`;
}

export function formatMinutes(
  value: Numeric | null | undefined,
  locale: string = "ar",
): string {
  if (value === null || value === undefined) return "—";
  const formatted = new Intl.NumberFormat(
    locale === "ar" ? AR_NUMERIC_LOCALE : "en-EG",
    { maximumFractionDigits: 0 },
  ).format(dec(value).toNumber());
  return locale === "ar" ? `${formatted} دقيقة` : `${formatted} min`;
}
