import { dec, roundMoney } from "./money";
import type { ShipmentStatus } from "@/generated/prisma/client";

/** The delivery-only subset of Flextock's External APIs, revision 1.5. */
export type FlextockOrderInput = {
  orderNumber: string;
  orderDate: Date;
  recipient: string;
  phone: string;
  secondPhone?: string | null;
  city: string;
  area: string;
  addressLine: string;
  notes?: string | null;
  shippingAmount: string;
  orderTotal: string;
  lines: {
    sku: string;
    name: string;
    quantity: number;
    retailPrice: string;
    netPrice: string;
  }[];
  payments: {
    id: string;
    method: string;
    status: string;
    amount: string;
    reference?: string | null;
    collectedAt?: Date | null;
  }[];
};

export class FlextockPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlextockPayloadError";
  }
}

const money = (value: string) => Number(roundMoney(dec(value)).toFixed(2));

export function flextockProducts(input: FlextockOrderInput) {
  const products = new Map<string, { sku_code: string; sku_name: string; price: number }>();
  for (const line of input.lines) {
    if (!line.sku.trim() || !line.name.trim()) throw new FlextockPayloadError("Every parcel item needs a SKU and name.");
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) throw new FlextockPayloadError(`Invalid quantity for ${line.sku}.`);
    const existing = products.get(line.sku);
    if (existing && existing.price !== money(line.retailPrice)) {
      throw new FlextockPayloadError(`SKU ${line.sku} has different prices in one order; review it before sending.`);
    }
    products.set(line.sku, { sku_code: line.sku, sku_name: line.name, price: money(line.retailPrice) });
  }
  if (!products.size) throw new FlextockPayloadError("Flextock needs at least one item per order.");
  return [...products.values()];
}

/** Only catalog identity is sent; Cashmere remains the stock authority. */
export function flextockCreateOrder(input: FlextockOrderInput) {
  flextockProducts(input);
  if (![input.recipient, input.phone, input.city, input.area, input.addressLine].every((v) => v.trim())) {
    throw new FlextockPayloadError(`${input.orderNumber} needs a complete Flextock destination.`);
  }
  const bySku = new Map<string, { sku_code: string; quantity: number; sku_price: number; sku_promotional_price: number | null }>();
  for (const line of input.lines) {
    const price = money(line.retailPrice);
    const net = money(line.netPrice);
    if (price < 0 || net < 0 || net > price) throw new FlextockPayloadError(`Invalid price for ${line.sku}.`);
    const previous = bySku.get(line.sku);
    if (previous && (previous.sku_price !== price || previous.sku_promotional_price !== (net === price ? null : net))) {
      throw new FlextockPayloadError(`SKU ${line.sku} has different discounts in one order; review it before sending.`);
    }
    bySku.set(line.sku, {
      sku_code: line.sku,
      quantity: (previous?.quantity ?? 0) + line.quantity,
      sku_price: price,
      sku_promotional_price: net === price ? null : net,
    });
  }

  const validPayments = input.payments.filter((p) =>
    (p.status === "PENDING" && p.method === "COD") || (p.status === "COLLECTED" && p.method !== "COD"),
  );
  const paymentTotal = validPayments.reduce((sum, p) => sum.plus(dec(p.amount)), dec(0));
  if (!roundMoney(paymentTotal).equals(roundMoney(dec(input.orderTotal)))) {
    throw new FlextockPayloadError(`${input.orderNumber} has a balance outside its COD or collected payments; review it before sending.`);
  }
  const payment_data = validPayments.map((payment) => {
    if (payment.method === "COD") return { value: money(payment.amount), payment_type: "cash_on_delivery" as const };
    return {
      value: money(payment.amount),
      payment_type: "prepaid" as const,
      payment_method: payment.method.toLowerCase().replaceAll("_", " "),
      payment_reference: payment.reference?.trim() || `${input.orderNumber}-${payment.id}`,
      ...(payment.collectedAt ? { payment_timestamp: payment.collectedAt.toISOString() } : {}),
    };
  });

  const [first_name, ...rest] = input.recipient.trim().split(/\s+/);
  return {
    order_code: input.orderNumber,
    order_date: input.orderDate.toISOString().slice(0, 10),
    shipping_fees: money(input.shippingAmount),
    is_free_shipping: money(input.shippingAmount) === 0,
    is_gift_order: false,
    order_currency: "EGP",
    integration_source: "Cashmere",
    vendor_name: "Cashmere",
    customer_address: {
      country: "Egypt",
      city: input.city.trim(),
      area: input.area.trim(),
      address_line1: input.addressLine.trim(),
      first_name,
      last_name: rest.join(" "),
      phone_number: input.phone.trim(),
      ...(input.secondPhone?.trim() ? { secondary_phone_number: input.secondPhone.trim() } : {}),
      ...(input.notes?.trim() ? { note: input.notes.trim() } : {}),
    },
    line_items: [...bySku.values()],
    payment_data,
    requires_self_delivery: false,
  };
}

/** A status label alone never proves cash receipt or a physical stock return. */
export function flextockShipmentStatus(status: string, subStatus?: string | null): ShipmentStatus {
  const main = status.trim().toLowerCase();
  const sub = subStatus?.trim().toLowerCase();
  if (main === "delivered") return "DELIVERED";
  if (["partially delivered", "returned to origin", "returning", "lost", "canceled"].includes(main)
    || ["lost", "damaged", "cancellation rejected"].includes(sub ?? "")) return "NEEDS_REVIEW";
  if (sub === "rescheduled" || sub === "failed attempt" || main === "on hold") return "POSTPONED";
  if (main === "in transit" || ["picked by driver", "received at fc", "pick up", "fulfilled"].includes(main)) return "IN_TRANSIT";
  if (["pending", "ready", "processing"].includes(main)) return "SENT";
  return "NEEDS_REVIEW";
}
