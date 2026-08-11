import "server-only";
import { z } from "zod";
import { db } from "./db";
import { nextDocumentNumber } from "./ledger";
import { receiveMaterial } from "./inventory";
import { writeAudit, type AuditContext } from "./audit";
import { purchaseOrderReceivable, approvalThreshold } from "./approvals";
import { dec, roundMoney } from "./money";

/**
 * Purchasing: order, receive, and account for the difference.
 *
 * The point of raising an order before receiving goods is that the two can
 * then disagree. Purchase price variance — the invoice saying 112 when the
 * order said 95 — is the number that explains why a garment suddenly costs
 * more, and it only exists if the intent was recorded first.
 */

export class PurchasingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurchasingError";
  }
}

export const purchaseOrderSchema = z.object({
  supplierId: z.string().min(1, "Choose a supplier."),
  orderDate: z.coerce.date(),
  expectedDate: z.coerce.date().nullable().optional(),
  notes: z.string().nullable().optional(),
  lines: z
    .array(
      z.object({
        materialId: z.string().min(1),
        quantity: z.coerce.number().positive("Quantity must be greater than zero."),
        unitPrice: z.coerce.number().min(0),
      }),
    )
    .min(1, "A purchase order needs at least one line."),
});

export type PurchaseOrderInput = z.input<typeof purchaseOrderSchema>;

export async function createPurchaseOrder(
  input: PurchaseOrderInput,
  ctx: AuditContext,
): Promise<{ purchaseOrderId: string; poNumber: string; total: string }> {
  const data = purchaseOrderSchema.parse(input);

  const supplier = await db.supplier.findUnique({ where: { id: data.supplierId } });
  if (!supplier) throw new PurchasingError("Supplier not found.");
  if (!supplier.isActive) {
    throw new PurchasingError(`${supplier.nameEn} is inactive and cannot take new orders.`);
  }

  const materials = await db.material.findMany({
    where: { id: { in: data.lines.map((l) => l.materialId) } },
  });
  const byId = new Map(materials.map((m) => [m.id, m]));

  // A small order commits the moment it is raised; a large one is a proposal
  // until somebody signs it. Making every order wait would leave a hundred
  // pounds of buttons sitting in an inbox behind a fabric order, and the
  // inbox would stop being read.
  const orderValue = data.lines.reduce(
    (s, l) => s.plus(dec(l.quantity).times(dec(l.unitPrice))),
    dec(0),
  );
  const needsApproval = orderValue.greaterThan(await approvalThreshold());

  return db.$transaction(async (tx) => {
    const poNumber = await nextDocumentNumber(tx, "PUR", data.orderDate);

    // Credit terms come from the supplier record, so the due date the payables
    // report ages against is the one that was actually agreed.
    const dueDate = data.expectedDate
      ? new Date(data.expectedDate.getTime() + supplier.creditDays * 86_400_000)
      : null;

    let total = dec(0);
    const order = await tx.purchaseOrder.create({
      data: {
        createdByUserId: ctx.userId,
        poNumber,
        supplierId: data.supplierId,
        status: needsApproval ? "DRAFT" : "CONFIRMED",
        orderDate: data.orderDate,
        expectedDate: data.expectedDate ?? null,
        creditDays: supplier.creditDays,
        dueDate,
        notes: data.notes ?? null,
        lines: {
          create: data.lines.map((l) => {
            const material = byId.get(l.materialId);
            if (!material) throw new PurchasingError("Material not found.");

            // Freight and duty come from the material master and are carried
            // on the line, so a later change to the master cannot restate what
            // this order was placed at.
            const effectiveCost = roundMoney(
              dec(l.unitPrice).times(
                dec(material.freightPct).plus(dec(material.dutyPct)).plus(1),
              ),
            );
            total = total.plus(effectiveCost.times(dec(l.quantity)));

            return {
              materialId: l.materialId,
              quantity: dec(l.quantity).toString(),
              unitPrice: roundMoney(dec(l.unitPrice)).toString(),
              freightPct: material.freightPct,
              dutyPct: material.dutyPct,
              effectiveCost: effectiveCost.toString(),
            };
          }),
        },
      },
    });

    await writeAudit(tx, {
      action: "PURCHASE_ORDER_CREATED",
      entityName: "PurchaseOrder",
      entityId: order.id,
      after: {
        poNumber,
        supplier: supplier.code,
        lines: data.lines.length,
        total: total.toString(),
      },
      ctx,
    });

    return { purchaseOrderId: order.id, poNumber, total: total.toString() };
  });
}

