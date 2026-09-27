-- Older interrupted imports were inserted as SUCCESS before processing began.
-- They have no finishedAt and created no sales; mark them truthfully as failed.
UPDATE "sync_logs"
SET "status" = 'FAILED'
WHERE "objectType" = 'order'
  AND "direction" = 'INBOUND'
  AND "status" = 'SUCCESS'
  AND "finishedAt" IS NULL
  AND "startedAt" < NOW() - INTERVAL '1 hour';
