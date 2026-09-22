-- CreateEnum
CREATE TYPE "ModeratorCommissionKind" AS ENUM ('EARNED', 'REVERSED');

-- CreateTable
CREATE TABLE "moderator_rates" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "perPieceAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "percentOfNet" DECIMAL(9,6) NOT NULL DEFAULT 0,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "notes" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderator_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderator_commissions" (
    "id" TEXT NOT NULL,
    "kind" "ModeratorCommissionKind" NOT NULL DEFAULT 'EARNED',
    "sourceKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "salesOrderId" TEXT NOT NULL,
    "rateId" TEXT,
    "perPieceAmount" DECIMAL(18,4) NOT NULL,
    "percentOfNet" DECIMAL(9,6) NOT NULL,
    "pieces" INTEGER NOT NULL,
    "netAmount" DECIMAL(18,4) NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "earnedOn" DATE NOT NULL,
    "entityId" TEXT NOT NULL,
    "journalEntryId" TEXT,
    "settlementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderator_commissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderator_settlements" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "paidOn" DATE NOT NULL,
    "notes" TEXT,
    "entityId" TEXT NOT NULL,
    "journalEntryId" TEXT,
    "paidByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderator_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "moderator_rates_userId_effectiveFrom_idx" ON "moderator_rates"("userId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "moderator_commissions_sourceKey_key" ON "moderator_commissions"("sourceKey");

-- CreateIndex
CREATE INDEX "moderator_commissions_userId_settlementId_idx" ON "moderator_commissions"("userId", "settlementId");

-- CreateIndex
CREATE INDEX "moderator_commissions_salesOrderId_idx" ON "moderator_commissions"("salesOrderId");

-- CreateIndex
CREATE INDEX "moderator_commissions_earnedOn_idx" ON "moderator_commissions"("earnedOn");

-- CreateIndex
CREATE UNIQUE INDEX "moderator_settlements_number_key" ON "moderator_settlements"("number");

-- CreateIndex
CREATE INDEX "moderator_settlements_userId_paidOn_idx" ON "moderator_settlements"("userId", "paidOn");

-- AddForeignKey
ALTER TABLE "moderator_rates" ADD CONSTRAINT "moderator_rates_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderator_commissions" ADD CONSTRAINT "moderator_commissions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderator_commissions" ADD CONSTRAINT "moderator_commissions_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderator_commissions" ADD CONSTRAINT "moderator_commissions_rateId_fkey" FOREIGN KEY ("rateId") REFERENCES "moderator_rates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderator_commissions" ADD CONSTRAINT "moderator_commissions_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderator_commissions" ADD CONSTRAINT "moderator_commissions_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderator_commissions" ADD CONSTRAINT "moderator_commissions_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "moderator_settlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderator_settlements" ADD CONSTRAINT "moderator_settlements_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderator_settlements" ADD CONSTRAINT "moderator_settlements_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderator_settlements" ADD CONSTRAINT "moderator_settlements_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderator_settlements" ADD CONSTRAINT "moderator_settlements_paidByUserId_fkey" FOREIGN KEY ("paidByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The two accounts the commission posts to.
--
-- Inserted here rather than left to the seed, because the seed does not run on
-- a deploy and the first commission would then fail looking for an account
-- that exists only in the chart file. Idempotent on the code, so a database
-- that already has them from a seed is untouched.
INSERT INTO "accounts" ("id", "code", "nameEn", "nameAr", "type", "normalBalance", "scope", "parentId", "isPostable", "isActive", "reportingCategory", "includeInMinuteRate", "includeInBrandFixedPool", "createdAt", "updatedAt")
SELECT
  'acc_moderator_payable', '2510', 'Payable to moderators', 'مستحق للمودريتورز',
  'LIABILITY', 'CREDIT', 'BRAND', p."id", true, true, 'PAYABLE', false, false,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "accounts" p
WHERE p."code" = '2000'
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "accounts" ("id", "code", "nameEn", "nameAr", "type", "normalBalance", "scope", "parentId", "isPostable", "isActive", "reportingCategory", "includeInMinuteRate", "includeInBrandFixedPool", "createdAt", "updatedAt")
SELECT
  'acc_moderator_commission', '6250', 'Moderator commission', 'عمولة المودريتور',
  'EXPENSE', 'DEBIT', 'BRAND', p."id", true, true, 'BRAND_VARIABLE', false, false,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "accounts" p
WHERE p."code" = '6200'
ON CONFLICT ("code") DO NOTHING;
