-- How money comes in, and how it goes out.
--
-- InstaPay is how a great many Egyptian customers pay, and the system had no
-- way to record it: a cashier had to pick "bank transfer" and lose the
-- distinction that makes a bank statement reconcilable.
--
-- WALLET stays in the enum and is offered nowhere. Postgres cannot drop an
-- enum value without recreating the type, and the gain from doing so is
-- nothing — no row uses it, and the application no longer accepts it.
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'INSTAPAY';

-- Money leaving the business.
--
-- `method` was a free string, so nothing stopped a typo from becoming a
-- category nobody could report on. InstaPay, a card and a manual transfer all
-- leave the same bank account, but which one was used is exactly what makes a
-- statement reconcilable line by line.
CREATE TYPE "PayoutMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'INSTAPAY', 'CARD');

-- Existing rows carry 'BANK' or 'CASH' from the old two-value vocabulary.
ALTER TABLE "expense_payments"
  ALTER COLUMN "method" TYPE "PayoutMethod"
  USING (
    CASE upper(coalesce("method", 'BANK'))
      WHEN 'CASH' THEN 'CASH'
      ELSE 'BANK_TRANSFER'
    END
  )::"PayoutMethod";

ALTER TABLE "expense_payments"
  ALTER COLUMN "method" SET DEFAULT 'BANK_TRANSFER',
  ALTER COLUMN "method" SET NOT NULL;
