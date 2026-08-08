-- CreateEnum
CREATE TYPE "EmploymentStatus" AS ENUM ('ACTIVE', 'ON_LEAVE', 'TERMINATED');

-- CreateEnum
CREATE TYPE "PayFrequency" AS ENUM ('MONTHLY', 'WEEKLY', 'DAILY', 'PIECE_RATE');

-- CreateEnum
CREATE TYPE "AttendanceSource" AS ENUM ('BIOMETRIC', 'MANUAL', 'IMPORTED');

-- CreateEnum
CREATE TYPE "PayrollRunStatus" AS ENUM ('DRAFT', 'APPROVED', 'POSTED');

-- AlterTable
ALTER TABLE "operators" ADD COLUMN     "employeeId" TEXT;

-- CreateTable
CREATE TABLE "employees" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "costCenterId" TEXT,
    "department" TEXT,
    "jobTitle" TEXT,
    "status" "EmploymentStatus" NOT NULL DEFAULT 'ACTIVE',
    "hiredAt" DATE NOT NULL,
    "endedAt" DATE,
    "payFrequency" "PayFrequency" NOT NULL DEFAULT 'MONTHLY',
    "baseSalary" DECIMAL(18,4) NOT NULL,
    "phone" TEXT,
    "nationalId" TEXT,
    "biometricDeviceUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_history" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "baseSalary" DECIMAL(18,4) NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salary_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "biometric_punches" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT,
    "deviceUserId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "punchedAt" TIMESTAMP(3) NOT NULL,
    "rawPayload" JSONB,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "biometric_punches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_days" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "workDate" DATE NOT NULL,
    "firstIn" TIMESTAMP(3),
    "lastOut" TIMESTAMP(3),
    "workedMinutes" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "overtimeMinutes" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "isAbsent" BOOLEAN NOT NULL DEFAULT false,
    "isLeave" BOOLEAN NOT NULL DEFAULT false,
    "leaveType" TEXT,
    "source" "AttendanceSource" NOT NULL DEFAULT 'BIOMETRIC',
    "adjustmentReason" TEXT,
    "approvedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" TEXT NOT NULL,
    "runNumber" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fiscalPeriodId" TEXT NOT NULL,
    "status" "PayrollRunStatus" NOT NULL DEFAULT 'DRAFT',
    "grossPay" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "deductions" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "netPay" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "employerCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "preparedByUserId" TEXT,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "postedAt" TIMESTAMP(3),
    "journalEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_lines" (
    "id" TEXT NOT NULL,
    "payrollRunId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "baseSalary" DECIMAL(18,4) NOT NULL,
    "overtimePay" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "absenceDeduction" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "otherDeductions" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "grossPay" DECIMAL(18,4) NOT NULL,
    "netPay" DECIMAL(18,4) NOT NULL,
    "employerCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "workedMinutes" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "overtimeMinutes" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "absentDays" INTEGER NOT NULL DEFAULT 0,
    "accountId" TEXT,

    CONSTRAINT "payroll_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "employees_code_key" ON "employees"("code");

-- CreateIndex
CREATE INDEX "employees_entityId_status_idx" ON "employees"("entityId", "status");

-- CreateIndex
CREATE INDEX "employees_biometricDeviceUserId_idx" ON "employees"("biometricDeviceUserId");

-- CreateIndex
CREATE INDEX "salary_history_employeeId_effectiveFrom_idx" ON "salary_history"("employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "biometric_punches_employeeId_punchedAt_idx" ON "biometric_punches"("employeeId", "punchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "biometric_punches_deviceId_deviceUserId_punchedAt_key" ON "biometric_punches"("deviceId", "deviceUserId", "punchedAt");

-- CreateIndex
CREATE INDEX "attendance_days_workDate_idx" ON "attendance_days"("workDate");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_days_employeeId_workDate_key" ON "attendance_days"("employeeId", "workDate");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_runNumber_key" ON "payroll_runs"("runNumber");

-- CreateIndex
CREATE INDEX "payroll_runs_status_idx" ON "payroll_runs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_entityId_fiscalPeriodId_key" ON "payroll_runs"("entityId", "fiscalPeriodId");

-- CreateIndex
CREATE INDEX "payroll_lines_employeeId_idx" ON "payroll_lines"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_lines_payrollRunId_employeeId_key" ON "payroll_lines"("payrollRunId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "operators_employeeId_key" ON "operators"("employeeId");

-- AddForeignKey
ALTER TABLE "operators" ADD CONSTRAINT "operators_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_costCenterId_fkey" FOREIGN KEY ("costCenterId") REFERENCES "cost_centers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_history" ADD CONSTRAINT "salary_history_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_punches" ADD CONSTRAINT "biometric_punches_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_days" ADD CONSTRAINT "attendance_days_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_fiscalPeriodId_fkey" FOREIGN KEY ("fiscalPeriodId") REFERENCES "fiscal_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

