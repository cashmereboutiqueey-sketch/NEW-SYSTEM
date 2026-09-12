import "server-only";
import { z } from "zod";
import { db } from "./db";
import { nextDocumentNumber, postEntry } from "./ledger";
import { receiveMaterial } from "./inventory";
import { writeAudit, type AuditContext } from "./audit";
import { purchaseOrderReceivable, approvalThreshold } from "./approvals";
import { dec, roundMoney } from "./money";
import { command } from "./command";

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
  return command("purchasing.createPurchaseOrder", input, ctx, async () => {
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
  goodsReceiptId: string;
  receiptNumber: string;
  lotsCreated: number;
  priceVariance: string;
  /** What the supplier is now owed for this delivery. */
  payable: string;
}> {
  return command("purchasing.receiveGoods", input, ctx, async () => {
    const data = goodsReceiptSchema.parse(input);
    if (new Set(data.lines.map((line) => line.purchaseOrderLineId)).size !== data.lines.length) {
      throw new PurchasingError("Each purchase-order line may appear only once on a receipt.");
    }

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
    // What the receipt credits to payables, line by line, and which lot each
    // accepted line became.
    let payable = dec(0);
    const lotByOrderLine = new Map<string, string>();

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
        const lot = await receiveMaterial(
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
        payable = payable.plus(accepted.times(actualEffectiveCost));
        lotByOrderLine.set(l.purchaseOrderLineId, lot.lotId);
        lotsCreated += 1;
      }
    }

    const dueDate = new Date(data.receivedDate);
    dueDate.setUTCDate(dueDate.getUTCDate() + order.supplier.creditDays);

    return db.$transaction(async (tx) => {
      const receipt = await tx.goodsReceipt.create({
        data: {
          receiptNumber,
          purchaseOrderId: order.id,
          receivedDate: data.receivedDate,
          invoiceRef: data.invoiceRef ?? null,
          entityId: data.entityId,
          payableAmount: payable.toString(),
          dueDate,
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
        include: { lines: { select: { id: true, purchaseOrderLineId: true } } },
      });

      // Each lot names the receipt line it came in on, so a roll of fabric can
      // be traced back to the delivery, the order and the price it was bought
      // at. Unique per receipt, since an order line appears on it only once.
      for (const line of receipt.lines) {
        const lotId = lotByOrderLine.get(line.purchaseOrderLineId);
        if (lotId) {
          await tx.inventoryLot.update({ where: { id: lotId }, data: { goodsReceiptLineId: line.id } });
        }
      }

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
        goodsReceiptId: receipt.id,
        receiptNumber: receipt.receiptNumber,
        lotsCreated,
        priceVariance: totalVariance.toString(),
        payable: payable.toString(),
      };
    });
  });
}

const PAYABLES = "2110";
const CASH = "1110";
const BANK = "1120";

export const payGoodsReceiptSchema = z.object({
  goodsReceiptId: z.string().min(1),
  amount: z.coerce.number().positive("Payment must be greater than zero."),
  paidDate: z.coerce.date(),
  method: z.enum(["CASH", "BANK_TRANSFER", "INSTAPAY", "CARD"]).default("BANK_TRANSFER"),
  reference: z.string().nullable().optional(),
});

/**
 * Pays a supplier for a delivery.
 *
 * The debt was recognised when the goods came in; this settles it, and only
 * it. Paying a delivery used to mean raising an expense for it, which put the
 * same fabric on the books a second time — once as stock, once as a cost.
 *
 * Overpayment is refused for the same reason as on an expense: more than is
 * owed means the wrong delivery or the wrong amount, and a negative payable
 * is something no statement can explain.
 */
export async function payGoodsReceipt(
  input: z.input<typeof payGoodsReceiptSchema>,
  ctx: AuditContext,
): Promise<{ paymentId: string; journalEntryNumber: string; outstanding: string }> {
  return command("purchasing.payGoodsReceipt", input, ctx, async () => {
    const data = payGoodsReceiptSchema.parse(input);

    return db.$transaction(async (tx) => {
      const receipt = await tx.goodsReceipt.findUnique({
        where: { id: data.goodsReceiptId },
        include: { purchaseOrder: { select: { poNumber: true, supplierId: true } } },
      });
      if (!receipt) throw new PurchasingError("Delivery not found.");
      if (!receipt.entityId) {
        throw new PurchasingError(
          `${receipt.receiptNumber} does not say whose books it was received into, so its payment has nowhere to post.`,
        );
      }

      const outstanding = dec(receipt.payableAmount).minus(dec(receipt.paidAmount));
      const payment = roundMoney(dec(data.amount));
      if (outstanding.lessThanOrEqualTo(0)) {
        throw new PurchasingError(`${receipt.receiptNumber} is already paid in full.`);
      }
      if (payment.greaterThan(outstanding)) {
        throw new PurchasingError(
          `Payment ${payment.toFixed(2)} exceeds the ${outstanding.toFixed(2)} still owed on ${receipt.receiptNumber}.`,
        );
      }

      const row = await tx.goodsReceiptPayment.create({
        data: {
          goodsReceiptId: receipt.id,
          amount: payment.toString(),
          paidDate: data.paidDate,
          method: data.method,
          reference: data.reference ?? null,
        },
      });
      const paid = dec(receipt.paidAmount).plus(payment);
      await tx.goodsReceipt.update({
        where: { id: receipt.id },
        data: { paidAmount: paid.toString() },
      });

      const account = async (code: string) => {
        const a = await tx.account.findUnique({ where: { code }, select: { id: true } });
        if (!a) throw new PurchasingError(`Account ${code} is missing from the chart of accounts.`);
        return a.id;
      };
      const description = data.reference ?? `Payment for ${receipt.receiptNumber}`;
      const journal = await postEntry(tx, {
        entityId: receipt.entityId,
        postingDate: data.paidDate,
        sourceType: "PAYMENT",
        sourceId: row.id,
        memo: `Supplier payment — ${receipt.receiptNumber} (${receipt.purchaseOrder.poNumber})`,
        ctx,
        lines: [
          {
            accountId: await account(PAYABLES),
            debit: payment,
            entityId: receipt.entityId,
            supplierId: receipt.purchaseOrder.supplierId,
            description,
          },
          {
            // Cash leaves the box; anything else leaves the bank.
            accountId: await account(data.method === "CASH" ? CASH : BANK),
            credit: payment,
            entityId: receipt.entityId,
            supplierId: receipt.purchaseOrder.supplierId,
            description,
          },
        ],
      });

      await writeAudit(tx, {
        action: "GOODS_RECEIPT_PAID",
        entityName: "GoodsReceipt",
        entityId: receipt.id,
        before: { paidAmount: dec(receipt.paidAmount).toString() },
        after: {
          paidAmount: paid.toString(),
          payment: payment.toString(),
          method: data.method,
          journalEntry: journal.entryNumber,
        },
        ctx,
      });

      return {
        paymentId: row.id,
        journalEntryNumber: journal.entryNumber,
        outstanding: dec(receipt.payableAmount).minus(paid).toString(),
      };
    });
  });
}
