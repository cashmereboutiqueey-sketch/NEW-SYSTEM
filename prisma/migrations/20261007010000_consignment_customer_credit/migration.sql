ALTER TABLE "consignment_sales"
  ADD COLUMN "paidAtSale" DECIMAL(18,4),
  ADD COLUMN "dueDate" DATE;

CREATE TABLE "consignment_collections" (
  "id" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "amount" DECIMAL(18,4) NOT NULL,
  "method" "PaymentMethod" NOT NULL,
  "collectedOn" DATE NOT NULL,
  "reference" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "consignment_collections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "consignment_collections_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "consignment_sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "consignment_collections_amount_positive" CHECK ("amount" > 0)
);

CREATE INDEX "consignment_collections_saleId_idx" ON "consignment_collections"("saleId");
