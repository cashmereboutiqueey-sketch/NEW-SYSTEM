import { describe, expect, it } from "vitest";
import { flextockCreateOrder, flextockProducts, flextockShipmentStatus, FlextockPayloadError, type FlextockOrderInput } from "./flextock-payload";

const input = (): FlextockOrderInput => ({
  orderNumber: "SO-2026-101",
  orderDate: new Date("2026-10-07T00:00:00.000Z"),
  recipient: "Mona Ahmed",
  phone: "01001234567",
  city: "Alexandria",
  area: "Smouha",
  addressLine: "12 Test Street",
  shippingAmount: "45",
  orderTotal: "1805",
  lines: [{ sku: "STYLE-BLACK-M", name: "Style / Black / M", quantity: 2, retailPrice: "880", netPrice: "880" }],
  payments: [
    { id: "advance-1", method: "INSTAPAY", status: "COLLECTED", amount: "500", reference: "IP-1" },
    { id: "cod-1", method: "COD", status: "PENDING", amount: "1305" },
  ],
});

describe("Flextock delivery-only payload", () => {
  it("preserves prepaid deposit and sends only the remaining COD", () => {
    const order = flextockCreateOrder(input());
    expect(order).toMatchObject({
      order_code: "SO-2026-101", order_currency: "EGP", shipping_fees: 45,
      requires_self_delivery: false,
      payment_data: [
        { value: 500, payment_type: "prepaid", payment_reference: "IP-1" },
        { value: 1305, payment_type: "cash_on_delivery" },
      ],
      line_items: [{ sku_code: "STYLE-BLACK-M", quantity: 2, sku_price: 880, sku_promotional_price: null }],
    });
    expect(order).not.toHaveProperty("inventory_levels");
    expect(order).not.toHaveProperty("shipment_data");
    expect(flextockProducts(input())).toEqual([{ sku_code: "STYLE-BLACK-M", sku_name: "Style / Black / M", price: 880 }]);
  });

  it("blocks a customer balance that Flextock would not collect", () => {
    const sale = input();
    sale.payments[1].amount = "1000";
    expect(() => flextockCreateOrder(sale)).toThrow(FlextockPayloadError);
  });

  it("keeps partial deliveries and returns for manual review", () => {
    expect(flextockShipmentStatus("delivered")).toBe("DELIVERED");
    expect(flextockShipmentStatus("partially delivered")).toBe("NEEDS_REVIEW");
    expect(flextockShipmentStatus("returned to origin", "handed to merchant")).toBe("NEEDS_REVIEW");
    expect(flextockShipmentStatus("in transit", "failed attempt")).toBe("POSTPONED");
    expect(flextockShipmentStatus("new unexpected status")).toBe("NEEDS_REVIEW");
  });
});
