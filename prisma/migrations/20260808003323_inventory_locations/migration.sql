-- CreateEnum
CREATE TYPE "LocationKind" AS ENUM ('FACTORY_WAREHOUSE', 'SHOWROOM', 'STORE', 'EXHIBITION', 'TRANSIT');

-- DropIndex
DROP INDEX "inventory_lots_materialId_idx";

-- DropIndex
DROP INDEX "inventory_lots_variantId_idx";

-- AlterTable
ALTER TABLE "inventory_lots" ADD COLUMN     "entityId" TEXT,
ADD COLUMN     "locationId" TEXT,
ADD COLUMN     "reservedQty" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "sequence" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "inventory_movements" ADD COLUMN     "fromLocationId" TEXT,
ADD COLUMN     "journalEntryId" TEXT,
ADD COLUMN     "toLocationId" TEXT;

-- CreateTable
CREATE TABLE "locations" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "kind" "LocationKind" NOT NULL,
    "entityId" TEXT,
    "city" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "opensAt" DATE,
    "closesAt" DATE,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "locations_code_key" ON "locations"("code");

-- CreateIndex
CREATE INDEX "locations_kind_isActive_idx" ON "locations"("kind", "isActive");

-- CreateIndex
CREATE INDEX "inventory_lots_materialId_locationId_receivedDate_sequence_idx" ON "inventory_lots"("materialId", "locationId", "receivedDate", "sequence");

-- CreateIndex
CREATE INDEX "inventory_lots_variantId_locationId_receivedDate_sequence_idx" ON "inventory_lots"("variantId", "locationId", "receivedDate", "sequence");

-- CreateIndex
CREATE INDEX "inventory_movements_referenceType_referenceId_idx" ON "inventory_movements"("referenceType", "referenceId");

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
