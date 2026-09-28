-- Apply the new limit only to customers created from now on.
-- Existing customer limits, including individually adjusted ones, stay intact.
ALTER TABLE "customers" ALTER COLUMN "creditLimit" SET DEFAULT 20000;
