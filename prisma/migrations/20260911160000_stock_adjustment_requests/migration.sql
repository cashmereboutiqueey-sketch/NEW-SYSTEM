-- A large count difference waits for a second person.
--
-- The counter used to pick an approver from a list on their own form, and the
-- name was accepted as the approval. Nobody had to sign in as that person, and
-- the approval right was checked against the counter, not the approver. Now a
-- large difference is recorded here and nothing moves until an approver,
-- signed in as themselves, approves it.
CREATE TYPE "StockAdjustmentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "stock_adjustment_requests" (
  "id" TEXT PRIMARY KEY,
  "lotId" TEXT NOT NULL,
  "countedQty" DECIMAL(18, 4) NOT NULL,
  "onBooksAtCount" DECIMAL(18, 4) NOT NULL,
  "difference" DECIMAL(18, 4) NOT NULL,
  "value" DECIMAL(18, 4) NOT NULL,
  "reason" TEXT NOT NULL,
  "countDate" DATE NOT NULL,
  "requestedByUserId" TEXT,
  "status" "StockAdjustmentStatus" NOT NULL DEFAULT 'PENDING',
  "decidedByUserId" TEXT,
  "decidedAt" TIMESTAMP(3),
  "decisionNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stock_adjustment_requests_lotId_fkey"
    FOREIGN KEY ("lotId") REFERENCES "inventory_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- Whoever counted it does not decide it.
  CONSTRAINT "stock_adjustment_decided_by_another"
    CHECK ("decidedByUserId" IS NULL OR "requestedByUserId" IS NULL
           OR "decidedByUserId" <> "requestedByUserId")
);
CREATE INDEX "stock_adjustment_requests_status_idx" ON "stock_adjustment_requests"("status");
CREATE INDEX "stock_adjustment_requests_lotId_idx" ON "stock_adjustment_requests"("lotId");
