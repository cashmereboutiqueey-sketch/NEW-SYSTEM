-- AlterTable
ALTER TABLE "inventory_lots" ADD COLUMN     "sourceCostSnapshotId" TEXT,
ADD COLUMN     "transferMarginPerUnit" DECIMAL(18,4);

-- AddForeignKey
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_sourceCostSnapshotId_fkey" FOREIGN KEY ("sourceCostSnapshotId") REFERENCES "cost_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

