ALTER TABLE "shipments"
  ADD COLUMN "apiSubmittedAt" TIMESTAMP(3),
  ADD COLUMN "trackingNumber" TEXT,
  ADD COLUMN "trackingUrl" TEXT;
