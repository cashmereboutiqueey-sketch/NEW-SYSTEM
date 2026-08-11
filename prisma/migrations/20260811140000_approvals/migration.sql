-- Somebody other than the person who raised it has to say yes.
--
-- The role map already said an accountant may create an expense and not
-- approve it, and that a finance approver may approve one and not create it.
-- Nothing enforced that, because there was no approval step to enforce — the
-- separation existed on paper and money left the business without a second
-- signature.
--
-- Approval is kept separate from payment status on purpose. An expense can be
-- approved and unpaid, or paid without ever needing approval because it was
-- small enough not to warrant one. Folding the two into a single enum would
-- make "paid" and "approved" the same fact, which they are not.

ALTER TABLE "expenses"
  ADD COLUMN "approvedByUserId" TEXT,
  ADD COLUMN "approvedAt"       TIMESTAMP(3),
  ADD COLUMN "rejectedAt"       TIMESTAMP(3),
  ADD COLUMN "rejectionReason"  TEXT;

ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId")
    REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- An expense cannot be approved and rejected at the same time.
ALTER TABLE "expenses"
  ADD CONSTRAINT "expenses_not_both_approved_and_rejected"
  CHECK ("approvedAt" IS NULL OR "rejectedAt" IS NULL);

CREATE INDEX "expenses_approvedAt_idx" ON "expenses"("approvedAt");

ALTER TABLE "purchase_orders"
  ADD COLUMN "approvedByUserId" TEXT,
  ADD COLUMN "approvedAt"       TIMESTAMP(3),
  ADD COLUMN "rejectedAt"       TIMESTAMP(3),
  ADD COLUMN "rejectionReason"  TEXT;

ALTER TABLE "purchase_orders"
  ADD CONSTRAINT "purchase_orders_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId")
    REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "purchase_orders"
  ADD CONSTRAINT "purchase_orders_not_both_approved_and_rejected"
  CHECK ("approvedAt" IS NULL OR "rejectedAt" IS NULL);

CREATE INDEX "purchase_orders_approvedAt_idx" ON "purchase_orders"("approvedAt");
