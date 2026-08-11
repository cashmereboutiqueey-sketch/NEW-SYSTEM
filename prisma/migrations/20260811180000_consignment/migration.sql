-- Selling somebody else's goods for a share of the price.
--
-- The whole point of these tables is what they are *not*. Consigned garments
-- are deliberately not inventory_lots: every stock valuation, GMROI figure
-- and dead-stock report reads that table without asking whose goods they are,
-- so putting somebody else's stock in it would mean every one of those
-- queries needed a filter — and the first one that forgot would overstate
-- what the business owns.
--
-- And a consignment sale is not a sales_order. Almost nothing about it is the
-- same: no stock is relieved, no cost of sales arises, and the revenue is the
-- commission rather than the price on the ticket. Selling a 2,000 coat on 20%
-- earns 400; booking 2,000 would inflate turnover with money that was never
-- the shop's and make every margin ratio meaningless.

CREATE TABLE "consignors" (
  "id"             TEXT NOT NULL,
  "code"           TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "contactPerson"  TEXT,
  "phone"          TEXT,
  "email"          TEXT,
  "commissionRate" DECIMAL(9,6) NOT NULL,
  "settlementDays" INTEGER NOT NULL DEFAULT 0,
  "isActive"       BOOLEAN NOT NULL DEFAULT true,
  "notes"          TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "consignors_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "consignors_code_key" ON "consignors"("code");

-- Percentages are stored as fractions everywhere in this system. A rate of 25
-- instead of 0.25 would pay the shop twenty-five times the sale price.
ALTER TABLE "consignors"
  ADD CONSTRAINT "consignors_commission_is_a_fraction"
  CHECK ("commissionRate" >= 0 AND "commissionRate" <= 1);

CREATE TABLE "consignment_items" (
  "id"               TEXT NOT NULL,
  "itemCode"         TEXT NOT NULL,
  "consignorId"      TEXT NOT NULL,
  "description"      TEXT NOT NULL,
  "size"             TEXT,
  "colour"           TEXT,
  "retailPrice"      DECIMAL(18,4) NOT NULL,
  "commissionRate"   DECIMAL(9,6),
  "quantityReceived" INTEGER NOT NULL,
  "quantitySold"     INTEGER NOT NULL DEFAULT 0,
  "quantityReturned" INTEGER NOT NULL DEFAULT 0,
  "locationId"       TEXT NOT NULL,
  "receivedDate"     DATE NOT NULL,
  "expiresAt"        DATE,
  "notes"            TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "consignment_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "consignment_items_itemCode_key" ON "consignment_items"("itemCode");
CREATE INDEX "consignment_items_consignorId_idx" ON "consignment_items"("consignorId");
CREATE INDEX "consignment_items_locationId_idx" ON "consignment_items"("locationId");

-- More garments cannot leave than arrived, however they leave.
ALTER TABLE "consignment_items"
  ADD CONSTRAINT "consignment_items_quantities_sane"
    CHECK ("quantityReceived" > 0
       AND "quantitySold" >= 0
       AND "quantityReturned" >= 0
       AND "quantitySold" + "quantityReturned" <= "quantityReceived"),
  ADD CONSTRAINT "consignment_items_rate_is_a_fraction"
    CHECK ("commissionRate" IS NULL OR ("commissionRate" >= 0 AND "commissionRate" <= 1));

CREATE TABLE "consignor_settlements" (
  "id"               TEXT NOT NULL,
  "settlementNumber" TEXT NOT NULL,
  "consignorId"      TEXT NOT NULL,
  "amount"           DECIMAL(18,4) NOT NULL,
  "method"           "PaymentMethod" NOT NULL,
  "paidOn"           DATE NOT NULL,
  "reference"        TEXT,
  "notes"            TEXT,
  "entityId"         TEXT NOT NULL,
  "paidByUserId"     TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "consignor_settlements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "consignor_settlements_settlementNumber_key" ON "consignor_settlements"("settlementNumber");
CREATE INDEX "consignor_settlements_consignorId_paidOn_idx" ON "consignor_settlements"("consignorId", "paidOn");

CREATE TABLE "consignment_sales" (
  "id"               TEXT NOT NULL,
  "saleNumber"       TEXT NOT NULL,
  "itemId"           TEXT NOT NULL,
  "quantity"         INTEGER NOT NULL,
  "soldPrice"        DECIMAL(18,4) NOT NULL,
  "commissionRate"   DECIMAL(9,6) NOT NULL,
  "commissionAmount" DECIMAL(18,4) NOT NULL,
  "ownerAmount"      DECIMAL(18,4) NOT NULL,
  "customerId"       TEXT,
  "entityId"         TEXT NOT NULL,
  "locationId"       TEXT NOT NULL,
  "posSessionId"     TEXT,
  "paymentMethod"    "PaymentMethod" NOT NULL,
  "saleDate"         DATE NOT NULL,
  "settlementId"     TEXT,
  "soldByUserId"     TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "consignment_sales_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "consignment_sales_saleNumber_key" ON "consignment_sales"("saleNumber");
CREATE INDEX "consignment_sales_itemId_idx"       ON "consignment_sales"("itemId");
CREATE INDEX "consignment_sales_saleDate_idx"     ON "consignment_sales"("saleDate");
CREATE INDEX "consignment_sales_settlementId_idx" ON "consignment_sales"("settlementId");

-- The split must add up, to the piastre. If it did not, the shop would be
-- keeping or owing money that no side of the sale accounts for.
ALTER TABLE "consignment_sales"
  ADD CONSTRAINT "consignment_sales_split_adds_up"
    CHECK (ROUND("commissionAmount" + "ownerAmount", 2) = ROUND("soldPrice" * "quantity", 2)),
  ADD CONSTRAINT "consignment_sales_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "consignment_sales_amounts_not_negative"
    CHECK ("soldPrice" >= 0 AND "commissionAmount" >= 0 AND "ownerAmount" >= 0);

ALTER TABLE "consignment_items"
  ADD CONSTRAINT "consignment_items_consignorId_fkey" FOREIGN KEY ("consignorId")
    REFERENCES "consignors"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "consignment_items_locationId_fkey" FOREIGN KEY ("locationId")
    REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "consignor_settlements"
  ADD CONSTRAINT "consignor_settlements_consignorId_fkey" FOREIGN KEY ("consignorId")
    REFERENCES "consignors"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "consignor_settlements_entityId_fkey" FOREIGN KEY ("entityId")
    REFERENCES "entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "consignor_settlements_paidByUserId_fkey" FOREIGN KEY ("paidByUserId")
    REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "consignment_sales"
  ADD CONSTRAINT "consignment_sales_itemId_fkey" FOREIGN KEY ("itemId")
    REFERENCES "consignment_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "consignment_sales_customerId_fkey" FOREIGN KEY ("customerId")
    REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "consignment_sales_entityId_fkey" FOREIGN KEY ("entityId")
    REFERENCES "entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "consignment_sales_locationId_fkey" FOREIGN KEY ("locationId")
    REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "consignment_sales_posSessionId_fkey" FOREIGN KEY ("posSessionId")
    REFERENCES "pos_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "consignment_sales_settlementId_fkey" FOREIGN KEY ("settlementId")
    REFERENCES "consignor_settlements"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "consignment_sales_soldByUserId_fkey" FOREIGN KEY ("soldByUserId")
    REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
