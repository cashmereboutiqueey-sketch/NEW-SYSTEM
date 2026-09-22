/**
 * A sum of money written out in Arabic, the way an invoice writes it.
 *
 * "فقط ستمائة جنيه مصرى لا غير" is not decoration. The line in words is what a
 * printed invoice is checked against when the figure is smudged, altered or
 * argued over, which is why it has been on Egyptian invoices for a century and
 * why it has to be right rather than approximately right.
 *
 * The commercial form is used throughout, not the fully inflected classical
 * one: `ألفان` and not `ألفين`, `ثلاثة آلاف` and not `ثلاثةُ آلافٍ`. That is
 * what the shop's own printed invoices say and what anybody reading one
 * expects; grammar beyond it would be correct and unfamiliar, which on a
 * receipt is worse.
 *
 * Pure, because it is checked against the figure beside it and an argument
 * about either should be settleable by running the numbers.
 */

const ONES = [
  "",
  "واحد",
  "اثنان",
  "ثلاثة",
  "أربعة",
  "خمسة",
  "ستة",
  "سبعة",
  "ثمانية",
  "تسعة",
  "عشرة",
  "أحد عشر",
  "اثنا عشر",
  "ثلاثة عشر",
  "أربعة عشر",
  "خمسة عشر",
  "ستة عشر",
  "سبعة عشر",
  "ثمانية عشر",
  "تسعة عشر",
];

const TENS = ["", "", "عشرون", "ثلاثون", "أربعون", "خمسون", "ستون", "سبعون", "ثمانون", "تسعون"];

/** Not "ثلاثة مائة": the hundreds are their own words and always have been. */
const HUNDREDS = [
  "",
  "مائة",
  "مئتان",
  "ثلاثمائة",
  "أربعمائة",
  "خمسمائة",
  "ستمائة",
  "سبعمائة",
  "ثمانمائة",
  "تسعمائة",
];

/** Below a thousand, which is the piece every larger number is built from. */
function underThousand(n: number): string {
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;

  if (hundreds > 0) parts.push(HUNDREDS[hundreds]);

  if (rest > 0) {
    if (rest < 20) {
      parts.push(ONES[rest]);
    } else {
      const unit = rest % 10;
      const ten = Math.floor(rest / 10);
      // Units before tens, which is the Arabic order: خمسة وعشرون, not the
      // other way round.
      parts.push(unit > 0 ? `${ONES[unit]} و${TENS[ten]}` : TENS[ten]);
    }
  }

  return parts.join(" و");
}

/**
 * One scale word, in the three forms Arabic gives it.
 *
 * Singular for one, dual for two, and the plural counted by three to ten —
 * `ألف`, `ألفان`, `ثلاثة آلاف`. Above ten the singular returns, which is the
 * rule that catches everybody: eleven thousand is `أحد عشر ألف`.
 */
type Scale = { one: string; two: string; few: string; many: string };

const THOUSAND: Scale = { one: "ألف", two: "ألفان", few: "آلاف", many: "ألف" };
const MILLION: Scale = { one: "مليون", two: "مليونان", few: "ملايين", many: "مليون" };

function scaled(count: number, scale: Scale): string {
  if (count === 1) return scale.one;
  if (count === 2) return scale.two;
  if (count >= 3 && count <= 10) return `${underThousand(count)} ${scale.few}`;
  return `${underThousand(count)} ${scale.many}`;
}

/** A whole number in words. Zero is "صفر", which nothing else here produces. */
export function arabicWholeNumber(value: number): string {
  const n = Math.floor(Math.abs(value));
  if (n === 0) return "صفر";
  if (n > 999_999_999) return String(n);

  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1000);
  const rest = n % 1000;

  const parts: string[] = [];
  if (millions > 0) parts.push(scaled(millions, MILLION));
  if (thousands > 0) parts.push(scaled(thousands, THOUSAND));
  if (rest > 0) parts.push(underThousand(rest));

  return parts.join(" و");
}

/**
 * The line an invoice prints beneath its total.
 *
 * Bracketed by `فقط` and `لا غير` — "only" and "no more" — because the point
 * of the line is to close the figure off so nothing can be added to either
 * end of it afterwards.
 *
 * Piastres are named only when there are any. A receipt that says "and zero
 * piastres" reads like a machine wrote it, and the shop's own invoices do not.
 */
export function amountInArabicWords(
  amount: number | string,
  currency = { pounds: "جنيه مصرى", piastres: "قرش" },
): string {
  const value = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(value)) return "";

  const total = Math.round(Math.abs(value) * 100);
  const pounds = Math.floor(total / 100);
  const piastres = total % 100;

  const said =
    piastres > 0
      ? pounds > 0
        ? `${arabicWholeNumber(pounds)} ${currency.pounds} و${arabicWholeNumber(piastres)} ${currency.piastres}`
        : `${arabicWholeNumber(piastres)} ${currency.piastres}`
      : `${arabicWholeNumber(pounds)} ${currency.pounds}`;

  const sign = value < 0 ? "سالب " : "";
  return `فقط ${sign}${said} لا غير`;
}
