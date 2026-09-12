-- External manufacturing is billed and collected, not merely costed.
--
-- Completing a CMT order worked out its margin and stopped there: no invoice,
-- no receivable, nothing in the ledger. The client is billed per good garment
-- delivered, against a deposit taken when the order was placed.

CREATE TYPE "CMTPaymentKind" AS ENUM ('DEPOSIT', 'SETTLEMENT');

-- Invoicing an external run is its own kind of entry, not a sale of garments.
ALTER TYPE "JournalSourceType" ADD VALUE IF NOT EXISTS 'CMT_INVOICE';

ALTER TABLE "cmt_orders"
  ADD COLUMN "agreedUnitPrice" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN "deliveredQty"    INTEGER,
  ADD COLUMN "invoiceNumber"   TEXT,
  ADD COLUMN "invoicedAmount"  DECIMAL(18,4),
  ADD COLUMN "invoicedAt"      DATE,
  ADD COLUMN "paidAmount"      DECIMAL(18,4) NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "cmt_orders_invoiceNumber_key" ON "cmt_orders"("invoiceNumber");

-- Orders raised before this migration: the piece price is what the contract
-- worked out to per garment, which is what they were quoted at.
UPDATE "cmt_orders"
   SET "agreedUnitPrice" = ROUND("contractValue" / NULLIF("quantity", 0), 4)
 WHERE "quantity" > 0;

CREATE TABLE "cmt_payments" (
  "id"             TEXT NOT NULL,
  "cmtOrderId"     TEXT NOT NULL,
  "kind"           "CMTPaymentKind" NOT NULL,
  "method"         "PaymentMethod" NOT NULL,
  "amount"         DECIMAL(18,4) NOT NULL,
  "paidOn"         DATE NOT NULL,
  "reference"      TEXT,
  "journalEntryId" TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cmt_payments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cmt_payments_cmtOrderId_fkey" FOREIGN KEY ("cmtOrderId")
    REFERENCES "cmt_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "cmt_payments_amount_positive" CHECK ("amount" > 0)
);
CREATE INDEX "cmt_payments_cmtOrderId_idx" ON "cmt_payments"("cmtOrderId");

-- Where a deposit sits until the goods are handed over. Inserted rather than
-- left to the seed, because the seed does not run against a live database.
INSERT INTO "accounts" ("id", "code", "nameEn", "nameAr", "type", "normalBalance", "scope",
                        "parentId", "isPostable", "isActive", "reportingCategory",
                        "includeInMinuteRate", "includeInBrandFixedPool", "isIntercompany", "sortOrder",
                        "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, '2410', 'CMT client deposits', 'دفعات مقدمة من عملاء التصنيع',
       'LIABILITY', 'CREDIT', 'FACTORY', p."id", true, true, 'UNEARNED',
       false, false, false, p."sortOrder" + 1, NOW(), NOW()
  FROM "accounts" p
 WHERE p."code" = '2000'
   AND NOT EXISTS (SELECT 1 FROM "accounts" a WHERE a."code" = '2410');
