-- Every movement of cash through a till's drawer, on that till.
--
-- A till's expected cash was the opening float plus the cash payments on its
-- own sales. Everything else that goes through the same drawer — a consigned
-- garment sold for cash, a cash refund, a deposit, a debt paid off — was
-- missing, so the count was short or over by amounts that were nobody's fault,
-- and a collection made next month counted against last month's till.
CREATE TYPE "TillCashKind" AS ENUM ('SALE', 'CONSIGNMENT_SALE', 'REFUND', 'DEPOSIT', 'COLLECTION', 'PAYOUT');

CREATE TABLE "till_cash_events" (
  "id" TEXT PRIMARY KEY,
  "posSessionId" TEXT NOT NULL,
  "kind" "TillCashKind" NOT NULL,
  "amount" DECIMAL(18, 4) NOT NULL,
  "reference" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "till_cash_events_posSessionId_fkey"
    FOREIGN KEY ("posSessionId") REFERENCES "pos_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "till_cash_events_posSessionId_idx" ON "till_cash_events"("posSessionId");

-- One open till per location, held by the database rather than by a check
-- two simultaneous requests could both pass.
CREATE UNIQUE INDEX "pos_sessions_one_open_per_location"
  ON "pos_sessions"("locationId") WHERE "closedAt" IS NULL;

-- History: what the old calculation counted, so tills already open close on
-- the same basis — the cash payments on each till's own orders ...
INSERT INTO "till_cash_events" ("id", "posSessionId", "kind", "amount", "reference", "occurredAt")
SELECT 'tce_' || p."id", o."posSessionId", 'SALE', p."amount", o."orderNumber", p."createdAt"
FROM "sales_payments" p
JOIN "sales_orders" o ON o."id" = p."salesOrderId"
WHERE o."posSessionId" IS NOT NULL
  AND p."method" = 'CASH'
  AND p."status" = 'COLLECTED';

-- ... and the consigned garments sold for cash on it, which it left out.
INSERT INTO "till_cash_events" ("id", "posSessionId", "kind", "amount", "reference", "occurredAt")
SELECT 'tce_' || cs."id", cs."posSessionId", 'CONSIGNMENT_SALE',
       cs."commissionAmount" + cs."ownerAmount", cs."saleNumber", cs."createdAt"
FROM "consignment_sales" cs
WHERE cs."posSessionId" IS NOT NULL
  AND cs."paymentMethod" = 'CASH';
