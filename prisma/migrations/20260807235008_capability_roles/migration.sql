-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "UserRole" ADD VALUE 'BRAND_MANAGER';
ALTER TYPE "UserRole" ADD VALUE 'MODERATOR';
ALTER TYPE "UserRole" ADD VALUE 'POS_CASHIER';
ALTER TYPE "UserRole" ADD VALUE 'WAREHOUSE';
ALTER TYPE "UserRole" ADD VALUE 'HR';
ALTER TYPE "UserRole" ADD VALUE 'MARKETING';
ALTER TYPE "UserRole" ADD VALUE 'FINANCE_APPROVER';
ALTER TYPE "UserRole" ADD VALUE 'SERVICE_ACCOUNT';
