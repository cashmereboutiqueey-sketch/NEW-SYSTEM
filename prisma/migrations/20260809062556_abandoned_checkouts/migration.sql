-- CreateTable
CREATE TABLE "abandoned_checkouts" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "customerName" TEXT,
    "city" TEXT,
    "customerId" TEXT,
    "totalValue" DECIMAL(18,4) NOT NULL,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "lineItems" JSONB,
    "recoveryUrl" TEXT,
    "abandonedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recoveredOrderId" TEXT,
    "recoveredAt" TIMESTAMP(3),
    "contactedAt" TIMESTAMP(3),
    "contactedVia" TEXT,
    "contactNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "abandoned_checkouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "abandoned_checkouts_abandonedAt_idx" ON "abandoned_checkouts"("abandonedAt");

-- CreateIndex
CREATE INDEX "abandoned_checkouts_recoveredOrderId_idx" ON "abandoned_checkouts"("recoveredOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "abandoned_checkouts_connectionId_externalId_key" ON "abandoned_checkouts"("connectionId", "externalId");

-- AddForeignKey
ALTER TABLE "abandoned_checkouts" ADD CONSTRAINT "abandoned_checkouts_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

