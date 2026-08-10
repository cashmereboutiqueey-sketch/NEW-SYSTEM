import "server-only";
import { db } from "./db";
import { dec } from "./money";
import { imageUrl } from "./images";

/**
 * What the cashier can actually sell.
 *
 * Only variants with stock on the shelf at *this* till's location are
 * offered. Showing the full catalogue would let a cashier promise a customer
 * something the shop does not have, and the sale would then fail at checkout
 * with the customer still standing there.
 */
export async function sellableStock(locationId: string, entityId: string) {
  const lots = await db.inventoryLot.findMany({
    where: {
      locationId,
      entityId,
      state: "FINISHED_GOODS",
      remainingQty: { gt: 0 },
      variantId: { not: null },
    },
    include: {
      variant: {
        include: {
          style: { include: { collection: true } },
          colorCode: true,
          sizeCode: true,
        },
      },
    },
    orderBy: [{ receivedDate: "asc" }, { sequence: "asc" }],
  });

  // Several lots of the same SKU are one shelf position to a cashier.
  const byVariant = new Map<
    string,
    {
      variantId: string;
      sku: string;
      barcode: string | null;
      styleCode: string;
      styleEn: string;
      styleAr: string;
      colourEn: string;
      colourAr: string;
      hex: string | null;
      size: string;
      available: string;
      /** Suggested price from the style, editable at the till by permission. */
      retailPrice: string | null;
      /** The colour's own shot, falling back to the style's. */
      image: string | null;
      styleId: string;
      styleImage: string | null;
    }
  >();

  for (const lot of lots) {
    const v = lot.variant!;
    const existing = byVariant.get(v.id);
    if (existing) {
      existing.available = dec(existing.available).plus(dec(lot.remainingQty)).toString();
      continue;
    }
    byVariant.set(v.id, {
      variantId: v.id,
      sku: v.sku,
      barcode: v.barcode,
      styleCode: v.style.code,
      styleEn: v.style.nameEn,
      styleAr: v.style.nameAr,
      colourEn: v.colorCode.nameEn,
      colourAr: v.colorCode.nameAr,
      hex: v.colorCode.hex,
      size: v.sizeCode.code,
      available: dec(lot.remainingQty).toString(),
      retailPrice: v.style.retailPrice?.toString() ?? null,
      image: imageUrl(v.imageName) ?? imageUrl(v.style.imageName),
      styleId: v.styleId,
      styleImage: imageUrl(v.style.imageName),
    });
  }

  return [...byVariant.values()].sort((a, b) => a.sku.localeCompare(b.sku));
}

/** The till this cashier is currently working, if any. */
export async function openTillFor(locationId: string) {
  return db.posSession.findFirst({
    where: { locationId, closedAt: null },
    include: {
      cashier: true,
      location: true,
      orders: {
        include: { payments: true, lines: true },
        orderBy: { createdAt: "desc" },
      },
    },
  });
}

/** Running totals for the shift, so the cashier can see the drawer. */
export function tillTotals(session: NonNullable<Awaited<ReturnType<typeof openTillFor>>>) {
  const payments = session.orders.flatMap((o) => o.payments);
  const cash = payments
    .filter((p) => p.method === "CASH")
    .reduce((s, p) => s.plus(dec(p.amount)), dec(0));
  const card = payments
    .filter((p) => p.method === "CARD" || p.method === "WALLET")
    .reduce((s, p) => s.plus(dec(p.amount)), dec(0));
  const revenue = session.orders.reduce((s, o) => s.plus(dec(o.netAmount)), dec(0));
  const units = session.orders.reduce(
    (s, o) => s + o.lines.reduce((t, l) => t + l.quantity, 0),
    0,
  );

  return {
    orders: session.orders.length,
    units,
    revenue,
    cash,
    card,
    expectedDrawer: dec(session.openingFloat).plus(cash),
  };
}
