import "server-only";
import { db } from "./db";
import { dec } from "./money";
import { createShipmentBatches, recordFlextockStatus, ShippingError } from "./shipping";
import { flextockClient, FlextockApiError } from "./flextock-api";
import { flextockCreateOrder, flextockProducts, flextockShipmentStatus, type FlextockOrderInput } from "./flextock-payload";
import type { AuditContext } from "./audit";

/** Read the current order right before submission; no user-supplied prices or COD. */
export async function prepareFlextockOrder(salesOrderId: string) {
  const order = await db.salesOrder.findUnique({
    where: { id: salesOrderId },
    include: {
      customer: { select: { name: true, phone: true } },
      customOrder: { select: { status: true } },
      courierZone: true,
      shipments: { where: { status: { notIn: ["RETURNED", "FAILED"] } }, select: { id: true } },
      payments: { select: { id: true, method: true, status: true, amount: true, reference: true, collectedAt: true } },
      lines: {
        include: { variant: { include: { style: { select: { nameEn: true } }, colorCode: { select: { nameEn: true } }, sizeCode: { select: { code: true } } } } },
      },
    },
  });
  if (!order) throw new ShippingError("Order not found.");
  if (order.source === "WHOLESALE") {
    throw new ShippingError(`${order.orderNumber} is wholesale; Flextock's agreed parcel service covers retail orders only.`);
  }
  if (order.status !== "CONFIRMED" || order.customOrder?.status === "DELIVERED" || order.shipments.length) {
    throw new ShippingError(`${order.orderNumber} is not waiting for Flextock shipping.`);
  }
  if (!order.courierZone?.isActive || order.courierZone.courier !== "FLEXTOCK") {
    throw new ShippingError(`${order.orderNumber} needs an active Flextock delivery area.`);
  }
  const input: FlextockOrderInput = {
    orderNumber: order.orderNumber,
    orderDate: order.orderDate,
    recipient: order.recipientName || order.customer?.name || "",
    phone: order.shippingPhone || order.customer?.phone || "",
    secondPhone: order.secondPhone,
    city: order.courierZone.governorate,
    area: order.courierZone.region,
    addressLine: order.addressLine || "",
    notes: order.notes,
    shippingAmount: dec(order.shippingAmount).toString(),
    orderTotal: dec(order.netAmount).plus(dec(order.shippingAmount)).toString(),
    lines: order.lines.map((line) => ({
      sku: line.variant.sku,
      name: `${line.variant.style.nameEn} / ${line.variant.colorCode.nameEn} / ${line.variant.sizeCode.code}`,
      quantity: line.quantity,
      retailPrice: dec(line.retailPrice).toString(),
      netPrice: dec(line.netPrice).toString(),
    })),
    payments: order.payments.map((payment) => ({
      id: payment.id,
      method: payment.method,
      status: payment.status,
      amount: dec(payment.amount).toString(),
      reference: payment.reference,
      collectedAt: payment.collectedAt,
    })),
  };
  return { orderNumber: order.orderNumber, products: flextockProducts(input), payload: flextockCreateOrder(input) };
}

/** Flextock accepts an order before Cashmere records its courier handoff. */
export async function submitFlextockOrder(salesOrderId: string, ctx: AuditContext, client = flextockClient()) {
  const prepared = await prepareFlextockOrder(salesOrderId);
  await client.createProducts(prepared.products);
  try {
    await client.createOrder(prepared.payload);
  } catch (error) {
    // The merchant order code is unique at Flextock. If its create response was
    // lost, look that same code up; never make a new code for a blind retry.
    if (!(error instanceof FlextockApiError) || error.status !== 400 && error.status !== undefined) throw error;
    try {
      const remote = await client.orderStatus(prepared.orderNumber);
      if (["canceled", "lost", "returned to origin"].includes(remote.order_status.toLowerCase())) throw error;
    } catch (lookupError) {
      if (lookupError === error) throw error;
      throw new FlextockApiError(`Flextock did not confirm ${prepared.orderNumber}. Check it there before retrying.`);
    }
  }
  const recorded = await createShipmentBatches({ salesOrderIds: [salesOrderId], acceptedByFlextock: true, submittedByApi: true }, ctx);
  return { orderNumber: prepared.orderNumber, batches: recorded.batches };
}

/** Poll only known handoffs. Financial figures remain for human reconciliation. */
export async function refreshFlextockShipment(reference: string, ctx: AuditContext, client = flextockClient()) {
  const shipment = await db.shipment.findFirst({ where: { courier: "FLEXTOCK", reference }, orderBy: { createdAt: "desc" } });
  if (!shipment?.apiSubmittedAt) throw new ShippingError("API-submitted Flextock shipment was not found.");
  const remote = await client.orderStatus(reference);
  const providerStatus = flextockShipmentStatus(remote.order_status, remote.order_sub_status);
  const codNeedsConfirmation = providerStatus === "DELIVERED" && dec(shipment.codAmount).greaterThan(0);
  const status = codNeedsConfirmation ? "NEEDS_REVIEW" : providerStatus;
  return recordFlextockStatus({
    reference,
    status,
    providerStatus: [remote.order_status, remote.order_sub_status].filter(Boolean).join(" / "),
    trackingNumber: remote.tracking_number,
    trackingUrl: remote.tracking_url,
    ...(status === "NEEDS_REVIEW" ? { followUp: codNeedsConfirmation
      ? "Flextock reports delivery. Confirm COD collection and remittance before closing this shipment."
      : "Review Flextock's delivery result; confirm cash and any returned goods separately." } : {}),
  }, ctx);
}
