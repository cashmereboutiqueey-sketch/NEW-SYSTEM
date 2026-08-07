import { describe, it, expect } from "vitest";
import {
  checkBalanced,
  reverseLines,
  splitTaxInclusive,
  applyTaxExclusive,
  type DraftLine,
} from "./ledger";
import { dec } from "@/lib/money";

const E = "entity_factory";

function line(over: Partial<DraftLine>): DraftLine {
  return { accountId: "acc", entityId: E, ...over };
}

describe("checkBalanced", () => {
  it("accepts a balanced two-line entry", () => {
    const result = checkBalanced([
      line({ accountId: "expense", debit: "55000" }),
      line({ accountId: "payable", credit: "55000" }),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.totalDebit.toString()).toBe("55000");
      expect(result.totalCredit.toString()).toBe("55000");
    }
  });

  it("accepts a multi-line entry that balances in aggregate", () => {
    // Rent 55,000 ex-VAT plus 14% input VAT, one payable for the gross.
    const result = checkBalanced([
      line({ accountId: "rent", debit: "55000" }),
      line({ accountId: "input_vat", debit: "7700" }),
      line({ accountId: "payable", credit: "62700" }),
    ]);
    expect(result.ok).toBe(true);
  });

  it("rejects an unbalanced entry and reports the difference", () => {
    const result = checkBalanced([
      line({ accountId: "expense", debit: "100" }),
      line({ accountId: "payable", credit: "60" }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const unbalanced = result.violations.find((v) => v.code === "UNBALANCED");
      expect(unbalanced).toMatchObject({ debit: "100", credit: "60", difference: "40" });
    }
  });

  it("rejects a difference of a single piastre rather than tolerating it", () => {
    const result = checkBalanced([
      line({ accountId: "expense", debit: "100.0001" }),
      line({ accountId: "payable", credit: "100" }),
    ]);
    expect(result.ok).toBe(false);
  });

  it("rejects a line carrying both a debit and a credit", () => {
    const result = checkBalanced([
      line({ accountId: "a", debit: "50", credit: "50" }),
      line({ accountId: "b", credit: "50", debit: "50" }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.code === "LINE_HAS_BOTH")).toBe(true);
    }
  });

  it("rejects a zero-value line", () => {
    const result = checkBalanced([
      line({ accountId: "a", debit: "0" }),
      line({ accountId: "b", credit: "0" }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.code === "LINE_HAS_NEITHER")).toBe(true);
    }
  });

  it("rejects negative amounts instead of letting them offset each other", () => {
    const result = checkBalanced([
      line({ accountId: "a", debit: "-100" }),
      line({ accountId: "b", credit: "-100" }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.filter((v) => v.code === "LINE_NEGATIVE")).toHaveLength(2);
    }
  });

  it("rejects a single-line entry", () => {
    const result = checkBalanced([line({ accountId: "a", debit: "100" })]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.code === "TOO_FEW_LINES")).toBe(true);
    }
  });

  it("rejects an empty entry", () => {
    const result = checkBalanced([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]).toEqual({ code: "NO_LINES" });
    }
  });

  it("stays exact across many fractional lines where floats would drift", () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point; with Decimal it must.
    const lines = [
      line({ accountId: "a", debit: "0.1" }),
      line({ accountId: "b", debit: "0.2" }),
      line({ accountId: "c", credit: "0.3" }),
    ];
    expect(checkBalanced(lines).ok).toBe(true);
  });
});

describe("reverseLines", () => {
  it("swaps debits and credits while preserving dimensions", () => {
    const original: DraftLine[] = [
      line({ accountId: "rent", debit: "55000", costCenterId: "cc-factory", supplierId: "sup-1" }),
      line({ accountId: "payable", credit: "55000", supplierId: "sup-1" }),
    ];
    const reversed = reverseLines(original);

    expect(dec(reversed[0].credit).toString()).toBe("55000");
    expect(dec(reversed[0].debit).toString()).toBe("0");
    expect(reversed[0].costCenterId).toBe("cc-factory");
    expect(reversed[0].supplierId).toBe("sup-1");
    expect(checkBalanced(reversed).ok).toBe(true);
  });

  it("nets to zero against the original", () => {
    const original: DraftLine[] = [
      line({ accountId: "rent", debit: "1234.5678" }),
      line({ accountId: "payable", credit: "1234.5678" }),
    ];
    const combined = [...original, ...reverseLines(original)];
    const result = checkBalanced(combined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.totalDebit.toString()).toBe(result.totalCredit.toString());
    }
  });
});

describe("tax splitting", () => {
  it("splits a VAT-inclusive amount so net + tax equals gross exactly", () => {
    const { net, tax } = splitTaxInclusive("114", "0.14");
    expect(net.toString()).toBe("100");
    expect(tax.toString()).toBe("14");
    expect(net.plus(tax).toString()).toBe("114");
  });

  it("keeps net + tax === gross even when the split does not divide evenly", () => {
    const gross = "999.99";
    const { net, tax } = splitTaxInclusive(gross, "0.14");
    // The point is not a round net figure — it is that a posting built from
    // these two numbers can never fail to balance.
    expect(net.plus(tax).toString()).toBe(gross);
  });

  it("adds VAT to a tax-exclusive amount", () => {
    const { net, tax, gross } = applyTaxExclusive("55000", "0.14");
    expect(net.toString()).toBe("55000");
    expect(tax.toString()).toBe("7700");
    expect(gross.toString()).toBe("62700");
  });

  it("treats a zero rate as exempt rather than dividing by zero", () => {
    const inclusive = splitTaxInclusive("500", "0");
    expect(inclusive.net.toString()).toBe("500");
    expect(inclusive.tax.toString()).toBe("0");

    const exclusive = applyTaxExclusive("500", "0");
    expect(exclusive.gross.toString()).toBe("500");
  });

  it("produces lines that balance when posting a VAT-inclusive sale", () => {
    const { net, tax } = splitTaxInclusive("1140", "0.14");
    const posting = checkBalanced([
      line({ accountId: "cash", debit: "1140" }),
      line({ accountId: "revenue", credit: net }),
      line({ accountId: "output_vat", credit: tax }),
    ]);
    expect(posting.ok).toBe(true);
  });
});
