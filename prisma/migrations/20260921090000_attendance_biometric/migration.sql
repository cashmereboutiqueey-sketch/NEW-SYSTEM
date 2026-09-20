-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'LATE', 'EARLY_LEAVE', 'INCOMPLETE', 'ABSENT', 'LEAVE', 'OFF', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "AttendanceImportStatus" AS ENUM ('PREVIEWED', 'COMMITTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AttendanceAdjustmentKind" AS ENUM ('CORRECTION', 'OVERTIME_APPROVAL', 'OVERTIME_REJECTION', 'LEAVE', 'ABSENCE', 'REVIEW', 'POST_LOCK');

-- CreateEnum
CREATE TYPE "AttendancePeriodStatus" AS ENUM ('OPEN', 'REVIEWED', 'LOCKED');

-- AlterTable
ALTER TABLE "attendance_days" ADD COLUMN     "breakMinutes" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "earlyLeaveMinutes" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "lateMinutes" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "lockedAt" TIMESTAMP(3),
ADD COLUMN     "overtimeApprovedAt" TIMESTAMP(3),
ADD COLUMN     "overtimeApprovedByUserId" TEXT,
ADD COLUMN     "overtimeCandidateMinutes" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedByUserId" TEXT,
ADD COLUMN     "scheduledMinutes" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "shiftId" TEXT,
ADD COLUMN     "status" "AttendanceStatus" NOT NULL DEFAULT 'NEEDS_REVIEW';

-- CreateTable
CREATE TABLE "shifts" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "crossesMidnight" BOOLEAN NOT NULL DEFAULT false,
    "workingDays" INTEGER[],
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,
    "breakPaid" BOOLEAN NOT NULL DEFAULT false,
    "graceMinutes" INTEGER NOT NULL DEFAULT 0,
    "overtimeAfterMinutes" INTEGER NOT NULL DEFAULT 480,
    "department" TEXT,
    "lineId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_shifts" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_imports" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mapping" JSONB NOT NULL,
    "fileHash" TEXT NOT NULL,
    "status" "AttendanceImportStatus" NOT NULL DEFAULT 'PREVIEWED',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "importedRows" INTEGER NOT NULL DEFAULT 0,
    "duplicateRows" INTEGER NOT NULL DEFAULT 0,
    "unknownBadges" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "rangeFrom" TIMESTAMP(3),
    "rangeTo" TIMESTAMP(3),
    "importedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMP(3),

    CONSTRAINT "attendance_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_import_rows" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "attendance_import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_adjustments" (
    "id" TEXT NOT NULL,
    "dayId" TEXT NOT NULL,
    "kind" "AttendanceAdjustmentKind" NOT NULL,
    "reason" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "requestedByUserId" TEXT,
    "approvedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_periods" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" "AttendancePeriodStatus" NOT NULL DEFAULT 'OPEN',
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "lockedByUserId" TEXT,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_periods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shifts_code_key" ON "shifts"("code");

-- CreateIndex
CREATE INDEX "employee_shifts_employeeId_effectiveFrom_idx" ON "employee_shifts"("employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "attendance_imports_createdAt_idx" ON "attendance_imports"("createdAt");

-- CreateIndex
CREATE INDEX "attendance_import_rows_importId_idx" ON "attendance_import_rows"("importId");

-- CreateIndex
CREATE INDEX "attendance_adjustments_dayId_createdAt_idx" ON "attendance_adjustments"("dayId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_periods_entityId_year_month_key" ON "attendance_periods"("entityId", "year", "month");

-- CreateIndex
CREATE INDEX "attendance_days_status_workDate_idx" ON "attendance_days"("status", "workDate");

-- AddForeignKey
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "production_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_shifts" ADD CONSTRAINT "employee_shifts_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_shifts" ADD CONSTRAINT "employee_shifts_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_imports" ADD CONSTRAINT "attendance_imports_importedByUserId_fkey" FOREIGN KEY ("importedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_import_rows" ADD CONSTRAINT "attendance_import_rows_importId_fkey" FOREIGN KEY ("importId") REFERENCES "attendance_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_adjustments" ADD CONSTRAINT "attendance_adjustments_dayId_fkey" FOREIGN KEY ("dayId") REFERENCES "attendance_days"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_adjustments" ADD CONSTRAINT "attendance_adjustments_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_adjustments" ADD CONSTRAINT "attendance_adjustments_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_periods" ADD CONSTRAINT "attendance_periods_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Days that already existed were derived before there was a status to give
-- them. Leaving every one of them as NEEDS_REVIEW would put months of settled
-- attendance into the exception queue on the morning this ships, so they are
-- given the status their own recorded facts already imply. Anything less
-- certain than these keeps the default and is looked at by a person.
UPDATE "attendance_days" SET "status" = 'LEAVE'  WHERE "isLeave"  = true;
UPDATE "attendance_days" SET "status" = 'ABSENT' WHERE "isAbsent" = true;
UPDATE "attendance_days"
   SET "status" = 'PRESENT'
 WHERE "isLeave" = false AND "isAbsent" = false
   AND "firstIn" IS NOT NULL AND "lastOut" IS NOT NULL;
UPDATE "attendance_days"
   SET "status" = 'INCOMPLETE'
 WHERE "isLeave" = false AND "isAbsent" = false
   AND "firstIn" IS NOT NULL AND "lastOut" IS NULL;
