-- What a delivery leaves owing to the supplier.
--
-- Receiving goods has always credited accounts payable, but the only open
-- items anyone could age or pay were expenses. A delivery's debt sat on the
-- ledger and on no list of what to pay, and settling it meant raising an
-- expense for it — which recognised the same debt a second time.
--
-- Each receipt now carries its own payable, paid against it directly.
ALTER TABLE "goods_receipts"
  ADD COLUMN "entityId" TEXT,
  ADD COLUMN "payableAmount" DECIMAL(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN "paidAmount" DECIMAL(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN "dueDate" DATE;

CREATE TABLE "goods_receipt_payments" (
  "id" TEXT PRIMARY KEY,
  "goodsReceiptId" TEXT NOT NULL,
  "amount" DECIMAL(18, 4) NOT NULL,
  "paidDate" DATE NOT NULL,
  "method" "PayoutMethod" NOT NULL DEFAULT 'BANK_TRANSFER',
  "reference" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "goods_receipt_payments_goodsReceiptId_fkey"
    FOREIGN KEY ("goodsReceiptId") REFERENCES "goods_receipts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "goods_receipt_payments_goodsReceiptId_idx" ON "goods_receipt_payments"("goodsReceiptId");
CREATE INDEX "goods_receipt_payments_paidDate_idx" ON "goods_receipt_payments"("paidDate");

-- Paid never exceeds what is owed, and neither goes negative.
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipt_paid_within_payable"
  CHECK ("payableAmount" >= 0 AND "paidAmount" >= 0 AND "paidAmount" <= "payableAmount");

-- Receipts made before this: what each one credited to payables, which is
-- accepted quantity at landed cost, line by line.
UPDATE "goods_receipts" gr
SET "payableAmount" = COALESCE((
  SELECT SUM(l."acceptedQty" * l."actualEffectiveCost")
  FROM "goods_receipt_lines" l
  WHERE l."goodsReceiptId" = gr."id"
), 0);

-- Due on the supplier's terms from the day the goods arrived.
UPDATE "goods_receipts" gr
SET "dueDate" = gr."receivedDate" + s."creditDays"
FROM "purchase_orders" po
JOIN "suppliers" s ON s."id" = po."supplierId"
WHERE po."id" = gr."purchaseOrderId";

-- The entity whose books took the stock, read from the lots the receipt made.
UPDATE "goods_receipts" gr
SET "entityId" = sub."entityId"
FROM (
  SELECT DISTINCT ON (m."referenceId") m."referenceId", lot."entityId"
  FROM "inventory_movements" m
  JOIN "inventory_lots" lot ON lot."id" = m."lotId"
  WHERE m."referenceType" = 'GOODS_RECEIPT'
  ORDER BY m."referenceId", m."movementDate"
) sub
WHERE sub."referenceId" = gr."receiptNumber";
