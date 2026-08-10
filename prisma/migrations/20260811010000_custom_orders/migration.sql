-- Made to order: somebody wants a garment the shop does not have, and the
-- factory can make it from cloth already on the shelf.
--
-- Kept apart from sales_orders on purpose. There is nothing to sell yet: no
-- stock exists, so nothing can be relieved and no revenue can be recognised.
-- A deposit taken today is money held against a promise, and only becomes
-- revenue on the day the customer walks out with the garment.

CREATE TYPE "CustomOrderStatus" AS ENUM (
  'PENDING', 'IN_PRODUCTION', 'READY', 'DELIVERED', 'CANCELLED'
);

-- Settling a sale with a deposit clears a liability rather than bringing in
-- cash, which arrived weeks earlier.
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'DEPOSIT';

CREATE TABLE "custom_orders" (
  "id"                TEXT NOT NULL,
  "orderNumber"       TEXT NOT NULL,
  "status"            "CustomOrderStatus" NOT NULL DEFAULT 'PENDING',
  "customerId"        TEXT NOT NULL,
  "variantId"         TEXT NOT NULL,
  "quantity"          INTEGER NOT NULL,
  "agreedUnitPrice"   DECIMAL(18,4) NOT NULL,
  "agreedTotal"       DECIMAL(18,4) NOT NULL,
  "depositAmount"     DECIMAL(18,4) NOT NULL DEFAULT 0,
  "entityId"          TEXT NOT NULL,
  "locationId"        TEXT NOT NULL,
  "productionOrderId" TEXT,
  "salesOrderId"      TEXT,
  "promisedDate"      DATE,
  "deliveredAt"       DATE,
  "cancelledAt"       DATE,
  "cancelReason"      TEXT,
  "notes"             TEXT,
  "createdByUserId"   TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "custom_orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "custom_orders_orderNumber_key" ON "custom_orders"("orderNumber");
-- One custom order, one run: a bespoke piece is not batched with the season.
CREATE UNIQUE INDEX "custom_orders_productionOrderId_key" ON "custom_orders"("productionOrderId");
CREATE UNIQUE INDEX "custom_orders_salesOrderId_key" ON "custom_orders"("salesOrderId");
CREATE INDEX "custom_orders_customerId_status_idx" ON "custom_orders"("customerId", "status");
CREATE INDEX "custom_orders_status_promisedDate_idx" ON "custom_orders"("status", "promisedDate");

-- A promise for no garments is not a promise, and the deposit cannot exceed
-- what was agreed or the shop owes the customer money on delivery.
ALTER TABLE "custom_orders"
  ADD CONSTRAINT "custom_orders_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "custom_orders_total_not_negative" CHECK ("agreedTotal" >= 0),
  ADD CONSTRAINT "custom_orders_deposit_within_total"
    CHECK ("depositAmount" >= 0 AND "depositAmount" <= "agreedTotal");

ALTER TABLE "custom_orders"
  ADD CONSTRAINT "custom_orders_customerId_fkey" FOREIGN KEY ("customerId")
    REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "custom_orders_variantId_fkey" FOREIGN KEY ("variantId")
    REFERENCES "variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "custom_orders_entityId_fkey" FOREIGN KEY ("entityId")
    REFERENCES "entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "custom_orders_locationId_fkey" FOREIGN KEY ("locationId")
    REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "custom_orders_productionOrderId_fkey" FOREIGN KEY ("productionOrderId")
    REFERENCES "production_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "custom_orders_salesOrderId_fkey" FOREIGN KEY ("salesOrderId")
    REFERENCES "sales_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "custom_orders_createdByUserId_fkey" FOREIGN KEY ("createdByUserId")
    REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
