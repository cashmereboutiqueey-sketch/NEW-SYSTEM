import { Decimal, dec, sum, type Numeric } from "@/lib/money";

/**
 * Double-entry rules, as pure functions.
 *
 * No Prisma, no Next.js — the database enforces these same rules with
 * triggers, and the server actions enforce them again before touching the
 * database. That duplication is intentional: this layer gives a usable error
 * message before a transaction is opened, and the trigger guarantees the
 * ledger stays correct even if some future caller forgets to ask.
 */

export type DraftLine = {
  accountId: string;
  debit?: Numeric;
  credit?: Numeric;
  entityId: string;
  costCenterId?: string | null;
  supplierId?: string | null;
  customerId?: string | null;
  styleId?: string | null;
  variantId?: string | null;
  appliedTaxRate?: Numeric | null;
  description?: string | null;
};

export type LedgerViolation =
  | { code: "NO_LINES" }
  | { code: "TOO_FEW_LINES"; lineCount: number }
  | { code: "LINE_HAS_BOTH"; lineIndex: number }
  | { code: "LINE_HAS_NEITHER"; lineIndex: number }
  | { code: "LINE_NEGATIVE"; lineIndex: number }
  | { code: "UNBALANCED"; debit: string; credit: string; difference: string };

export type LedgerCheck =
  | { ok: true; totalDebit: Decimal; totalCredit: Decimal }
  | { ok: false; violations: LedgerViolation[] };

/**
 * A posting must have at least two lines, each carrying exactly one non-zero,
 * non-negative side, and its debits must equal its credits exactly.
 *
 * Equality is exact rather than tolerance-based: with Decimal there is no
 * representation error to absorb, so a mismatch of 0.0001 EGP is a real bug,
 * not rounding noise.
 */
export function checkBalanced(lines: DraftLine[]): LedgerCheck {
  const violations: LedgerViolation[] = [];

  if (lines.length === 0) {
    return { ok: false, violations: [{ code: "NO_LINES" }] };
  }
  if (lines.length < 2) {
    violations.push({ code: "TOO_FEW_LINES", lineCount: lines.length });
  }

  lines.forEach((line, i) => {
    const debit = dec(line.debit ?? 0);
    const credit = dec(line.credit ?? 0);

    if (debit.isNegative() || credit.isNegative()) {
      violations.push({ code: "LINE_NEGATIVE", lineIndex: i });
      return;
    }
    const hasDebit = debit.greaterThan(0);
    const hasCredit = credit.greaterThan(0);
    if (hasDebit && hasCredit) violations.push({ code: "LINE_HAS_BOTH", lineIndex: i });
    if (!hasDebit && !hasCredit) violations.push({ code: "LINE_HAS_NEITHER", lineIndex: i });
  });

  const totalDebit = sum(lines.map((l) => dec(l.debit ?? 0)));
  const totalCredit = sum(lines.map((l) => dec(l.credit ?? 0)));

  if (!totalDebit.equals(totalCredit)) {
    violations.push({
      code: "UNBALANCED",
      debit: totalDebit.toString(),
      credit: totalCredit.toString(),
      difference: totalDebit.minus(totalCredit).toString(),
    });
  }

  if (violations.length > 0) return { ok: false, violations };
  return { ok: true, totalDebit, totalCredit };
}

/** Human-readable reason, for surfacing a rejected posting in the UI. */
export function describeViolation(v: LedgerViolation): string {
  switch (v.code) {
    case "NO_LINES":
      return "A journal entry must have lines.";
    case "TOO_FEW_LINES":
      return `A double entry needs at least two lines; this one has ${v.lineCount}.`;
    case "LINE_HAS_BOTH":
      return `Line ${v.lineIndex + 1} has both a debit and a credit; it must have exactly one.`;
    case "LINE_HAS_NEITHER":
      return `Line ${v.lineIndex + 1} has neither a debit nor a credit.`;
    case "LINE_NEGATIVE":
      return `Line ${v.lineIndex + 1} has a negative amount; reverse the side instead.`;
    case "UNBALANCED":
      return `Entry does not balance: debits ${v.debit}, credits ${v.credit} (difference ${v.difference}).`;
  }
}

/**
 * Reverses a set of lines by swapping each debit and credit, preserving every
 * dimension. Used to build a correcting entry — a posted entry is never edited.
 */
export function reverseLines(lines: DraftLine[]): DraftLine[] {
  return lines.map((l) => ({
    ...l,
    debit: dec(l.credit ?? 0),
    credit: dec(l.debit ?? 0),
  }));
}

/**
 * Splits a VAT-inclusive gross amount into its net and tax parts.
 *
 * Needed because external channels may quote tax-inclusive prices while the
 * ledger stores everything ex-VAT. `net + tax` is guaranteed to equal `gross`
 * exactly, so a posting built from the result cannot fail to balance.
 */
export function splitTaxInclusive(
  gross: Numeric,
  rate: Numeric,
): { net: Decimal; tax: Decimal } {
  const g = dec(gross);
  const r = dec(rate);
  const net = g.div(r.plus(1));
  return { net, tax: g.minus(net) };
}

/** Adds VAT to a tax-exclusive amount. */
export function applyTaxExclusive(
  net: Numeric,
  rate: Numeric,
): { net: Decimal; tax: Decimal; gross: Decimal } {
  const n = dec(net);
  const tax = n.times(dec(rate));
  return { net: n, tax, gross: n.plus(tax) };
}
