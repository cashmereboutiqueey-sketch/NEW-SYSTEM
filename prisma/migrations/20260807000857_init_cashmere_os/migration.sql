-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ACCOUNTANT', 'PRODUCTION', 'VIEWER');

-- CreateEnum
CREATE TYPE "SettingType" AS ENUM ('DECIMAL', 'INTEGER', 'PERCENT', 'STRING', 'BOOLEAN', 'JSON');

-- CreateEnum
CREATE TYPE "EntityKind" AS ENUM ('FACTORY', 'BRAND');

-- CreateEnum
CREATE TYPE "PeriodStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "UomKind" AS ENUM ('LENGTH', 'MASS', 'PIECE', 'AREA');

-- CreateEnum
CREATE TYPE "CostBehaviour" AS ENUM ('FIXED', 'VARIABLE', 'SEMI_VARIABLE');

-- CreateEnum
CREATE TYPE "ExpenseStatus" AS ENUM ('UNPAID', 'PARTIALLY_PAID', 'PAID');

-- CreateEnum
CREATE TYPE "MinuteRateStatus" AS ENUM ('PROVISIONAL', 'LOCKED');

-- CreateEnum
CREATE TYPE "BookingSource" AS ENUM ('PRODUCTION_ORDER', 'CMT_ORDER', 'MAINTENANCE', 'SAMPLING');

-- CreateEnum
CREATE TYPE "MaterialType" AS ENUM ('FABRIC', 'TRIM', 'PACKAGING', 'CONSUMABLE');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProductionOrderStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'IN_PRODUCTION', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProductionStage" AS ENUM ('CUTTING', 'SEWING', 'FINISHING', 'QC', 'PACKING');

-- CreateEnum
CREATE TYPE "ScrapDisposition" AS ENUM ('SOLD', 'DISCARDED', 'USED_FOR_SAMPLING', 'RETURNED_TO_STOCK');

-- CreateEnum
CREATE TYPE "ReworkType" AS ENUM ('RESEWING', 'REPRESSING', 'REPACKING', 'RECUTTING', 'WASHING');

-- CreateEnum
CREATE TYPE "InventoryState" AS ENUM ('RAW_MATERIAL', 'WIP', 'FINISHED_GOODS');

-- CreateEnum
CREATE TYPE "MovementType" AS ENUM ('RECEIPT', 'ISSUE_TO_PRODUCTION', 'PRODUCTION_OUTPUT', 'SALE', 'RETURN_IN', 'SCRAP', 'ADJUSTMENT', 'TRANSFER');

-- CreateEnum
CREATE TYPE "ChannelKind" AS ENUM ('ONLINE', 'RETAIL_STORE', 'WHOLESALE', 'MARKETPLACE');

-- CreateEnum
CREATE TYPE "SalesOrderStatus" AS ENUM ('PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURNED');

-- CreateEnum
CREATE TYPE "ReturnDisposition" AS ENUM ('RESTOCK', 'WRITE_OFF', 'REPAIR_AND_RESTOCK');

