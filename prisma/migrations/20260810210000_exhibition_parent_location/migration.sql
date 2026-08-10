-- A temporary location needs to know where its stock came from, so whatever
-- does not sell has somewhere definite to go back to. Inferring it from the
-- movements would break the moment a bazaar is stocked from two branches.
ALTER TABLE "locations" ADD COLUMN "parentLocationId" TEXT;

ALTER TABLE "locations"
  ADD CONSTRAINT "locations_parentLocationId_fkey"
  FOREIGN KEY ("parentLocationId") REFERENCES "locations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "locations_parentLocationId_idx" ON "locations"("parentLocationId");

-- A location cannot be its own parent. Cheap to state, and it stops a close
-- from returning stock to the place it is trying to empty.
ALTER TABLE "locations"
  ADD CONSTRAINT "locations_parent_not_self"
  CHECK ("parentLocationId" IS NULL OR "parentLocationId" <> "id");
