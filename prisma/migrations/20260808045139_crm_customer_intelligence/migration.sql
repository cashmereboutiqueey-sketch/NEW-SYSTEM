-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "acquiredVia" "OrderSource",
ADD COLUMN     "consentRecordedAt" TIMESTAMP(3),
ADD COLUMN     "emailNormalised" TEXT,
ADD COLUMN     "isSuppressed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "marketingConsent" BOOLEAN,
ADD COLUMN     "mergedAt" TIMESTAMP(3),
ADD COLUMN     "mergedIntoId" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "phoneNormalised" TEXT;

-- CreateIndex
CREATE INDEX "customers_phoneNormalised_idx" ON "customers"("phoneNormalised");

-- CreateIndex
CREATE INDEX "customers_emailNormalised_idx" ON "customers"("emailNormalised");

-- CreateIndex
CREATE INDEX "customers_mergedIntoId_idx" ON "customers"("mergedIntoId");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

