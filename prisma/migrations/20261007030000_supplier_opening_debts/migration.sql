CREATE TABLE "supplier_opening_balances" (
  "id" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "amount" DECIMAL(18,4) NOT NULL,
  "paidAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
  "asOfDate" DATE NOT NULL,
  "dueDate" DATE NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_opening_balances_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "supplier_opening_balances_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "supplier_opening_balances_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "supplier_opening_balances_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "supplier_opening_balances_paid_range" CHECK ("paidAmount" >= 0 AND "paidAmount" <= "amount")
);

CREATE UNIQUE INDEX "supplier_opening_balances_supplierId_entityId_key"
  ON "supplier_opening_balances"("supplierId", "entityId");

CREATE TABLE "supplier_opening_payments" (
  "id" TEXT NOT NULL,
  "openingBalanceId" TEXT NOT NULL,
  "amount" DECIMAL(18,4) NOT NULL,
  "method" "PaymentMethod" NOT NULL,
  "paidDate" DATE NOT NULL,
  "reference" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_opening_payments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "supplier_opening_payments_openingBalanceId_fkey" FOREIGN KEY ("openingBalanceId") REFERENCES "supplier_opening_balances"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "supplier_opening_payments_amount_positive" CHECK ("amount" > 0)
);

CREATE INDEX "supplier_opening_payments_openingBalanceId_idx"
  ON "supplier_opening_payments"("openingBalanceId");
