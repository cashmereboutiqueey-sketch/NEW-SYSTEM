-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COGS', 'EXPENSE', 'OTHER_INCOME', 'OTHER_EXPENSE');

-- CreateEnum
CREATE TYPE "NormalBalance" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "AccountScope" AS ENUM ('FACTORY', 'BRAND', 'BOTH');

-- CreateEnum
CREATE TYPE "JournalStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'POSTED');

-- CreateEnum
CREATE TYPE "JournalSourceType" AS ENUM ('MANUAL', 'EXPENSE', 'EXPENSE_PAYMENT', 'SUPPLIER_INVOICE', 'GOODS_RECEIPT', 'MATERIAL_ISSUE', 'PRODUCTION_OUTPUT', 'TRANSFER_INVOICE', 'SALES_ORDER', 'SALES_RETURN', 'PAYMENT', 'PAYROLL', 'DEPRECIATION', 'ACCRUAL', 'OPENING_BALANCE', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,
    "normalBalance" "NormalBalance" NOT NULL,
    "scope" "AccountScope" NOT NULL DEFAULT 'BOTH',
    "parentId" TEXT,
    "isPostable" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "reportingCategory" TEXT,
    "includeInMinuteRate" BOOLEAN NOT NULL DEFAULT false,
    "includeInBrandFixedPool" BOOLEAN NOT NULL DEFAULT false,
    "isIntercompany" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_centers" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "entityId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "cost_centers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rates" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "rate" DECIMAL(9,6) NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" TEXT NOT NULL,
    "entryNumber" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fiscalPeriodId" TEXT NOT NULL,
    "status" "JournalStatus" NOT NULL DEFAULT 'DRAFT',
    "postingDate" DATE NOT NULL,
    "memo" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "sourceType" "JournalSourceType" NOT NULL DEFAULT 'MANUAL',
    "sourceId" TEXT,
    "reversesEntryId" TEXT,
    "reversalReason" TEXT,
    "createdByUserId" TEXT,
    "postedByUserId" TEXT,
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_lines" (
    "id" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "accountId" TEXT NOT NULL,
    "debit" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "entityId" TEXT NOT NULL,
    "costCenterId" TEXT,
    "supplierId" TEXT,
    "customerId" TEXT,
    "styleId" TEXT,
    "variantId" TEXT,
    "appliedTaxRate" DECIMAL(9,6),
    "description" TEXT,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_code_key" ON "accounts"("code");

-- CreateIndex
CREATE INDEX "accounts_type_isActive_idx" ON "accounts"("type", "isActive");

-- CreateIndex
CREATE INDEX "accounts_parentId_idx" ON "accounts"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "cost_centers_code_key" ON "cost_centers"("code");

-- CreateIndex
CREATE INDEX "tax_rates_code_effectiveFrom_effectiveTo_idx" ON "tax_rates"("code", "effectiveFrom", "effectiveTo");

-- CreateIndex
CREATE UNIQUE INDEX "tax_rates_code_effectiveFrom_key" ON "tax_rates"("code", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_entryNumber_key" ON "journal_entries"("entryNumber");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_reversesEntryId_key" ON "journal_entries"("reversesEntryId");

-- CreateIndex
CREATE INDEX "journal_entries_entityId_postingDate_idx" ON "journal_entries"("entityId", "postingDate");

-- CreateIndex
CREATE INDEX "journal_entries_fiscalPeriodId_status_idx" ON "journal_entries"("fiscalPeriodId", "status");

-- CreateIndex
CREATE INDEX "journal_entries_sourceType_sourceId_idx" ON "journal_entries"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "journal_lines_accountId_idx" ON "journal_lines"("accountId");

-- CreateIndex
CREATE INDEX "journal_lines_entityId_idx" ON "journal_lines"("entityId");

-- CreateIndex
CREATE INDEX "journal_lines_supplierId_idx" ON "journal_lines"("supplierId");

-- CreateIndex
CREATE INDEX "journal_lines_customerId_idx" ON "journal_lines"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "journal_lines_journalEntryId_lineNumber_key" ON "journal_lines"("journalEntryId", "lineNumber");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_centers" ADD CONSTRAINT "cost_centers_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_fiscalPeriodId_fkey" FOREIGN KEY ("fiscalPeriodId") REFERENCES "fiscal_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversesEntryId_fkey" FOREIGN KEY ("reversesEntryId") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_postedByUserId_fkey" FOREIGN KEY ("postedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "journal_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_costCenterId_fkey" FOREIGN KEY ("costCenterId") REFERENCES "cost_centers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_styleId_fkey" FOREIGN KEY ("styleId") REFERENCES "styles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Accounting invariants, enforced in the database.
--
-- Application code is expected to uphold these too, but the ledger must stay
-- correct even if a future server action, a migration script or a manual psql
-- session gets it wrong. These are the rules the accounting specs describe as
-- non-negotiable: journals balance, posted history is immutable, and a closed
-- period cannot be written to.
-- ---------------------------------------------------------------------------

-- 1. A line carries exactly one of debit or credit, and neither is negative.
--    A signed single column could not express this.
ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_debit_xor_credit"
  CHECK (
    "debit" >= 0 AND "credit" >= 0
    AND (("debit" > 0 AND "credit" = 0) OR ("credit" > 0 AND "debit" = 0))
  );

-- 2. Σ debits = Σ credits for any POSTED entry.
--    Deferred to commit time so an entry and its lines can be written in one
--    transaction without tripping the check mid-insert.
CREATE OR REPLACE FUNCTION assert_journal_entry_balanced()
RETURNS TRIGGER AS $$
DECLARE
  target_id TEXT;
  entry_status TEXT;
  total_debit NUMERIC(18,4);
  total_credit NUMERIC(18,4);
  line_count INT;
BEGIN
  -- The same function guards both tables, whose NEW/OLD records have
  -- different shapes, so the entry id must be read per table.
  IF TG_TABLE_NAME = 'journal_lines' THEN
    target_id := COALESCE(NEW."journalEntryId", OLD."journalEntryId");
  ELSE
    target_id := COALESCE(NEW."id", OLD."id");
  END IF;

  SELECT "status" INTO entry_status FROM "journal_entries" WHERE "id" = target_id;

  -- Entry deleted in this transaction, or still a draft: nothing to enforce.
  IF entry_status IS NULL OR entry_status <> 'POSTED' THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM("debit"), 0), COALESCE(SUM("credit"), 0), COUNT(*)
    INTO total_debit, total_credit, line_count
    FROM "journal_lines" WHERE "journalEntryId" = target_id;

  IF line_count < 2 THEN
    RAISE EXCEPTION 'Journal entry % is POSTED with % line(s); a double entry needs at least 2', target_id, line_count;
  END IF;

  IF total_debit <> total_credit THEN
    RAISE EXCEPTION 'Journal entry % does not balance: debits %, credits %', target_id, total_debit, total_credit;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "journal_lines_balance_check"
  AFTER INSERT OR UPDATE OR DELETE ON "journal_lines"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_entry_balanced();

CREATE CONSTRAINT TRIGGER "journal_entries_balance_check"
  AFTER INSERT OR UPDATE ON "journal_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_entry_balanced();

-- 3. A POSTED entry is immutable. Corrections post a linked reversing entry.
CREATE OR REPLACE FUNCTION forbid_posted_journal_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'POSTED' THEN
      RAISE EXCEPTION 'Journal entry % is POSTED and cannot be deleted; post a reversing entry instead', OLD."id";
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."status" = 'POSTED' THEN
    RAISE EXCEPTION 'Journal entry % is POSTED and cannot be modified; post a reversing entry instead', OLD."id";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "journal_entries_immutable_when_posted"
  BEFORE UPDATE OR DELETE ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION forbid_posted_journal_mutation();

-- 4. Lines of a POSTED entry are immutable too, or the balance could be
--    changed out from under a posted header.
CREATE OR REPLACE FUNCTION forbid_posted_journal_line_mutation()
RETURNS TRIGGER AS $$
DECLARE
  entry_status TEXT;
  target_id TEXT;
BEGIN
  target_id := COALESCE(OLD."journalEntryId", NEW."journalEntryId");
  SELECT "status" INTO entry_status FROM "journal_entries" WHERE "id" = target_id;

  -- Null means the parent entry is being deleted in this same statement,
  -- which the header trigger has already vetted.
  IF entry_status = 'POSTED' THEN
    RAISE EXCEPTION 'Journal entry % is POSTED; its lines cannot be modified', target_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "journal_lines_immutable_when_posted"
  BEFORE UPDATE OR DELETE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION forbid_posted_journal_line_mutation();

-- 5. Nothing may post into a CLOSED fiscal period.
CREATE OR REPLACE FUNCTION forbid_posting_into_closed_period()
RETURNS TRIGGER AS $$
DECLARE
  period_status TEXT;
BEGIN
  IF NEW."status" <> 'POSTED' THEN
    RETURN NEW;
  END IF;

  SELECT "status" INTO period_status
    FROM "fiscal_periods" WHERE "id" = NEW."fiscalPeriodId";

  IF period_status = 'CLOSED' THEN
    RAISE EXCEPTION 'Fiscal period % is CLOSED; post the correction to an open period instead', NEW."fiscalPeriodId";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "journal_entries_respect_period_lock"
  BEFORE INSERT OR UPDATE ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION forbid_posting_into_closed_period();

-- 6. Only leaf/postable, active accounts may receive lines; parent accounts
--    exist for reporting rollup only. This is a cross-table rule, so it needs
--    a trigger rather than a CHECK constraint.
CREATE OR REPLACE FUNCTION assert_account_is_postable()
RETURNS TRIGGER AS $$
DECLARE
  postable BOOLEAN;
  active BOOLEAN;
BEGIN
  SELECT "isPostable", "isActive" INTO postable, active
    FROM "accounts" WHERE "id" = NEW."accountId";

  IF NOT postable THEN
    RAISE EXCEPTION 'Account % is a rollup parent and cannot be posted to', NEW."accountId";
  END IF;
  IF NOT active THEN
    RAISE EXCEPTION 'Account % is inactive and cannot be posted to', NEW."accountId";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "journal_lines_account_must_be_postable"
  BEFORE INSERT OR UPDATE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION assert_account_is_postable();
