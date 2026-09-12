-- Payroll pays people the way they are actually paid.
--
-- Everyone was run through the monthly calculation, whatever their pay
-- frequency said, and piece workers had nothing to be paid from: standard
-- minutes measure a day, they do not count garments.

ALTER TABLE "employees" ADD COLUMN "pieceRate" DECIMAL(18,4);
ALTER TABLE "operator_productivity" ADD COLUMN "piecesProduced" INTEGER;
