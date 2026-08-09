import "server-only";
import { db } from "./db";
import { dec } from "./money";
import {
  DEFAULT_LABEL_FORMAT,
  type ReceiptData,
  type InvoiceData,
  type LabelData,
  type LabelFormat,
} from "@/components/print-documents";
import { unitsForDespatch, unitsForProductionOrder } from "./garment-units";

/**
 * Builds printable documents from what is actually recorded.
 *
 * A printed document is evidence, so every figure on it comes from the stored
 * record rather than being recalculated at print time. A receipt that
 * recomputes its own total can disagree with the sale it claims to represent.
 */

export async function businessDetails() {
  const settings = await db.setting.findMany({
    where: { key: { startsWith: "business." } },
  });
  const value = (key: string, fallback: string) =>
    settings.find((s) => s.key === key)?.value ?? fallback;

  return {
    nameEn: value("business.nameEn", "Cashmere Boutique"),
    nameAr: value("business.nameAr", "كاشمير بوتيك"),
    addressLine: value("business.address", ""),
    phone: value("business.phone", ""),
    taxId: value("business.taxId", ""),
  };
}

export async function receiptFor(salesOrderId: string): Promise<ReceiptData | null> {
  const order = await db.salesOrder.findUnique({
    where: { id: salesOrderId },
    include: {
      lines: {
        include: {
          variant: { include: { style: true, colorCode: true, sizeCode: true } },
        },
      },
      customer: true,
      location: true,
      createdBy: true,
      payments: true,
      posSession: { include: { cashier: true } },
    },
  });
  if (!order) return null;

  const cash = order.payments.find((p) => p.method === "CASH");

  return {
    orderNumber: order.orderNumber,
    date: order.createdAt,
    locationEn: order.location?.nameEn ?? "",
    locationAr: order.location?.nameAr ?? "",
    cashier: order.posSession?.cashier.name ?? order.createdBy?.name ?? "—",
    customerName: order.customer?.name ?? null,
    lines: order.lines.map((l) => ({
      sku: l.variant.sku,
      nameEn: `${l.variant.style.nameEn} · ${l.variant.colorCode.nameEn} · ${l.variant.sizeCode.code}`,
      nameAr: `${l.variant.style.nameAr} · ${l.variant.colorCode.nameAr} · ${l.variant.sizeCode.code}`,
      quantity: l.quantity,
      // The price stored on the line, not the style's current price — a
      // reprinted receipt must show what was actually charged.
      unitPrice: l.netPrice.toString(),
      lineTotal: l.lineTotal.toString(),
    })),
    grossAmount: order.grossAmount.toString(),
    discountAmount: order.discountAmount.toString(),
    shippingAmount: order.shippingAmount.toString(),
    netAmount: order.netAmount.toString(),
    paymentMethod: order.payments[0]?.method ?? null,
    tendered: cash ? cash.amount.toString() : null,
    change: null,
  };
}

/** The Factory's internal invoice to the Brand for a transfer. */
export async function transferInvoiceFor(
  transferNumber: string,
): Promise<InvoiceData | null> {
  const movements = await db.inventoryMovement.findMany({
    where: { referenceType: "TRANSFER_INVOICE", referenceId: transferNumber, type: "RECEIPT" },
    include: {
      lot: {
        include: {
          variant: { include: { style: true, colorCode: true, sizeCode: true } },
          sourceCostSnapshot: true,
        },
      },
    },
  });
  if (movements.length === 0) return null;

  const [factory, brand] = await Promise.all([
    db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } }),
    db.entity.findFirstOrThrow({ where: { kind: "BRAND" } }),
  ]);

  const lines = movements.map((m) => ({
    code: m.lot.variant?.sku ?? "—",
    descriptionEn: m.lot.variant
      ? `${m.lot.variant.style.nameEn} · ${m.lot.variant.colorCode.nameEn} · ${m.lot.variant.sizeCode.code}`
      : "—",
    descriptionAr: m.lot.variant
      ? `${m.lot.variant.style.nameAr} · ${m.lot.variant.colorCode.nameAr} · ${m.lot.variant.sizeCode.code}`
      : "—",
    quantity: m.quantity.toString(),
    unit: null,
    unitPrice: m.unitCost.toString(),
    lineTotal: m.totalCost.toString(),
  }));

  const total = lines.reduce((s, l) => s.plus(dec(l.lineTotal)), dec(0));

  return {
    documentTitleEn: "Internal transfer invoice",
    documentTitleAr: "فاتورة تحويل داخلي",
    number: transferNumber,
    date: movements[0].movementDate,
    partyNameEn: brand.nameEn,
    partyNameAr: brand.nameAr,
    reference: factory.nameEn,
    lines,
    subtotal: total.toString(),
    total: total.toString(),
    noteEn:
      "Internal transfer at arm's-length transfer price. Eliminated on consolidation.",
    noteAr:
      "تحويل داخلي بسعر التحويل العادل. يُحذف عند إعداد قوائم المجموعة.",
  };
}

