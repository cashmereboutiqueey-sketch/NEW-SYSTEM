import "server-only";
import { db } from "./db";
import { dec, sum, roundMoney, formatMoney, type Decimal } from "./money";

/**
 * Whether a sale may go through at the prices it was submitted with.
 *
 * The till and the order form both send a price per line from the browser,
 * where anybody can type into the box. On its own that made the discount
 * permission decorative: a cashier without it could not pick 10% from the
 * menu, but could type the price down to 1 and ring it up. So the price is
 * checked here against the price on file, before anything is sold.
 *
 * Selling below that price is a discount by another name and needs the
 * discount permission. Selling above it takes nothing from the business and is
 * left alone. A style with no price on file is the one case where a typed
 * price is how the screens are meant to work; there only a price of nothing is
 * refused, since giving a garment away is the largest discount there is.
 */

export class SalePriceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SalePriceError";
  }
}

type OwnedLine = { variantId: string; quantity: number; retailPrice: number; discountPct: number };
type ConsignedLine = { itemId: string; quantity: number; retailPrice: number };

function checkNumber(value: number, what: string): void {
  if (!Number.isFinite(value) || value < 0) throw new SalePriceError(`${what}: that is not a price.`);
}

export async function checkOwnedPrices(lines: OwnedLine[], canDiscount: boolean): Promise<void> {
  const variants = await db.variant.findMany({
    where: { id: { in: lines.map((l) => l.variantId) } },
    select: { id: true, sku: true, style: { select: { retailPrice: true } } },
  });
  const byId = new Map(variants.map((v) => [v.id, v]));

  for (const line of lines) {
    const v = byId.get(line.variantId);
    if (!v) throw new SalePriceError("A garment on this sale no longer exists. Remove it and add it again.");
    checkNumber(line.retailPrice, v.sku);
    if (canDiscount) continue;

    const onFile = v.style.retailPrice;
    if (onFile == null) {
      if (line.retailPrice <= 0) throw new SalePriceError(`${v.sku} has no price on file. Enter one.`);
    } else if (roundMoney(dec(line.retailPrice)).lessThan(roundMoney(dec(onFile)))) {
      throw new SalePriceError(
        `${v.sku} sells at ${formatMoney(onFile)}. Selling it for less is a discount, ` +
          `and needs somebody who may give one.`,
      );
    }
  }
}

export async function checkConsignedPrices(
  lines: ConsignedLine[],
  canDiscount: boolean,
): Promise<void> {
  if (lines.length === 0) return;
  const items = await db.consignmentItem.findMany({
    where: { id: { in: lines.map((l) => l.itemId) } },
    select: { id: true, description: true, retailPrice: true },
  });
  const byId = new Map(items.map((i) => [i.id, i]));

  for (const line of lines) {
    const i = byId.get(line.itemId);
    if (!i) throw new SalePriceError("A consigned item on this sale is no longer here.");
    checkNumber(line.retailPrice, i.description);
    if (canDiscount) continue;
    if (roundMoney(dec(line.retailPrice)).lessThan(dec(i.retailPrice))) {
      throw new SalePriceError(
        `${i.description} sells at ${formatMoney(i.retailPrice)}. Selling it for less ` +
          `needs somebody who may give a discount.`,
      );
    }
  }
}

/**
 * What owned lines come to, worked out the way `createSale` works out the
 * invoice: unit price rounded, discount applied and rounded, then multiplied
 * by a whole quantity. Any other order of rounding disagrees by a piastre.
 */
export function ownedTotal(lines: OwnedLine[]): Decimal {
  return sum(
    lines.map((l) =>
      roundMoney(roundMoney(dec(l.retailPrice)).times(dec(1).minus(dec(l.discountPct)))).times(
        l.quantity,
      ),
    ),
  );
}

/** What consigned lines come to, the way `sellConsignedItem` rounds them. */
export function consignedTotal(lines: ConsignedLine[]): Decimal {
  return sum(lines.map((l) => roundMoney(roundMoney(dec(l.retailPrice)).times(l.quantity))));
}
