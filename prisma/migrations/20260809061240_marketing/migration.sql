-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('PLANNED', 'RUNNING', 'PAUSED', 'FINISHED');

-- CreateEnum
CREATE TYPE "AdPlatform" AS ENUM ('META', 'GOOGLE', 'TIKTOK', 'INFLUENCER', 'EMAIL', 'WHATSAPP', 'OTHER');

-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "campaignId" TEXT;

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'PLANNED',
    "platform" "AdPlatform" NOT NULL DEFAULT 'META',
    "objective" TEXT,
    "audience" TEXT,
    "collectionId" TEXT,
    "styleId" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "budget" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "couponCode" TEXT,
    "creatorName" TEXT,
    "creatorFee" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_spend" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "spendDate" DATE NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "reportedConversions" INTEGER NOT NULL DEFAULT 0,
    "expenseId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_spend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_code_key" ON "campaigns"("code");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_couponCode_key" ON "campaigns"("couponCode");

-- CreateIndex
CREATE INDEX "campaigns_status_startDate_idx" ON "campaigns"("status", "startDate");

-- CreateIndex
CREATE INDEX "campaign_spend_spendDate_idx" ON "campaign_spend"("spendDate");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_spend_campaignId_spendDate_key" ON "campaign_spend"("campaignId", "spendDate");

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_styleId_fkey" FOREIGN KEY ("styleId") REFERENCES "styles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_spend" ADD CONSTRAINT "campaign_spend_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