export async function purchaseOrderDocumentFor(
  purchaseOrderId: string,
): Promise<InvoiceData | null> {
  const order = await db.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    include: {
      supplier: true,
      lines: { include: { material: { include: { uom: true } } } },
    },
  });
  if (!order) return null;

  const lines = order.lines.map((l) => ({
    code: l.material.code,
    descriptionEn: l.material.nameEn,
    descriptionAr: l.material.nameAr,
    quantity: l.quantity.toString(),
    unit: l.material.uom.code,
    unitPrice: l.unitPrice.toString(),
    lineTotal: dec(l.unitPrice).times(dec(l.quantity)).toString(),
  }));

  const total = lines.reduce((s, l) => s.plus(dec(l.lineTotal)), dec(0));

  return {
    documentTitleEn: "Purchase order",
    documentTitleAr: "أمر شراء",
    number: order.poNumber,
    date: order.orderDate,
    dueDate: order.dueDate,
    partyNameEn: order.supplier.nameEn,
    partyNameAr: order.supplier.nameAr,
    reference: order.expectedDate
      ? `Expected ${order.expectedDate.toISOString().slice(0, 10)}`
      : null,
    lines,
    subtotal: total.toString(),
    total: total.toString(),
    noteEn: `Prices are ex-VAT and exclude freight and duty. Payment terms: ${order.creditDays} days.`,
    noteAr: `الأسعار بدون ضريبة ولا تشمل الشحن والجمارك. مدة السداد: ${order.creditDays} يومًا.`,
  };
}

/**
 * The physical measurements of whatever roll is in the printer.
 *
 * Read from settings rather than fixed here, because changing the stationery
 * is a shop decision, not a code change.
 */
export async function labelFormat(): Promise<LabelFormat> {
  const rows = await db.setting.findMany({ where: { key: { startsWith: "label." } } });
  const value = (key: string) => rows.find((r) => r.key === key)?.value;

  const number = (key: string, fallback: number) => {
    const raw = value(key);
    const parsed = raw == null ? NaN : Number(raw);
    // A width of zero or a missing setting would print an empty roll, so a
    // nonsense value falls back rather than being obeyed.
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };

  return {
    widthMm: number("label.widthMm", DEFAULT_LABEL_FORMAT.widthMm),
    heightMm: number("label.heightMm", DEFAULT_LABEL_FORMAT.heightMm),
    gapMm: number("label.gapMm", DEFAULT_LABEL_FORMAT.gapMm),
    moduleWidthMm: number("label.moduleWidthMm", DEFAULT_LABEL_FORMAT.moduleWidthMm),
    barcodeHeightMm: number("label.barcodeHeightMm", DEFAULT_LABEL_FORMAT.barcodeHeightMm),
    showPrice: value("label.showPrice") !== "false",
  };
}

type UnitWithVariant = {
  serial: string;
  variant: {
    sku: string;
    style: { nameEn: string; nameAr: string; retailPrice: unknown };
    colorCode: { nameEn: string; nameAr: string };
    sizeCode: { code: string };
  };
};

function toLabel(unit: UnitWithVariant): LabelData {
  return {
    serial: unit.serial,
    sku: unit.variant.sku,
    nameEn: unit.variant.style.nameEn,
    nameAr: unit.variant.style.nameAr,
    colourEn: unit.variant.colorCode.nameEn,
    colourAr: unit.variant.colorCode.nameAr,
    size: unit.variant.sizeCode.code,
    price: unit.variant.style.retailPrice?.toString() ?? null,
  };
}

/**
 * One label per garment in a delivery.
 *
 * A delivery is the unit the receiving bay works in: this is the batch someone
 * is holding when they print. Every label carries its own code, so the roll
 * that comes out matches the garments one for one and cannot be reused for the
 * next box.
 */
export async function labelsForDespatch(despatchNumber: string): Promise<LabelData[]> {
  const units = await unitsForDespatch(despatchNumber);
  return units.map(toLabel);
}

/** One label per garment a production run produced. */
export async function labelsForProductionOrder(
  productionOrderId: string,
): Promise<LabelData[]> {
  const units = await unitsForProductionOrder(productionOrderId);
  return units.map(toLabel);
}

/**
 * Labels for a style, for reprinting a tag that fell off or got soaked.
 *
 * Only garments that still exist and are still somewhere: reprinting the tag
 * of something already sold puts a live code on a garment that is not in the
 * shop, and the next scan of it would be a mystery.
 */
export async function labelsForStyle(
  styleId: string,
  options: { onlyAt?: string | null } = {},
): Promise<LabelData[]> {
  const units = await db.garmentUnit.findMany({
    where: {
      variant: { styleId },
      status: { in: ["MADE", "IN_TRANSIT", "IN_STOCK"] },
      ...(options.onlyAt ? { locationId: options.onlyAt } : {}),
    },
    include: { variant: { include: { style: true, colorCode: true, sizeCode: true } } },
    orderBy: { serial: "asc" },
  });

  return units.map(toLabel);
}
