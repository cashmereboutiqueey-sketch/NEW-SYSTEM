import "server-only";
import { db } from "./db";
import { dec } from "./money";
import type { ReceiptData, InvoiceData, LabelData } from "@/components/print-documents";

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
 * Labels for a style's SKUs, repeated by how many garments were made.
 *
 * Quantities come from what is actually in stock, so a run of 388 garments
 * produces 388 labels rather than one per SKU that somebody then has to
 * photocopy.
 */
export async function labelsForStyle(
  styleId: string,
  options: { perSku?: number; useStock?: boolean } = {},
): Promise<LabelData[]> {
  const style = await db.style.findUnique({
    where: { id: styleId },
    include: {
      variants: {
        where: { isActive: true },
        include: { colorCode: true, sizeCode: true },
        orderBy: { sku: "asc" },
      },
    },
  });
  if (!style) return [];

  const stock = options.useStock
    ? await db.inventoryLot.groupBy({
        by: ["variantId"],
        where: {
          variantId: { in: style.variants.map((v) => v.id) },
          state: "FINISHED_GOODS",
          remainingQty: { gt: 0 },
        },
        _sum: { remainingQty: true },
      })
    : [];

  const countFor = (variantId: string) => {
    if (!options.useStock) return options.perSku ?? 1;
    const row = stock.find((s) => s.variantId === variantId);
    return Math.round(Number(row?._sum.remainingQty ?? 0));
  };

  const labels: LabelData[] = [];
  for (const v of style.variants) {
    const count = countFor(v.id);
    for (let i = 0; i < count; i++) {
      labels.push({
        sku: v.sku,
        nameEn: style.nameEn,
        nameAr: style.nameAr,
        colourEn: v.colorCode.nameEn,
        colourAr: v.colorCode.nameAr,
        size: v.sizeCode.code,
        price: style.retailPrice?.toString() ?? null,
      });
    }
  }

  return labels;
}
