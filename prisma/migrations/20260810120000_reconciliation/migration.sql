-- CreateEnum
CREATE TYPE "SettlementProvider" AS ENUM ('COURIER', 'PAYMENT_GATEWAY');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('DRAFT', 'POSTED');

-- CreateEnum
CREATE TYPE "BankLineStatus" AS ENUM ('UNMATCHED', 'MATCHED', 'EXPLAINED');

-- CreateTable
CREATE TABLE "settlements" (
    "id" TEXT NOT NULL,
    "settlementNumber" TEXT NOT NULL,
    "provider" "SettlementProvider" NOT NULL,
    "channelId" TEXT,
    "entityId" TEXT NOT NULL,
    "reference" TEXT,
    "settlementDate" DATE NOT NULL,
    "expectedAmount" DECIMAL(18,4) NOT NULL,
    "netReceived" DECIMAL(18,4) NOT NULL,
    "variance" DECIMAL(18,4) NOT NULL,
    "varianceNote" TEXT,
    "status" "SettlementStatus" NOT NULL DEFAULT 'DRAFT',
    "journalEntryId" TEXT,
    "postedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_lines" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "salesPaymentId" TEXT NOT NULL,
    "expectedAmount" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "settlement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statements" (
    "id" TEXT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "statementDate" DATE NOT NULL,
    "openingBalance" DECIMAL(18,4) NOT NULL,
    "closingBalance" DECIMAL(18,4) NOT NULL,
    "reference" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statement_lines" (
    "id" TEXT NOT NULL,
    "bankStatementId" TEXT NOT NULL,
    "valueDate" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "amount" DECIMAL(18,4) NOT NULL,
    "status" "BankLineStatus" NOT NULL DEFAULT 'UNMATCHED',
    "matchedJournalLineId" TEXT,
    "note" TEXT,

    CONSTRAINT "bank_statement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "settlements_settlementNumber_key" ON "settlements"("settlementNumber");

-- CreateIndex
CREATE INDEX "settlements_provider_settlementDate_idx" ON "settlements"("provider", "settlementDate");

-- CreateIndex
CREATE INDEX "settlements_status_idx" ON "settlements"("status");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_lines_salesPaymentId_key" ON "settlement_lines"("salesPaymentId");

-- CreateIndex
CREATE INDEX "settlement_lines_settlementId_idx" ON "settlement_lines"("settlementId");

-- CreateIndex
CREATE INDEX "bank_statements_accountCode_statementDate_idx" ON "bank_statements"("accountCode", "statementDate");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_lines_matchedJournalLineId_key" ON "bank_statement_lines"("matchedJournalLineId");

-- CreateIndex
CREATE INDEX "bank_statement_lines_bankStatementId_status_idx" ON "bank_statement_lines"("bankStatementId", "status");

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "sales_channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "settlements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_salesPaymentId_fkey" FOREIGN KEY ("salesPaymentId") REFERENCES "sales_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_bankStatementId_fkey" FOREIGN KEY ("bankStatementId") REFERENCES "bank_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_matchedJournalLineId_fkey" FOREIGN KEY ("matchedJournalLineId") REFERENCES "journal_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

