import { Decimal, dec, roundMoney, type Numeric } from "@/lib/money";

/**
 * What the business already had on the day it started keeping books.
 *
 * The whole difficulty is the cost. Stock is an asset and an asset has to be
 * carried at what it cost, but a shop opening its books usually knows what it
 * paid for the fabric and has no idea what any particular garment on the rail
 * cost to make — the run was two seasons ago and nobody wrote it down.
 *
 * Three answers, and the point of this module is that it always says which one
 * it used:
 *
 *   STATED                 somebody knew and typed it
 *   DERIVED_FROM_BOM       exploded from the style's own bill and minute rate
 *   ESTIMATED_FROM_RETAIL  a fraction of the selling price, because nothing better exists
 *
 * The third is a guess. It is allowed, because refusing it means the shop
 * cannot open its books at all, and a stock figure that is approximately right
 * beats no stock figure. But it is carried on the lot and said out loud
 * wherever a margin computed from it appears, because an estimate that stops
 * being labelled becomes a fact nobody checks.
 */

export type CostBasis = "STATED" | "DERIVED_FROM_BOM" | "ESTIMATED_FROM_RETAIL";

export type CostInputs = {
  /** What the person counting typed, where they typed anything. */
  statedCost?: Numeric | null;
  /** What the style's bill and minute rate come to, where the style has both. */
  bomCost?: Numeric | null;
  /** The selling price on file, which is the last resort's only input. */
  retailPrice?: Numeric | null;
  /** How much of a selling price the owner says is cost. 0.4 is forty per cent. */
  retailCostRatio?: Numeric | null;
};

export type CostVerdict = {
  unitCost: Decimal;
  basis: CostBasis;
  /** Why no figure could be reached, when none could. */
  refusal: string | null;
};

/**
 * Settles on a cost, and names where it came from.
 *
 * In that order on purpose. A typed figure beats a computed one because the
 * person holding the garment knows more than the bill does; a computed one
 * beats a guess for the obvious reason. Only when there is neither does the
 * selling price get used, and then the verdict says so.
 */
export function costFor(inputs: CostInputs): CostVerdict {
  const stated =
    inputs.statedCost == null || inputs.statedCost === ""
      ? null
      : typeof inputs.statedCost === "string"
        ? asNumber(inputs.statedCost)
        : dec(inputs.statedCost);
  if (stated && stated.greaterThan(0)) {
    return { unitCost: roundMoney(stated), basis: "STATED", refusal: null };
  }
  if (stated && stated.isZero()) {
    // Not the same as leaving it blank. Stock carried at nothing shows a
    // hundred per cent margin on everything it sells, which is the most
    // flattering wrong number a set of books can produce.
    return {
      unitCost: dec(0),
      basis: "STATED",
      refusal: "A cost of zero would show every sale of it as pure profit. Leave it blank to have one worked out.",
    };
  }

  const bom = inputs.bomCost == null ? null : dec(inputs.bomCost);
  if (bom && bom.greaterThan(0)) {
    return { unitCost: roundMoney(bom), basis: "DERIVED_FROM_BOM", refusal: null };
  }

  const retail = inputs.retailPrice == null ? null : dec(inputs.retailPrice);
  const ratio = inputs.retailCostRatio == null ? null : dec(inputs.retailCostRatio);

  if (!retail || retail.lessThanOrEqualTo(0)) {
    return {
      unitCost: dec(0),
      basis: "ESTIMATED_FROM_RETAIL",
      refusal: "Nobody typed a cost, the style has no bill to work one out from, and it has no selling price to estimate from either.",
    };
  }
  if (!ratio || ratio.lessThanOrEqualTo(0) || ratio.greaterThan(1)) {
    return {
      unitCost: dec(0),
      basis: "ESTIMATED_FROM_RETAIL",
      refusal: "No cost, and no ratio given to estimate one from the selling price.",
    };
  }

  return {
    unitCost: roundMoney(retail.times(ratio)),
    basis: "ESTIMATED_FROM_RETAIL",
    refusal: null,
  };
}

/**
 * A number out of a file, or nothing.
 *
 * `dec` throws on anything that is not one, so calling it straight on a cell
 * somebody typed turns a bad row into a crashed import — the whole file
 * refused because of one cell, with a stack trace instead of a row number.
 */
function asNumber(text: string): Decimal | null {
  const trimmed = text.trim();
  if (!trimmed || !/^-?\d*\.?\d+$/.test(trimmed)) return null;
  const value = dec(trimmed);
  return value.isFinite() ? value : null;
}

export type CountedRow = {
  rowNumber: number;
  /** `FABRIC`/`MATERIAL` by code, or `GARMENT`/`VARIANT` by SKU. */
  kind: string;
  code: string;
  location: string;
  quantity: string;
  unitCost: string;
};

export type RowVerdict =
  | { kind: "valid"; row: CountedRow; quantity: Decimal }
  | { kind: "invalid"; row: CountedRow; reason: string };

/**
 * Checks a counted row before anything is looked up.
 *
 * Only what can be decided from the row itself: whether it names a thing, how
 * much of it, and somewhere for it to be. Whether that code exists is the
 * database's question and is asked later, against the real tables.
 */
export function checkRow(row: CountedRow): RowVerdict {
  const kind = row.kind.trim().toUpperCase();
  if (!["FABRIC", "MATERIAL", "GARMENT", "VARIANT"].includes(kind)) {
    return {
      kind: "invalid",
      row,
      reason: `"${row.kind}" is not a kind. Use FABRIC for material, GARMENT for a finished piece.`,
    };
  }
  if (!row.code.trim()) {
    return { kind: "invalid", row, reason: "No code on this row." };
  }
  if (!row.location.trim()) {
    return { kind: "invalid", row, reason: "No location on this row — stock has to be somewhere." };
  }

  const quantity = asNumber(row.quantity);
  if (!quantity || quantity.lessThanOrEqualTo(0)) {
    return {
      kind: "invalid",
      row,
      reason: `"${row.quantity}" is not a quantity. Leave the row out rather than counting nothing.`,
    };
  }

  if (row.unitCost.trim() !== "") {
    const cost = asNumber(row.unitCost);
    if (!cost || cost.lessThan(0)) {
      return { kind: "invalid", row, reason: `"${row.unitCost}" is not a cost.` };
    }
  }

  return { kind: "valid", row, quantity };
}

/** True where the row names something the factory cuts rather than sells. */
export function isMaterial(kind: string): boolean {
  return ["FABRIC", "MATERIAL"].includes(kind.trim().toUpperCase());
}

/** The template the screen hands out, so the columns are never guessed at. */
export const OPENING_TEMPLATE_HEADER = "kind,code,location,quantity,unit_cost";
