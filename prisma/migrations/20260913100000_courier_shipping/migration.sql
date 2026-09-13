-- Handing parcels to the courier, and hearing back.
--
-- The courier (MG Express) has no API. It takes a daily Excel sheet in its own
-- template, one file per branch, and reports back through an orders report its
-- portal exports. A shipment is a row this system put on such a sheet.

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('SENT', 'IN_TRANSIT', 'DELIVERED', 'NEEDS_REVIEW', 'RETURNED', 'FAILED', 'POSTPONED');

-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "addressLine" TEXT,
ADD COLUMN     "courierZoneId" TEXT,
ADD COLUMN     "governorate" TEXT,
ADD COLUMN     "recipientName" TEXT,
ADD COLUMN     "secondPhone" TEXT,
ADD COLUMN     "shippingPhone" TEXT;

-- CreateTable
CREATE TABLE "courier_zones" (
    "id" TEXT NOT NULL,
    "courier" TEXT NOT NULL,
    "governorate" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "price" DECIMAL(18,4) NOT NULL,
    "branch" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "courier_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_batches" (
    "id" TEXT NOT NULL,
    "batchNumber" TEXT NOT NULL,
    "courier" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" TEXT NOT NULL,
    "salesOrderId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "courier" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "codAmount" DECIMAL(18,4) NOT NULL,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'SENT',
    "courierStatus" TEXT,
    "collectedAmount" DECIMAL(18,4),
    "courierFee" DECIMAL(18,4),
    "dueToUs" DECIMAL(18,4),
    "remittedToUs" DECIMAL(18,4),
    "attempts" INTEGER,
    "followUp" TEXT,
    "lastReportAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "courier_zones_courier_governorate_idx" ON "courier_zones"("courier", "governorate");

-- CreateIndex
CREATE UNIQUE INDEX "courier_zones_courier_governorate_region_key" ON "courier_zones"("courier", "governorate", "region");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_batches_batchNumber_key" ON "shipment_batches"("batchNumber");

-- CreateIndex
CREATE INDEX "shipment_batches_courier_createdAt_idx" ON "shipment_batches"("courier", "createdAt");

-- CreateIndex
CREATE INDEX "shipments_salesOrderId_idx" ON "shipments"("salesOrderId");

-- CreateIndex
CREATE INDEX "shipments_courier_reference_idx" ON "shipments"("courier", "reference");

-- CreateIndex
CREATE INDEX "shipments_status_idx" ON "shipments"("status");

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_courierZoneId_fkey" FOREIGN KEY ("courierZoneId") REFERENCES "courier_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_batches" ADD CONSTRAINT "shipment_batches_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "shipment_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A parcel is never on two open shipments at once: sending an order twice
-- means two drivers, two collections and one garment. A failed or returned
-- shipment is closed, so the order can go out again.
CREATE UNIQUE INDEX "shipments_one_open_per_order" ON "shipments"("salesOrderId")
  WHERE "status" NOT IN ('RETURNED', 'FAILED');

ALTER TABLE "shipments" ADD CONSTRAINT "shipments_cod_not_negative" CHECK ("codAmount" >= 0);
ALTER TABLE "courier_zones" ADD CONSTRAINT "courier_zones_price_not_negative" CHECK ("price" >= 0);