-- CreateEnum
CREATE TYPE "CMTQuoteStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CMTOrderStatus" AS ENUM ('CONFIRMED', 'IN_PRODUCTION', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CashDirection" AS ENUM ('INFLOW', 'OUTFLOW');

-- CreateEnum
CREATE TYPE "CashItemFrequency" AS ENUM ('ONE_OFF', 'MONTHLY', 'QUARTERLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'SNOOZED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'VIEWER',
    "locale" TEXT NOT NULL DEFAULT 'ar',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityName" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "type" "SettingType" NOT NULL,
    "group" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "labelAr" TEXT NOT NULL,
    "descriptionEn" TEXT,
    "descriptionAr" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entities" (
    "id" TEXT NOT NULL,
    "kind" "EntityKind" NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "baseCurrency" TEXT NOT NULL DEFAULT 'EGP',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_periods" (
    "id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" "PeriodStatus" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "fiscal_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "color_codes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "hex" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "color_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "size_codes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "consumptionFactor" DECIMAL(9,6) NOT NULL DEFAULT 1.0,

    CONSTRAINT "size_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "units_of_measure" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "kind" "UomKind" NOT NULL,

    CONSTRAINT "units_of_measure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_categories" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "behaviour" "CostBehaviour" NOT NULL DEFAULT 'FIXED',
    "includeInMinuteRate" BOOLEAN NOT NULL DEFAULT false,
    "includeInBrandFixedPool" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "cost_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "costCategoryId" TEXT NOT NULL,
    "fiscalPeriodId" TEXT NOT NULL,
    "supplierId" TEXT,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "amount" DECIMAL(18,4) NOT NULL,
    "vatAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "incurredDate" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "paidAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "status" "ExpenseStatus" NOT NULL DEFAULT 'UNPAID',
    "adjustsExpenseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_payments" (
    "id" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "paidDate" DATE NOT NULL,
    "method" TEXT,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_lines" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "production_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operators" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lineId" TEXT,
    "hiredAt" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "operators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capacity_configs" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fiscalPeriodId" TEXT NOT NULL,
    "lineId" TEXT,
    "operators" INTEGER NOT NULL,
    "workingDays" DECIMAL(9,4) NOT NULL,
    "hoursPerDay" DECIMAL(9,4) NOT NULL,
    "utilisationRate" DECIMAL(9,6) NOT NULL,
    "efficiencyRate" DECIMAL(9,6) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "capacity_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "minute_rate_periods" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fiscalPeriodId" TEXT NOT NULL,
    "status" "MinuteRateStatus" NOT NULL DEFAULT 'PROVISIONAL',
    "operators" INTEGER NOT NULL,
    "workingDays" DECIMAL(9,4) NOT NULL,
    "hoursPerDay" DECIMAL(9,4) NOT NULL,
    "utilisationRate" DECIMAL(9,6) NOT NULL,
    "efficiencyRate" DECIMAL(9,6) NOT NULL,
    "totalConversionCost" DECIMAL(18,4) NOT NULL,
    "cmtRevenueCredit" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "netCostPool" DECIMAL(18,4) NOT NULL,
    "grossAvailableMinutes" DECIMAL(18,4) NOT NULL,
    "productiveMinutes" DECIMAL(18,4) NOT NULL,
    "actualMinuteRate" DECIMAL(18,8) NOT NULL,
    "fullCapacityMinuteRate" DECIMAL(18,8) NOT NULL,
    "idlePenaltyPerMinute" DECIMAL(18,8) NOT NULL,
    "idleMinutes" DECIMAL(18,4) NOT NULL,
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),

    CONSTRAINT "minute_rate_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "minute_rate_components" (
    "id" TEXT NOT NULL,
    "minuteRatePeriodId" TEXT NOT NULL,
    "costCategoryCode" TEXT NOT NULL,
    "costCategoryName" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "expenseCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "minute_rate_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capacity_bookings" (
    "id" TEXT NOT NULL,
    "fiscalPeriodId" TEXT NOT NULL,
    "source" "BookingSource" NOT NULL,
    "productionOrderId" TEXT,
    "cmtOrderId" TEXT,
    "minutes" DECIMAL(18,4) NOT NULL,
    "bookedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "capacity_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "contactPerson" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "creditDays" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_scorecards" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "fiscalPeriodId" TEXT NOT NULL,
    "priceScore" DECIMAL(4,2) NOT NULL,
    "qualityScore" DECIMAL(4,2) NOT NULL,
    "deliveryScore" DECIMAL(4,2) NOT NULL,
    "overallScore" DECIMAL(4,2) NOT NULL,
    "onTimeDeliveryRate" DECIMAL(9,6),
    "defectRate" DECIMAL(9,6),
    "avgPriceVariance" DECIMAL(9,6),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_scorecards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "materials" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "type" "MaterialType" NOT NULL,
    "uomId" TEXT NOT NULL,
    "supplierId" TEXT,
    "basePrice" DECIMAL(18,4) NOT NULL,
    "freightPct" DECIMAL(9,6) NOT NULL DEFAULT 0,
    "dutyPct" DECIMAL(9,6) NOT NULL DEFAULT 0,
    "moq" DECIMAL(18,4),
    "packSize" DECIMAL(18,4),
    "leadTimeDays" INTEGER NOT NULL DEFAULT 0,
    "reorderPoint" DECIMAL(18,4),
    "colorCode" TEXT,
    "composition" TEXT,
    "gsm" DECIMAL(9,2),
    "widthCm" DECIMAL(9,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "materials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_price_history" (
    "id" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "basePrice" DECIMAL(18,4) NOT NULL,
    "freightPct" DECIMAL(9,6) NOT NULL,
    "dutyPct" DECIMAL(9,6) NOT NULL,
    "effectiveCost" DECIMAL(18,4) NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "material_price_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" TEXT NOT NULL,
    "poNumber" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "orderDate" DATE NOT NULL,
    "expectedDate" DATE,
    "creditDays" INTEGER NOT NULL DEFAULT 0,
    "dueDate" DATE,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_lines" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "freightPct" DECIMAL(9,6) NOT NULL DEFAULT 0,
    "dutyPct" DECIMAL(9,6) NOT NULL DEFAULT 0,
    "effectiveCost" DECIMAL(18,4) NOT NULL,
    "receivedQty" DECIMAL(18,4) NOT NULL DEFAULT 0,

    CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipts" (
    "id" TEXT NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "receivedDate" DATE NOT NULL,
    "invoiceRef" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipt_lines" (
    "id" TEXT NOT NULL,
    "goodsReceiptId" TEXT NOT NULL,
    "purchaseOrderLineId" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "acceptedQty" DECIMAL(18,4) NOT NULL,
    "rejectedQty" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "orderedUnitPrice" DECIMAL(18,4) NOT NULL,
    "actualUnitPrice" DECIMAL(18,4) NOT NULL,
    "actualEffectiveCost" DECIMAL(18,4) NOT NULL,
    "priceVariance" DECIMAL(18,4) NOT NULL,
    "priceVariancePct" DECIMAL(9,6) NOT NULL,

    CONSTRAINT "goods_receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collections" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "season" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "startDate" DATE,
    "endDate" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "styles" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "plannedWasteRate" DECIMAL(9,6) NOT NULL DEFAULT 0,
    "actualWasteRateTrailing" DECIMAL(9,6),
    "wasteVarianceFlagged" BOOLEAN NOT NULL DEFAULT false,
    "wasteLastComputedAt" TIMESTAMP(3),
    "totalSmvMinutes" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "retailPrice" DECIMAL(18,4),
    "targetMarginPct" DECIMAL(9,6),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "styles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "style_bom_lines" (
    "id" TEXT NOT NULL,
    "styleId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "standardConsumption" DECIMAL(18,4) NOT NULL,
    "wasteRateOverride" DECIMAL(9,6),
    "notes" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "style_bom_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "style_operations" (
    "id" TEXT NOT NULL,
    "styleId" TEXT NOT NULL,
    "lineId" TEXT,
    "sequence" INTEGER NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "smvMinutes" DECIMAL(18,4) NOT NULL,
    "machineType" TEXT,

    CONSTRAINT "style_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variants" (
    "id" TEXT NOT NULL,
    "styleId" TEXT NOT NULL,
    "colorCodeId" TEXT NOT NULL,
    "sizeCodeId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "barcode" TEXT,
    "shopifyVariantId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_snapshots" (
    "id" TEXT NOT NULL,
    "styleId" TEXT NOT NULL,
    "minuteRatePeriodId" TEXT NOT NULL,
    "minuteRate" DECIMAL(18,8) NOT NULL,
    "fullCapacityRate" DECIMAL(18,8) NOT NULL,
    "smvMinutes" DECIMAL(18,4) NOT NULL,
    "wasteRate" DECIMAL(9,6) NOT NULL,
    "factoryMarginPct" DECIMAL(9,6) NOT NULL,
    "fabricCost" DECIMAL(18,4) NOT NULL,
    "trimCost" DECIMAL(18,4) NOT NULL,
    "materialCost" DECIMAL(18,4) NOT NULL,
    "cmtCost" DECIMAL(18,4) NOT NULL,
    "factoryTotalCost" DECIMAL(18,4) NOT NULL,
    "transferPrice" DECIMAL(18,4) NOT NULL,
    "idleCapacityPenalty" DECIMAL(18,4) NOT NULL,
    "marginBelowArmsLength" BOOLEAN NOT NULL DEFAULT false,
    "approvedByUserId" TEXT,
    "approvalNote" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_snapshot_lines" (
    "id" TEXT NOT NULL,
    "costSnapshotId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "materialCode" TEXT NOT NULL,
    "materialNameEn" TEXT NOT NULL,
    "materialNameAr" TEXT NOT NULL,
    "materialType" "MaterialType" NOT NULL,
    "standardConsumption" DECIMAL(18,4) NOT NULL,
    "wasteRate" DECIMAL(9,6) NOT NULL,
    "effectiveConsumption" DECIMAL(18,4) NOT NULL,
    "unitCost" DECIMAL(18,4) NOT NULL,
    "lineCost" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "cost_snapshot_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_orders" (
    "id" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "styleId" TEXT NOT NULL,
    "status" "ProductionOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "costSnapshotId" TEXT,
    "minuteRatePeriodId" TEXT,
    "plannedQty" INTEGER NOT NULL,
    "actualQty" INTEGER,
    "rejectedQty" INTEGER NOT NULL DEFAULT 0,
    "orderDate" DATE NOT NULL,
    "plannedStart" DATE,
    "plannedFinish" DATE,
    "actualStart" DATE,
    "actualFinish" DATE,
    "confirmedAt" TIMESTAMP(3),
    "plannedFabricQty" DECIMAL(18,4),
    "actualFabricQty" DECIMAL(18,4),
    "fabricVariance" DECIMAL(18,4),
    "plannedSmvPerUnit" DECIMAL(18,4),
    "actualSmvPerUnit" DECIMAL(18,4),
    "plannedTotalMinutes" DECIMAL(18,4),
    "actualTotalMinutes" DECIMAL(18,4),
    "plannedTotalCost" DECIMAL(18,4),
    "actualTotalCost" DECIMAL(18,4),
    "costVariance" DECIMAL(18,4),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_order_lines" (
    "id" TEXT NOT NULL,
    "productionOrderId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "plannedQty" INTEGER NOT NULL,
    "actualQty" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "production_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cutting_tickets" (
    "id" TEXT NOT NULL,
    "ticketNumber" TEXT NOT NULL,
    "productionOrderId" TEXT NOT NULL,
    "cutDate" DATE NOT NULL,
    "markerLengthM" DECIMAL(18,4),
    "plies" INTEGER,
    "piecesCut" INTEGER NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cutting_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_issues" (
    "id" TEXT NOT NULL,
    "productionOrderId" TEXT NOT NULL,
    "cuttingTicketId" TEXT,
    "materialId" TEXT NOT NULL,
    "issueDate" DATE NOT NULL,
    "standardQty" DECIMAL(18,4) NOT NULL,
    "actualQty" DECIMAL(18,4) NOT NULL,
    "varianceQty" DECIMAL(18,4) NOT NULL,
    "actualWasteRate" DECIMAL(9,6) NOT NULL,
    "unitCost" DECIMAL(18,4) NOT NULL,
    "varianceValue" DECIMAL(18,4) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "material_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scrap_records" (
    "id" TEXT NOT NULL,
    "productionOrderId" TEXT,
    "materialId" TEXT NOT NULL,
    "disposition" "ScrapDisposition" NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "bookValue" DECIMAL(18,4) NOT NULL,
    "salvageValue" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "netLoss" DECIMAL(18,4) NOT NULL,
    "scrapDate" DATE NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scrap_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_stage_logs" (
    "id" TEXT NOT NULL,
    "productionOrderId" TEXT NOT NULL,
    "lineId" TEXT,
    "stage" "ProductionStage" NOT NULL,
    "logDate" DATE NOT NULL,
    "qtyIn" INTEGER NOT NULL,
    "qtyOut" INTEGER NOT NULL,
    "operatorsCount" INTEGER,
    "clockedMinutes" DECIMAL(18,4) NOT NULL,
    "earnedMinutes" DECIMAL(18,4) NOT NULL,
    "efficiencyRate" DECIMAL(9,6) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_stage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_productivity" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "logDate" DATE NOT NULL,
    "smvProduced" DECIMAL(18,4) NOT NULL,
    "clockedMinutes" DECIMAL(18,4) NOT NULL,
    "efficiencyRate" DECIMAL(9,6) NOT NULL,
    "notes" TEXT,

    CONSTRAINT "operator_productivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qc_records" (
    "id" TEXT NOT NULL,
    "productionOrderId" TEXT NOT NULL,
    "stage" "ProductionStage" NOT NULL DEFAULT 'QC',
    "inspectedQty" INTEGER NOT NULL,
    "passedQty" INTEGER NOT NULL,
    "reworkQty" INTEGER NOT NULL DEFAULT 0,
    "rejectedQty" INTEGER NOT NULL DEFAULT 0,
    "defectRate" DECIMAL(9,6) NOT NULL,
    "defectNotes" TEXT,
    "inspectionDate" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qc_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rework_records" (
    "id" TEXT NOT NULL,
    "productionOrderId" TEXT NOT NULL,
    "lineId" TEXT,
    "type" "ReworkType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "minutesPerUnit" DECIMAL(18,4) NOT NULL,
    "totalMinutes" DECIMAL(18,4) NOT NULL,
    "minuteRate" DECIMAL(18,8) NOT NULL,
    "labourCost" DECIMAL(18,4) NOT NULL,
    "materialCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "totalCost" DECIMAL(18,4) NOT NULL,
    "reworkDate" DATE NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rework_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_lots" (
    "id" TEXT NOT NULL,
    "lotNumber" TEXT NOT NULL,
    "state" "InventoryState" NOT NULL,
    "materialId" TEXT,
    "variantId" TEXT,
    "goodsReceiptLineId" TEXT,
    "productionOrderId" TEXT,
    "originalQty" DECIMAL(18,4) NOT NULL,
    "remainingQty" DECIMAL(18,4) NOT NULL,
    "unitCost" DECIMAL(18,4) NOT NULL,
    "receivedDate" DATE NOT NULL,
    "isDeadStock" BOOLEAN NOT NULL DEFAULT false,
    "deadStockFlaggedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "type" "MovementType" NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unitCost" DECIMAL(18,4) NOT NULL,
    "totalCost" DECIMAL(18,4) NOT NULL,
    "movementDate" DATE NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_channels" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "kind" "ChannelKind" NOT NULL,
    "paymentFeePct" DECIMAL(9,6) NOT NULL DEFAULT 0,
    "paymentFeeFixed" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "shippingCostPerOrder" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "defaultReturnRate" DECIMAL(9,6) NOT NULL DEFAULT 0,
    "defaultDiscountRate" DECIMAL(9,6) NOT NULL DEFAULT 0,
    "collectionDays" INTEGER NOT NULL DEFAULT 0,
    "city" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "sales_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channelId" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "city" TEXT,
    "creditDays" INTEGER NOT NULL DEFAULT 0,
    "shopifyCustomerId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_orders" (
    "id" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "customerId" TEXT,
    "status" "SalesOrderStatus" NOT NULL DEFAULT 'PENDING',
    "orderDate" DATE NOT NULL,
    "shippedDate" DATE,
    "deliveredDate" DATE,
    "collectedDate" DATE,
    "grossAmount" DECIMAL(18,4) NOT NULL,
    "discountAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(18,4) NOT NULL,
    "shippingAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "paymentFee" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "shopifyOrderId" TEXT,
    "city" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order_lines" (
    "id" TEXT NOT NULL,
    "salesOrderId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "retailPrice" DECIMAL(18,4) NOT NULL,
    "discountPct" DECIMAL(9,6) NOT NULL DEFAULT 0,
    "netPrice" DECIMAL(18,4) NOT NULL,
    "lineTotal" DECIMAL(18,4) NOT NULL,
    "unitCost" DECIMAL(18,4) NOT NULL,
    "lineCost" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "sales_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "returns" (
    "id" TEXT NOT NULL,
    "returnNumber" TEXT NOT NULL,
    "salesOrderId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reason" TEXT,
    "disposition" "ReturnDisposition" NOT NULL DEFAULT 'RESTOCK',
    "handlingCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "refundAmount" DECIMAL(18,4) NOT NULL,
    "returnDate" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cmt_clients" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactPerson" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "creditDays" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cmt_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cmt_quotes" (
    "id" TEXT NOT NULL,
    "quoteNumber" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "minuteRatePeriodId" TEXT NOT NULL,
    "status" "CMTQuoteStatus" NOT NULL DEFAULT 'DRAFT',
    "styleDescription" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "smvPerUnit" DECIMAL(18,4) NOT NULL,
    "totalMinutes" DECIMAL(18,4) NOT NULL,
    "floorMinuteRate" DECIMAL(18,8) NOT NULL,
    "quotedMinuteRate" DECIMAL(18,8) NOT NULL,
    "marginOverFloorPct" DECIMAL(9,6) NOT NULL,
    "quotedUnitPrice" DECIMAL(18,4) NOT NULL,
    "quotedTotal" DECIMAL(18,4) NOT NULL,
    "validUntil" DATE,
    "quoteDate" DATE NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cmt_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cmt_orders" (
    "id" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "quoteId" TEXT,
    "status" "CMTOrderStatus" NOT NULL DEFAULT 'CONFIRMED',
    "quantity" INTEGER NOT NULL,
    "smvPerUnit" DECIMAL(18,4) NOT NULL,
    "totalMinutes" DECIMAL(18,4) NOT NULL,
    "agreedMinuteRate" DECIMAL(18,8) NOT NULL,
    "contractValue" DECIMAL(18,4) NOT NULL,
    "actualMinutes" DECIMAL(18,4),
    "actualCost" DECIMAL(18,4),
    "realisedMargin" DECIMAL(18,4),
    "orderDate" DATE NOT NULL,
    "dueDate" DATE,
    "completedAt" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cmt_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_cash_items" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "costCategoryId" TEXT,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "direction" "CashDirection" NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "frequency" "CashItemFrequency" NOT NULL DEFAULT 'MONTHLY',
    "dayOfMonth" INTEGER NOT NULL DEFAULT 1,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "scheduled_cash_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_rules" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "descriptionEn" TEXT,
    "descriptionAr" TEXT,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'WARNING',
    "parameters" JSONB NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" TEXT NOT NULL,
    "alertRuleId" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "titleEn" TEXT NOT NULL,
    "titleAr" TEXT NOT NULL,
    "bodyEn" TEXT NOT NULL,
    "bodyAr" TEXT NOT NULL,
    "subjectType" TEXT,
    "subjectId" TEXT,
    "metrics" JSONB,
    "dedupeKey" TEXT NOT NULL,
    "acknowledgedByUserId" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "snoozedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scenarios" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "descriptionEn" TEXT,
    "descriptionAr" TEXT,
    "createdByUserId" TEXT,
    "assumptions" JSONB NOT NULL,
    "baselinePeriodId" TEXT,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scenario_results" (
    "id" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "metricKey" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "labelAr" TEXT NOT NULL,
    "baseline" DECIMAL(18,4) NOT NULL,
    "simulated" DECIMAL(18,4) NOT NULL,
    "delta" DECIMAL(18,4) NOT NULL,
    "deltaPct" DECIMAL(9,6),
    "unit" TEXT NOT NULL DEFAULT 'EGP',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scenario_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "audit_logs_entityName_entityId_idx" ON "audit_logs"("entityName", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "settings_key_key" ON "settings"("key");

-- CreateIndex
CREATE INDEX "settings_group_idx" ON "settings"("group");

-- CreateIndex
CREATE UNIQUE INDEX "entities_kind_key" ON "entities"("kind");

-- CreateIndex
CREATE INDEX "fiscal_periods_startDate_idx" ON "fiscal_periods"("startDate");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_periods_year_month_key" ON "fiscal_periods"("year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "color_codes_code_key" ON "color_codes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "size_codes_code_key" ON "size_codes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "units_of_measure_code_key" ON "units_of_measure"("code");

-- CreateIndex
CREATE UNIQUE INDEX "cost_categories_entityId_code_key" ON "cost_categories"("entityId", "code");

-- CreateIndex
CREATE INDEX "expenses_entityId_incurredDate_idx" ON "expenses"("entityId", "incurredDate");

-- CreateIndex
CREATE INDEX "expenses_dueDate_status_idx" ON "expenses"("dueDate", "status");

-- CreateIndex
CREATE INDEX "expenses_fiscalPeriodId_idx" ON "expenses"("fiscalPeriodId");

-- CreateIndex
CREATE INDEX "expense_payments_expenseId_idx" ON "expense_payments"("expenseId");

-- CreateIndex
CREATE INDEX "expense_payments_paidDate_idx" ON "expense_payments"("paidDate");

-- CreateIndex
CREATE UNIQUE INDEX "production_lines_code_key" ON "production_lines"("code");

-- CreateIndex
CREATE UNIQUE INDEX "operators_code_key" ON "operators"("code");

-- CreateIndex
CREATE INDEX "operators_lineId_idx" ON "operators"("lineId");

-- CreateIndex
CREATE UNIQUE INDEX "capacity_configs_entityId_fiscalPeriodId_lineId_key" ON "capacity_configs"("entityId", "fiscalPeriodId", "lineId");

-- CreateIndex
CREATE UNIQUE INDEX "minute_rate_periods_entityId_fiscalPeriodId_key" ON "minute_rate_periods"("entityId", "fiscalPeriodId");

-- CreateIndex
CREATE INDEX "minute_rate_components_minuteRatePeriodId_idx" ON "minute_rate_components"("minuteRatePeriodId");

-- CreateIndex
CREATE INDEX "capacity_bookings_fiscalPeriodId_idx" ON "capacity_bookings"("fiscalPeriodId");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_code_key" ON "suppliers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_scorecards_supplierId_fiscalPeriodId_key" ON "supplier_scorecards"("supplierId", "fiscalPeriodId");

-- CreateIndex
CREATE UNIQUE INDEX "materials_code_key" ON "materials"("code");

-- CreateIndex
CREATE INDEX "materials_type_idx" ON "materials"("type");

-- CreateIndex
CREATE INDEX "material_price_history_materialId_effectiveFrom_idx" ON "material_price_history"("materialId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_poNumber_key" ON "purchase_orders"("poNumber");

-- CreateIndex
CREATE INDEX "purchase_orders_status_expectedDate_idx" ON "purchase_orders"("status", "expectedDate");

-- CreateIndex
CREATE INDEX "purchase_order_lines_purchaseOrderId_idx" ON "purchase_order_lines"("purchaseOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_receiptNumber_key" ON "goods_receipts"("receiptNumber");

-- CreateIndex
CREATE INDEX "goods_receipts_receivedDate_idx" ON "goods_receipts"("receivedDate");

-- CreateIndex
CREATE INDEX "goods_receipt_lines_goodsReceiptId_idx" ON "goods_receipt_lines"("goodsReceiptId");

-- CreateIndex
CREATE UNIQUE INDEX "collections_code_key" ON "collections"("code");

-- CreateIndex
CREATE UNIQUE INDEX "styles_code_key" ON "styles"("code");

-- CreateIndex
CREATE INDEX "styles_collectionId_idx" ON "styles"("collectionId");

-- CreateIndex
CREATE UNIQUE INDEX "style_bom_lines_styleId_materialId_key" ON "style_bom_lines"("styleId", "materialId");

-- CreateIndex
CREATE UNIQUE INDEX "style_operations_styleId_sequence_key" ON "style_operations"("styleId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "variants_sku_key" ON "variants"("sku");

-- CreateIndex
CREATE INDEX "variants_sku_idx" ON "variants"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "variants_styleId_colorCodeId_sizeCodeId_key" ON "variants"("styleId", "colorCodeId", "sizeCodeId");

-- CreateIndex
CREATE INDEX "cost_snapshots_styleId_createdAt_idx" ON "cost_snapshots"("styleId", "createdAt");

-- CreateIndex
CREATE INDEX "cost_snapshot_lines_costSnapshotId_idx" ON "cost_snapshot_lines"("costSnapshotId");

-- CreateIndex
CREATE UNIQUE INDEX "production_orders_orderNumber_key" ON "production_orders"("orderNumber");

-- CreateIndex
CREATE INDEX "production_orders_status_orderDate_idx" ON "production_orders"("status", "orderDate");

-- CreateIndex
CREATE INDEX "production_orders_styleId_idx" ON "production_orders"("styleId");

-- CreateIndex
CREATE UNIQUE INDEX "production_order_lines_productionOrderId_variantId_key" ON "production_order_lines"("productionOrderId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "cutting_tickets_ticketNumber_key" ON "cutting_tickets"("ticketNumber");

-- CreateIndex
CREATE INDEX "cutting_tickets_productionOrderId_idx" ON "cutting_tickets"("productionOrderId");

-- CreateIndex
CREATE INDEX "material_issues_productionOrderId_idx" ON "material_issues"("productionOrderId");

-- CreateIndex
CREATE INDEX "material_issues_materialId_issueDate_idx" ON "material_issues"("materialId", "issueDate");

-- CreateIndex
CREATE INDEX "scrap_records_materialId_scrapDate_idx" ON "scrap_records"("materialId", "scrapDate");

-- CreateIndex
CREATE INDEX "scrap_records_productionOrderId_idx" ON "scrap_records"("productionOrderId");

-- CreateIndex
CREATE INDEX "production_stage_logs_productionOrderId_stage_idx" ON "production_stage_logs"("productionOrderId", "stage");

-- CreateIndex
CREATE INDEX "production_stage_logs_lineId_logDate_idx" ON "production_stage_logs"("lineId", "logDate");

-- CreateIndex
CREATE INDEX "operator_productivity_logDate_idx" ON "operator_productivity"("logDate");

-- CreateIndex
CREATE UNIQUE INDEX "operator_productivity_operatorId_logDate_key" ON "operator_productivity"("operatorId", "logDate");

-- CreateIndex
CREATE INDEX "qc_records_productionOrderId_idx" ON "qc_records"("productionOrderId");

-- CreateIndex
CREATE INDEX "rework_records_productionOrderId_idx" ON "rework_records"("productionOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_lots_lotNumber_key" ON "inventory_lots"("lotNumber");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_lots_goodsReceiptLineId_key" ON "inventory_lots"("goodsReceiptLineId");

-- CreateIndex
CREATE INDEX "inventory_lots_state_receivedDate_idx" ON "inventory_lots"("state", "receivedDate");

-- CreateIndex
CREATE INDEX "inventory_lots_materialId_idx" ON "inventory_lots"("materialId");

-- CreateIndex
CREATE INDEX "inventory_lots_variantId_idx" ON "inventory_lots"("variantId");

-- CreateIndex
CREATE INDEX "inventory_movements_lotId_idx" ON "inventory_movements"("lotId");

-- CreateIndex
CREATE INDEX "inventory_movements_movementDate_type_idx" ON "inventory_movements"("movementDate", "type");

-- CreateIndex
CREATE UNIQUE INDEX "sales_channels_code_key" ON "sales_channels"("code");

-- CreateIndex
CREATE UNIQUE INDEX "customers_code_key" ON "customers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_orderNumber_key" ON "sales_orders"("orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_shopifyOrderId_key" ON "sales_orders"("shopifyOrderId");

-- CreateIndex
CREATE INDEX "sales_orders_channelId_orderDate_idx" ON "sales_orders"("channelId", "orderDate");

-- CreateIndex
CREATE INDEX "sales_orders_status_idx" ON "sales_orders"("status");

-- CreateIndex
CREATE INDEX "sales_order_lines_salesOrderId_idx" ON "sales_order_lines"("salesOrderId");

-- CreateIndex
CREATE INDEX "sales_order_lines_variantId_idx" ON "sales_order_lines"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "returns_returnNumber_key" ON "returns"("returnNumber");

-- CreateIndex
CREATE INDEX "returns_salesOrderId_idx" ON "returns"("salesOrderId");

-- CreateIndex
CREATE INDEX "returns_returnDate_idx" ON "returns"("returnDate");

-- CreateIndex
CREATE UNIQUE INDEX "cmt_clients_code_key" ON "cmt_clients"("code");

-- CreateIndex
CREATE UNIQUE INDEX "cmt_quotes_quoteNumber_key" ON "cmt_quotes"("quoteNumber");

-- CreateIndex
CREATE INDEX "cmt_quotes_clientId_idx" ON "cmt_quotes"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "cmt_orders_orderNumber_key" ON "cmt_orders"("orderNumber");

-- CreateIndex
CREATE INDEX "cmt_orders_clientId_orderDate_idx" ON "cmt_orders"("clientId", "orderDate");

-- CreateIndex
CREATE INDEX "scheduled_cash_items_entityId_isActive_idx" ON "scheduled_cash_items"("entityId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "alert_rules_code_key" ON "alert_rules"("code");

-- CreateIndex
CREATE INDEX "alerts_status_severity_createdAt_idx" ON "alerts"("status", "severity", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "alerts_alertRuleId_dedupeKey_key" ON "alerts"("alertRuleId", "dedupeKey");

-- CreateIndex
CREATE INDEX "scenario_results_scenarioId_idx" ON "scenario_results"("scenarioId");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_categories" ADD CONSTRAINT "cost_categories_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_costCategoryId_fkey" FOREIGN KEY ("costCategoryId") REFERENCES "cost_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_fiscalPeriodId_fkey" FOREIGN KEY ("fiscalPeriodId") REFERENCES "fiscal_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_adjustsExpenseId_fkey" FOREIGN KEY ("adjustsExpenseId") REFERENCES "expenses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_payments" ADD CONSTRAINT "expense_payments_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operators" ADD CONSTRAINT "operators_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "production_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capacity_configs" ADD CONSTRAINT "capacity_configs_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capacity_configs" ADD CONSTRAINT "capacity_configs_fiscalPeriodId_fkey" FOREIGN KEY ("fiscalPeriodId") REFERENCES "fiscal_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capacity_configs" ADD CONSTRAINT "capacity_configs_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "production_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "minute_rate_periods" ADD CONSTRAINT "minute_rate_periods_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "minute_rate_periods" ADD CONSTRAINT "minute_rate_periods_fiscalPeriodId_fkey" FOREIGN KEY ("fiscalPeriodId") REFERENCES "fiscal_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "minute_rate_components" ADD CONSTRAINT "minute_rate_components_minuteRatePeriodId_fkey" FOREIGN KEY ("minuteRatePeriodId") REFERENCES "minute_rate_periods"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capacity_bookings" ADD CONSTRAINT "capacity_bookings_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "production_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capacity_bookings" ADD CONSTRAINT "capacity_bookings_cmtOrderId_fkey" FOREIGN KEY ("cmtOrderId") REFERENCES "cmt_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_scorecards" ADD CONSTRAINT "supplier_scorecards_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_scorecards" ADD CONSTRAINT "supplier_scorecards_fiscalPeriodId_fkey" FOREIGN KEY ("fiscalPeriodId") REFERENCES "fiscal_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "materials" ADD CONSTRAINT "materials_uomId_fkey" FOREIGN KEY ("uomId") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "materials" ADD CONSTRAINT "materials_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_price_history" ADD CONSTRAINT "material_price_history_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "materials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_goodsReceiptId_fkey" FOREIGN KEY ("goodsReceiptId") REFERENCES "goods_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_purchaseOrderLineId_fkey" FOREIGN KEY ("purchaseOrderLineId") REFERENCES "purchase_order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "styles" ADD CONSTRAINT "styles_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "style_bom_lines" ADD CONSTRAINT "style_bom_lines_styleId_fkey" FOREIGN KEY ("styleId") REFERENCES "styles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "style_bom_lines" ADD CONSTRAINT "style_bom_lines_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "style_operations" ADD CONSTRAINT "style_operations_styleId_fkey" FOREIGN KEY ("styleId") REFERENCES "styles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "style_operations" ADD CONSTRAINT "style_operations_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "production_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variants" ADD CONSTRAINT "variants_styleId_fkey" FOREIGN KEY ("styleId") REFERENCES "styles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variants" ADD CONSTRAINT "variants_colorCodeId_fkey" FOREIGN KEY ("colorCodeId") REFERENCES "color_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variants" ADD CONSTRAINT "variants_sizeCodeId_fkey" FOREIGN KEY ("sizeCodeId") REFERENCES "size_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_snapshots" ADD CONSTRAINT "cost_snapshots_styleId_fkey" FOREIGN KEY ("styleId") REFERENCES "styles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_snapshots" ADD CONSTRAINT "cost_snapshots_minuteRatePeriodId_fkey" FOREIGN KEY ("minuteRatePeriodId") REFERENCES "minute_rate_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_snapshot_lines" ADD CONSTRAINT "cost_snapshot_lines_costSnapshotId_fkey" FOREIGN KEY ("costSnapshotId") REFERENCES "cost_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_styleId_fkey" FOREIGN KEY ("styleId") REFERENCES "styles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_costSnapshotId_fkey" FOREIGN KEY ("costSnapshotId") REFERENCES "cost_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_minuteRatePeriodId_fkey" FOREIGN KEY ("minuteRatePeriodId") REFERENCES "minute_rate_periods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_order_lines" ADD CONSTRAINT "production_order_lines_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "production_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_order_lines" ADD CONSTRAINT "production_order_lines_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cutting_tickets" ADD CONSTRAINT "cutting_tickets_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "production_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_issues" ADD CONSTRAINT "material_issues_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "production_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_issues" ADD CONSTRAINT "material_issues_cuttingTicketId_fkey" FOREIGN KEY ("cuttingTicketId") REFERENCES "cutting_tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_issues" ADD CONSTRAINT "material_issues_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scrap_records" ADD CONSTRAINT "scrap_records_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "production_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scrap_records" ADD CONSTRAINT "scrap_records_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_stage_logs" ADD CONSTRAINT "production_stage_logs_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "production_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_stage_logs" ADD CONSTRAINT "production_stage_logs_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "production_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_productivity" ADD CONSTRAINT "operator_productivity_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_records" ADD CONSTRAINT "qc_records_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "production_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rework_records" ADD CONSTRAINT "rework_records_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "production_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rework_records" ADD CONSTRAINT "rework_records_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "production_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "materials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_goodsReceiptLineId_fkey" FOREIGN KEY ("goodsReceiptLineId") REFERENCES "goods_receipt_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "production_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "inventory_lots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "sales_channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "sales_channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cmt_quotes" ADD CONSTRAINT "cmt_quotes_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "cmt_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cmt_quotes" ADD CONSTRAINT "cmt_quotes_minuteRatePeriodId_fkey" FOREIGN KEY ("minuteRatePeriodId") REFERENCES "minute_rate_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cmt_orders" ADD CONSTRAINT "cmt_orders_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "cmt_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cmt_orders" ADD CONSTRAINT "cmt_orders_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "cmt_quotes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_cash_items" ADD CONSTRAINT "scheduled_cash_items_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_cash_items" ADD CONSTRAINT "scheduled_cash_items_costCategoryId_fkey" FOREIGN KEY ("costCategoryId") REFERENCES "cost_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_alertRuleId_fkey" FOREIGN KEY ("alertRuleId") REFERENCES "alert_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_acknowledgedByUserId_fkey" FOREIGN KEY ("acknowledgedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenario_results" ADD CONSTRAINT "scenario_results_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "scenarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
