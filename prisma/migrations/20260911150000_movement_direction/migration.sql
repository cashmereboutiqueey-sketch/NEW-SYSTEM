-- Stock movements that add up.
--
-- A lot's balance was meant to be the sum of its movements, but the direction
-- of a movement was inferred from its type, and two types could not carry it:
--
--   - A transfer wrote one movement, on the lot the goods arrived in. The lot
--     they left was decremented with no movement at all, and replaying the
--     history read the arrival as a departure.
--   - A stock count wrote the size of the difference, not its sign, so a count
--     that found extra stock replayed as stock that went missing.
--
-- Every movement now states its direction, a transfer writes both legs, and a
-- lot's balance is its inbound legs less its outbound ones.
CREATE TYPE "MovementDirection" AS ENUM ('IN', 'OUT');

ALTER TABLE "inventory_movements" ADD COLUMN "direction" "MovementDirection";

-- The types that only ever go one way.
UPDATE "inventory_movements" SET "direction" = 'IN'
WHERE "type" IN ('RECEIPT', 'PRODUCTION_OUTPUT', 'RETURN_IN');

UPDATE "inventory_movements" SET "direction" = 'OUT'
WHERE "type" IN ('ISSUE_TO_PRODUCTION', 'SALE', 'SCRAP');

-- A transfer recorded against the lot it arrived in was the arrival, except
-- the Brand's intake, which recorded the transit lot the goods left.
UPDATE "inventory_movements" SET "direction" =
  CASE WHEN "referenceType" = 'TRANSFER_INVOICE' THEN 'OUT'::"MovementDirection"
       ELSE 'IN'::"MovementDirection" END
WHERE "type" = 'TRANSFER';

-- A count's direction is in its journal: stock debited means stock found.
UPDATE "inventory_movements" m SET "direction" =
  CASE WHEN EXISTS (
    SELECT 1 FROM "journal_lines" jl
    JOIN "accounts" a ON a."id" = jl."accountId"
    WHERE jl."journalEntryId" = m."journalEntryId"
      AND a."reportingCategory" IN ('INVENTORY_RAW', 'INVENTORY_FG')
      AND jl."debit" > 0
  ) THEN 'IN'::"MovementDirection" ELSE 'OUT'::"MovementDirection" END
WHERE "type" = 'ADJUSTMENT';

-- Lots whose balance changed with no movement of their own — the side of a
-- transfer that was never written. The history cannot say when, so the gap is
-- recorded once, today, and says what it is rather than inventing the event.
INSERT INTO "inventory_movements"
  ("id", "lotId", "type", "direction", "quantity", "unitCost", "totalCost",
   "movementDate", "referenceType", "notes", "createdAt")
SELECT
  'mvbf_' || gap."lotId",
  gap."lotId",
  'ADJUSTMENT',
  CASE WHEN gap.missing > 0 THEN 'OUT'::"MovementDirection" ELSE 'IN'::"MovementDirection" END,
  ABS(gap.missing),
  gap."unitCost",
  ABS(gap.missing) * gap."unitCost",
  CURRENT_DATE,
  'MOVEMENT_HISTORY_BACKFILL',
  'Recorded before movements carried a direction: this lot''s balance changed without a movement of its own, most often the departing side of a transfer.',
  CURRENT_TIMESTAMP
FROM (
  SELECT l."id" AS "lotId", l."unitCost",
         COALESCE(SUM(CASE WHEN m."direction" = 'IN' THEN m."quantity" ELSE -m."quantity" END), 0)
           - l."remainingQty" AS missing
  FROM "inventory_lots" l
  LEFT JOIN "inventory_movements" m ON m."lotId" = l."id"
  GROUP BY l."id", l."unitCost", l."remainingQty"
) gap
WHERE gap.missing <> 0;

ALTER TABLE "inventory_movements" ALTER COLUMN "direction" SET NOT NULL;
