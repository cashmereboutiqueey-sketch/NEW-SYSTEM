-- Shopify deliveries, kept before they are acted on.
--
-- A delivery used to be processed straight from the request. A repeat was
-- harmless only because an order already mapped was skipped — which also
-- meant a later "paid" or "cancelled" for that order was skipped, and a
-- delivery that failed half-way existed nowhere once the request ended.
CREATE TYPE "WebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED');

CREATE TABLE "shopify_webhook_events" (
  "id" TEXT PRIMARY KEY,
  "connectionId" TEXT NOT NULL,
  "webhookId" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "WebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "shopify_webhook_events_webhookId_key" ON "shopify_webhook_events"("webhookId");
CREATE INDEX "shopify_webhook_events_status_idx" ON "shopify_webhook_events"("status");

-- The version Shopify actually answered with, to notice when the one asked
-- for has fallen out of support.
ALTER TABLE "integration_connections" ADD COLUMN "servedApiVersion" TEXT;
