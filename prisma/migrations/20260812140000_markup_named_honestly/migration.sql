-- The factory's rate is applied as `cost x (1 + rate)`, which is a markup.
-- The column was called a margin, so a snapshot recording 0.25 was reported
-- as a 25% margin when the margin it actually earns is 20%: 150 profit on a
-- 750 price. The arithmetic was always right; only the name was wrong, and a
-- name that overstates every profit figure in the business is worth a
-- migration.
--
-- A rename, not a rewrite. Every stored value means exactly what it meant
-- before and no snapshot is touched.
ALTER TABLE "cost_snapshots" RENAME COLUMN "factoryMarginPct" TO "factoryMarkupPct";
ALTER TABLE "cost_snapshots" RENAME COLUMN "marginBelowArmsLength" TO "markupBelowArmsLength";

-- The settings that feed it, renamed to match. Left in place rather than
-- deleted and recreated so whatever the owner has already tuned survives.
UPDATE "settings" SET "key" = 'factory.markup.default'
  WHERE "key" = 'factory.margin.default';
UPDATE "settings" SET "key" = 'factory.markup.armsLengthMinimum'
  WHERE "key" = 'factory.margin.armsLengthMinimum';
