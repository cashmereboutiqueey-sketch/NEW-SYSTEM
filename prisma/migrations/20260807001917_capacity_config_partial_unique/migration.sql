-- DropIndex
DROP INDEX "capacity_configs_entityId_fiscalPeriodId_lineId_key";

-- CreateIndex
CREATE INDEX "capacity_configs_entityId_fiscalPeriodId_idx" ON "capacity_configs"("entityId", "fiscalPeriodId");

-- Partial unique indexes.
-- A plain UNIQUE(entityId, fiscalPeriodId, lineId) does NOT constrain the
-- factory-wide row, because in Postgres NULL is never equal to NULL — so any
-- number of duplicate factory-wide configs for the same period would be
-- accepted. These two partial indexes close that hole.
CREATE UNIQUE INDEX "capacity_configs_entity_period_factorywide_key"
  ON "capacity_configs" ("entityId", "fiscalPeriodId")
  WHERE "lineId" IS NULL;

CREATE UNIQUE INDEX "capacity_configs_entity_period_line_key"
  ON "capacity_configs" ("entityId", "fiscalPeriodId", "lineId")
  WHERE "lineId" IS NOT NULL;
