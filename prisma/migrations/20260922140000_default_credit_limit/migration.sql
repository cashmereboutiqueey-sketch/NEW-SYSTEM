-- The default credit limit for a customer, by instruction: fifty thousand.
--
-- Both places that create a customer leave the column to its default unless a
-- figure is given, so this is what a new customer gets from here on — whether
-- added on the customers screen, at the counter, or imported from Shopify.
ALTER TABLE "customers" ALTER COLUMN "creditLimit" SET DEFAULT 50000;

-- Customers already on the books.
--
-- Only those sitting at zero, which is what the old default left behind and
-- means "nobody has decided about this person". A limit somebody actually
-- typed is a decision about somebody they know — often a lower one, and often
-- for a reason — and raising it here would erase that reason without saying
-- so. Those are left exactly as they are and reported instead.
UPDATE "customers" SET "creditLimit" = 50000 WHERE "creditLimit" = 0;
