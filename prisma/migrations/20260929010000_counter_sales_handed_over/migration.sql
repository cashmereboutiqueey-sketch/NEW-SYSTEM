-- Counter sales leave with the customer at checkout. Correct historical
-- POS and exhibition sales that were left in the courier-facing state.
-- Only untouched sales without shipments or returns are eligible.
UPDATE "sales_orders" AS sale
SET "status" = 'DELIVERED',
    "deliveredDate" = sale."orderDate",
    "updatedAt" = CURRENT_TIMESTAMP
WHERE sale."source" IN ('POS', 'EXHIBITION')
  AND sale."status" = 'CONFIRMED'
  AND sale."deliveredDate" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "shipments" AS shipment WHERE shipment."salesOrderId" = sale."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "returns" AS returned WHERE returned."salesOrderId" = sale."id"
  );
