-- Who raised the document.
--
-- Needed on the row, not only in the audit log. The rule that matters is that
-- the approver is not the person who asked, and that cannot be checked
-- against a log entry somebody would have to go looking for — it has to be
-- one field away from the approval itself.
ALTER TABLE "expenses"        ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "purchase_orders" ADD COLUMN "createdByUserId" TEXT;

ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_createdByUserId_fkey" FOREIGN KEY ("createdByUserId")
    REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "purchase_orders"
  ADD CONSTRAINT "purchase_orders_createdByUserId_fkey" FOREIGN KEY ("createdByUserId")
    REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "expenses_createdByUserId_idx"        ON "expenses"("createdByUserId");
CREATE INDEX "purchase_orders_createdByUserId_idx" ON "purchase_orders"("createdByUserId");
