CREATE TABLE "command_receipts" (
  "key" TEXT PRIMARY KEY,
  "operation" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "command_receipts_createdAt_idx" ON "command_receipts" ("createdAt");

-- NOT VALID preserves existing history for deliberate reconciliation, while
-- enforcing these invariants on every new or updated owned-stock row.
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lot_quantity_bounds"
  CHECK ("originalQty" >= 0 AND "remainingQty" >= 0 AND "reservedQty" >= 0
    AND "reservedQty" <= "remainingQty" AND "unitCost" >= 0) NOT VALID;

CREATE OR REPLACE FUNCTION forbid_posted_journal_line_insert()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM journal_entries e WHERE e.id=NEW."journalEntryId" AND e.status='POSTED') THEN
    RAISE EXCEPTION 'Cannot append lines to a posted journal; create a reversal or adjustment';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "journal_lines_no_append_when_posted"
  BEFORE INSERT ON journal_lines FOR EACH ROW EXECUTE FUNCTION forbid_posted_journal_line_insert();
