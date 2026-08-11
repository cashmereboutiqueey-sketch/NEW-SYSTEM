-- Who counted the drawer.
--
-- The session already named the cashier who took the money. It did not name
-- the person who declared the drawer correct, which is the more interesting
-- half: one person sells, another counts, and the owner reads both names off
-- the same row.
ALTER TABLE "pos_sessions" ADD COLUMN "closedByUserId" TEXT;

ALTER TABLE "pos_sessions"
  ADD CONSTRAINT "pos_sessions_closedByUserId_fkey" FOREIGN KEY ("closedByUserId")
  REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "pos_sessions_closedByUserId_idx" ON "pos_sessions"("closedByUserId");
