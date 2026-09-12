ALTER TABLE "returns" ADD COLUMN "costAmount" DECIMAL(18,4),
  ADD COLUMN "creditAmount" DECIMAL(18,4) NOT NULL DEFAULT 0;
ALTER TABLE "shopify_webhook_events" ADD COLUMN "leaseUntil" TIMESTAMP(3);
CREATE TABLE "shopify_order_states" (
  "connectionId" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "cancelledAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("connectionId", "externalId")
);
