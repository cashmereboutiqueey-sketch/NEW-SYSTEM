-- CreateEnum
CREATE TYPE "OpeningBalanceStatus" AS ENUM ('PREVIEWED', 'COMMITTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CostBasis" AS ENUM ('STATED', 'ESTIMATED_FROM_RETAIL', 'DERIVED_FROM_BOM');

-- AlterTable
ALTER TABLE "inventory_lots" ADD COLUMN     "openingBatchId" TEXT,
ADD COLUMN     "costEstimated" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "opening_balance_batches" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "OpeningBalanceStatus" NOT NULL DEFAULT 'PREVIEWED',
    "asOfDate" DATE NOT NULL,
    "entityId" TEXT NOT NULL,
    "retailCostRatio" DECIMAL(9,6),
    "filename" TEXT,
    "notes" TEXT,
    "totalLines" INTEGER NOT NULL DEFAULT 0,
    "totalValue" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "estimatedValue" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "journalEntryId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMP(3),

    CONSTRAINT "opening_balance_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opening_balance_lines" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "materialId" TEXT,
    "variantId" TEXT,
    "locationId" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unitCost" DECIMAL(18,4) NOT NULL,
    "costBasis" "CostBasis" NOT NULL DEFAULT 'STATED',
    "raw" JSONB,
    "reason" TEXT,

    CONSTRAINT "opening_balance_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "opening_balance_batches_number_key" ON "opening_balance_batches"("number");

-- CreateIndex
CREATE INDEX "opening_balance_batches_status_asOfDate_idx" ON "opening_balance_batches"("status", "asOfDate");

-- CreateIndex
CREATE INDEX "opening_balance_lines_batchId_idx" ON "opening_balance_lines"("batchId");

-- AddForeignKey
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_openingBatchId_fkey" FOREIGN KEY ("openingBatchId") REFERENCES "opening_balance_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_balance_batches" ADD CONSTRAINT "opening_balance_batches_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_balance_batches" ADD CONSTRAINT "opening_balance_batches_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_balance_batches" ADD CONSTRAINT "opening_balance_batches_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_balance_lines" ADD CONSTRAINT "opening_balance_lines_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "opening_balance_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_balance_lines" ADD CONSTRAINT "opening_balance_lines_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_balance_lines" ADD CONSTRAINT "opening_balance_lines_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opening_balance_lines" ADD CONSTRAINT "opening_balance_lines_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The equity account everything opening is posted against.
--
-- Inserted here rather than left to the seed, which does not run on a deploy:
-- without it the first opening balance would fail looking for an account that
-- exists only in the chart file. Idempotent on the code.
INSERT INTO "accounts" ("id", "code", "nameEn", "nameAr", "type", "normalBalance", "scope", "parentId", "isPostable", "isActive", "reportingCategory", "includeInMinuteRate", "includeInBrandFixedPool", "createdAt", "updatedAt")
SELECT
  'acc_opening_balances', '3400', 'Opening balances', 'أرصدة افتتاحية',
  'EQUITY', 'CREDIT', 'BOTH', p."id", true, true, 'EQUITY', false, false,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "accounts" p
WHERE p."code" = '3000'
ON CONFLICT ("code") DO NOTHING;