export const goodsReceiptSchema = z.object({
  purchaseOrderId: z.string().min(1),
  receivedDate: z.coerce.date(),
  locationId: z.string().min(1, "Choose where the goods are being received."),
  entityId: z.string().min(1),
  invoiceRef: z.string().nullable().optional(),
  lines: z
    .array(
      z.object({
        purchaseOrderLineId: z.string().min(1),
        acceptedQty: z.coerce.number().min(0),
        rejectedQty: z.coerce.number().min(0).default(0),
        /** What the invoice actually says, which may differ from the order. */
        actualUnitPrice: z.coerce.number().min(0),
      }),
    )
    .min(1),
});

export type GoodsReceiptInput = z.input<typeof goodsReceiptSchema>;

/**
 * Receives goods against an order and puts them into stock.
 *
 * Only accepted quantities enter inventory — rejected goods are recorded but
 * never become stock the factory could try to cut. Each accepted line creates
 * its own FIFO lot at the price actually invoiced, so a price rise is carried
 * by the metres it applies to and not smeared across older stock.
 */
export async function receiveGoods(
  input: GoodsReceiptInput,
  ctx: AuditContext,
): Promise<{
  receiptNumber: string;
  lotsCreated: number;
  priceVariance: string;
}> {
  const data = goodsReceiptSchema.parse(input);

  const order = await db.purchaseOrder.findUnique({
    where: { id: data.purchaseOrderId },
    include: { lines: { include: { material: true } }, supplier: true },
  });
  if (!order) throw new PurchasingError("Purchase order not found.");
  if (order.status === "CANCELLED") {
    throw new PurchasingError(`Order ${order.poNumber} was cancelled.`);
  }
  if (order.status === "RECEIVED") {
    throw new PurchasingError(`Order ${order.poNumber} has already been fully received.`);
  }

  // A large order is a commitment the business makes, not one a buyer makes
  // alone. Receiving against an unapproved order would make the approval a
  // formality performed after the fabric is already on the shelf.
  const receivable = await purchaseOrderReceivable(order.id);
  if (!receivable.ok) throw new PurchasingError(receivable.reason ?? "This order is not approved.");

  const byLineId = new Map(order.lines.map((l) => [l.id, l]));

  for (const l of data.lines) {
    const orderLine = byLineId.get(l.purchaseOrderLineId);
    if (!orderLine) throw new PurchasingError("That line is not on this purchase order.");

    const alreadyReceived = dec(orderLine.receivedQty);
    const nowReceiving = dec(l.acceptedQty).plus(dec(l.rejectedQty));
    const outstanding = dec(orderLine.quantity).minus(alreadyReceived);

    if (nowReceiving.greaterThan(outstanding)) {
      // Over-receipt is refused rather than absorbed: it usually means a
      // delivery was booked against the wrong order, and accepting it puts
      // stock in that no order accounts for.
      throw new PurchasingError(
        `${orderLine.material.code}: receiving ${nowReceiving.toString()} but only ${outstanding.toString()} is outstanding on this order.`,
      );
    }
  }

  const receiptNumber = await db.$transaction((tx) =>
    nextDocumentNumber(tx, "GRN", data.receivedDate),
  );

  let totalVariance = dec(0);
  let lotsCreated = 0;

  // Each accepted line becomes its own lot through the inventory service, so
  // the stock ledger and its journal stay in the one place that writes them.
  for (const l of data.lines) {
    const orderLine = byLineId.get(l.purchaseOrderLineId)!;
    const accepted = dec(l.acceptedQty);

    const actualEffectiveCost = roundMoney(
      dec(l.actualUnitPrice).times(
        dec(orderLine.freightPct).plus(dec(orderLine.dutyPct)).plus(1),
      ),
    );
    const variance = dec(l.actualUnitPrice)
      .minus(dec(orderLine.unitPrice))
      .times(accepted);
    totalVariance = totalVariance.plus(variance);

    if (accepted.greaterThan(0)) {
      await receiveMaterial(
        {
          materialId: orderLine.materialId,
          locationId: data.locationId,
          entityId: data.entityId,
          quantity: accepted.toString(),
          unitCost: actualEffectiveCost.toString(),
          receivedDate: data.receivedDate,
          supplierId: order.supplierId,
          referenceType: "GOODS_RECEIPT",
          referenceId: receiptNumber,
        },
        ctx,
      );
      lotsCreated += 1;
    }
  }

  return db.$transaction(async (tx) => {
    const receipt = await tx.goodsReceipt.create({
      data: {
        receiptNumber,
        purchaseOrderId: order.id,
        receivedDate: data.receivedDate,
        invoiceRef: data.invoiceRef ?? null,
        lines: {
          create: data.lines.map((l) => {
            const orderLine = byLineId.get(l.purchaseOrderLineId)!;
            const accepted = dec(l.acceptedQty);
            const actualEffectiveCost = roundMoney(
              dec(l.actualUnitPrice).times(
                dec(orderLine.freightPct).plus(dec(orderLine.dutyPct)).plus(1),
              ),
            );
            const variance = dec(l.actualUnitPrice)
              .minus(dec(orderLine.unitPrice))
              .times(accepted);
            const variancePct = dec(orderLine.unitPrice).isZero()
              ? dec(0)
              : dec(l.actualUnitPrice).minus(dec(orderLine.unitPrice)).div(dec(orderLine.unitPrice));

            return {
              purchaseOrderLineId: l.purchaseOrderLineId,
              quantity: accepted.plus(dec(l.rejectedQty)).toString(),
              acceptedQty: accepted.toString(),
              rejectedQty: dec(l.rejectedQty).toString(),
              orderedUnitPrice: orderLine.unitPrice,
              actualUnitPrice: roundMoney(dec(l.actualUnitPrice)).toString(),
              actualEffectiveCost: actualEffectiveCost.toString(),
              priceVariance: variance.toString(),
              priceVariancePct: variancePct.toString(),
            };
          }),
        },
      },
    });

    for (const l of data.lines) {
      await tx.purchaseOrderLine.update({
        where: { id: l.purchaseOrderLineId },
        data: {
          receivedQty: {
            increment: dec(l.acceptedQty).plus(dec(l.rejectedQty)).toString(),
          },
        },
      });
    }

    const refreshed = await tx.purchaseOrderLine.findMany({
      where: { purchaseOrderId: order.id },
    });
    const complete = refreshed.every((l) =>
      dec(l.receivedQty).greaterThanOrEqualTo(dec(l.quantity)),
    );

    await tx.purchaseOrder.update({
      where: { id: order.id },
      data: { status: complete ? "RECEIVED" : "PARTIALLY_RECEIVED" },
    });

    await writeAudit(tx, {
      action: "GOODS_RECEIVED",
      entityName: "PurchaseOrder",
      entityId: order.id,
      after: {
        receiptNumber,
        lotsCreated,
        priceVariance: totalVariance.toString(),
        status: complete ? "RECEIVED" : "PARTIALLY_RECEIVED",
      },
      ctx,
    });

    return {
      receiptNumber: receipt.receiptNumber,
      lotsCreated,
      priceVariance: totalVariance.toString(),
    };
  });
}
