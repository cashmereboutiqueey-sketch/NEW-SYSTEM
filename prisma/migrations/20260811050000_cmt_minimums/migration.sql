-- The smallest run a CMT client may place.
--
-- Per client rather than one house rule: a long-standing customer bringing
-- repeat work is worth taking a short run for, and a stranger is not. Null
-- falls back to the house minimum in settings.
ALTER TABLE "cmt_clients" ADD COLUMN "minimumQuantity" INTEGER;

ALTER TABLE "cmt_clients"
  ADD CONSTRAINT "cmt_clients_minimum_positive"
  CHECK ("minimumQuantity" IS NULL OR "minimumQuantity" > 0);
