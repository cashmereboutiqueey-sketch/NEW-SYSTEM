-- CreateEnum
CREATE TYPE "GarmentUnitStatus" AS ENUM ('MADE', 'IN_TRANSIT', 'IN_STOCK', 'SOLD', 'LOST', 'RETURNED');

-- CreateTable
CREATE TABLE "garment_units" (
    "id" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productionOrderId" TEXT,
    "lotId" TEXT,
    "status" "GarmentUnitStatus" NOT NULL DEFAULT 'MADE',
    "entityId" TEXT,
    "locationId" TEXT,
    "salesOrderLineId" TEXT,
    "labelPrintedAt" TIMESTAMP(3),
    "soldAt" TIMESTAMP(3),
    "writeOffNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "garment_units_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "garment_units_serial_key" ON "garment_units"("serial");

-- CreateIndex
CREATE INDEX "garment_units_variantId_status_idx" ON "garment_units"("variantId", "status");

-- CreateIndex
CREATE INDEX "garment_units_status_locationId_idx" ON "garment_units"("status", "locationId");

-- CreateIndex
CREATE INDEX "garment_units_lotId_idx" ON "garment_units"("lotId");

-- CreateIndex
CREATE INDEX "garment_units_productionOrderId_idx" ON "garment_units"("productionOrderId");

-- AddForeignKey
ALTER TABLE "garment_units" ADD CONSTRAINT "garment_units_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "garment_units" ADD CONSTRAINT "garment_units_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "production_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "garment_units" ADD CONSTRAINT "garment_units_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "inventory_lots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "garment_units" ADD CONSTRAINT "garment_units_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "garment_units" ADD CONSTRAINT "garment_units_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "garment_units" ADD CONSTRAINT "garment_units_salesOrderLineId_fkey" FOREIGN KEY ("salesOrderLineId") REFERENCES "sales_order_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Serial ordinals come from a database sequence rather than a counted row.
-- A sequence hands out a block of numbers atomically, which is what closing a
-- run of 400 garments needs: one statement, not 400 round trips, and no way
-- for two people finishing runs at once to be given the same number.
CREATE SEQUENCE IF NOT EXISTS "garment_unit_serial_seq" AS bigint START WITH 1;
