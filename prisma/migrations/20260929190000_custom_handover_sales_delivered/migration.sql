-- Older custom-order handovers closed the promise but left their sales order
-- CONFIRMED. Those sales then appeared as parcels awaiting a courier. A
-- handed-over promise with no shipment or return is an in-person delivery.
UPDATE "sales_orders" AS sale
SET "status" = 'DELIVERED',
    "deliveredDate" = COALESCE(sale."deliveredDate", custom_order."deliveredAt", sale."orderDate"),
    "updatedAt" = CURRENT_TIMESTAMP
FROM "custom_orders" AS custom_order
WHERE custom_order."salesOrderId" = sale."id"
  AND custom_order."status" = 'DELIVERED'
  AND sale."status" = 'CONFIRMED'
  AND sale."source" = 'MANUAL'
  AND NOT EXISTS (
    SELECT 1 FROM "shipments" AS shipment WHERE shipment."salesOrderId" = sale."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "returns" AS returned WHERE returned."salesOrderId" = sale."id"
  );
