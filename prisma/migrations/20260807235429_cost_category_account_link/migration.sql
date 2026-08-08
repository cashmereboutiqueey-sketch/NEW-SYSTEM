-- AlterTable
ALTER TABLE "cost_categories" ADD COLUMN     "accountId" TEXT;

-- AddForeignKey
ALTER TABLE "cost_categories" ADD CONSTRAINT "cost_categories_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
