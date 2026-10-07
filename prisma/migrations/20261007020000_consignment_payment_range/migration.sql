ALTER TABLE "consignment_sales"
  ADD CONSTRAINT "consignment_sales_paidAtSale_range"
  CHECK ("paidAtSale" IS NULL OR ("paidAtSale" >= 0 AND "paidAtSale" <= "soldPrice" * "quantity"));
