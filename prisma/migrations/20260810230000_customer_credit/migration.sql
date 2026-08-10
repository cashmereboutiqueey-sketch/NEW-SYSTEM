-- Letting a customer pay part now and the rest later.
--
-- The limit lives on the customer rather than in a setting: how much somebody
-- may owe is a judgement about a person, not a blanket policy. Zero is the
-- default, so nobody gets credit until a human decides they should.
ALTER TABLE "customers"
  ADD COLUMN "creditLimit" DECIMAL(18,4) NOT NULL DEFAULT 0;

ALTER TABLE "customers"
  ADD CONSTRAINT "customers_credit_limit_not_negative"
  CHECK ("creditLimit" >= 0);

-- When the unpaid balance falls due. Null when nothing is owed, so an aging
-- report can tell "late" from "not yet due" instead of treating all debt the
-- same.
ALTER TABLE "sales_orders" ADD COLUMN "dueDate" DATE;

-- Aging reads unpaid orders by when they fell due.
CREATE INDEX "sales_orders_dueDate_idx" ON "sales_orders"("dueDate");
