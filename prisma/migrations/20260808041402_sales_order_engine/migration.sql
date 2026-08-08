-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('SHOPIFY', 'MODERATOR', 'POS', 'EXHIBITION', 'WHOLESALE', 'MANUAL');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD', 'COD', 'BANK_TRANSFER', 'WALLET', 'STORE_CREDIT');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'COLLECTED', 'FAILED', 'REFUNDED');

-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "cogsAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "createdByUserId" TEXT,
ADD COLUMN     "entityId" TEXT,
ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "locationId" TEXT,
ADD COLUMN     "posSessionId" TEXT,
ADD COLUMN     "source" "OrderSource" NOT NULL DEFAULT 'MANUAL';

-- CreateTable
CREATE TABLE "pos_sessions" (
    "id" TEXT NOT NULL,
    "sessionNumber" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "cashierUserId" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "openingFloat" DECIMAL(18,4) NOT NULL,
    "countedCash" DECIMAL(18,4),
    "expectedCash" DECIMAL(18,4),
    "cashVariance" DECIMAL(18,4),
    "varianceNote" TEXT,

    CONSTRAINT "pos_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_payments" (
    "id" TEXT NOT NULL,
    "salesOrderId" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "amount" DECIMAL(18,4) NOT NULL,
    "fee" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "reference" TEXT,
    "collectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pos_sessions_sessionNumber_key" ON "pos_sessions"("sessionNumber");

-- CreateIndex
CREATE INDEX "pos_sessions_locationId_openedAt_idx" ON "pos_sessions"("locationId", "openedAt");

-- CreateIndex
CREATE INDEX "sales_payments_salesOrderId_idx" ON "sales_payments"("salesOrderId");

-- CreateIndex
CREATE INDEX "sales_payments_status_method_idx" ON "sales_payments"("status", "method");

-- CreateIndex
CREATE INDEX "sales_orders_source_orderDate_idx" ON "sales_orders"("source", "orderDate");

-- CreateIndex
CREATE INDEX "sales_orders_createdByUserId_idx" ON "sales_orders"("createdByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_source_externalId_key" ON "sales_orders"("source", "externalId");

-- AddForeignKey
ALTER TABLE "pos_sessions" ADD CONSTRAINT "pos_sessions_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_sessions" ADD CONSTRAINT "pos_sessions_cashierUserId_fkey" FOREIGN KEY ("cashierUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_posSessionId_fkey" FOREIGN KEY ("posSessionId") REFERENCES "pos_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_payments" ADD CONSTRAINT "sales_payments_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

