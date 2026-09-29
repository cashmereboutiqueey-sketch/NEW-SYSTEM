ALTER TABLE "users"
  ADD COLUMN "quickPinHash" TEXT,
  ADD COLUMN "failedQuickPins" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "quickPinLockedUntil" TIMESTAMP(3);

ALTER TABLE "pos_sessions"
  ADD COLUMN "sharedWithCashiers" BOOLEAN NOT NULL DEFAULT false;
