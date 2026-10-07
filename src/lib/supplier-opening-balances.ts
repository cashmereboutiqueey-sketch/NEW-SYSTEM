import "server-only";
import { db } from "./db";
import { command } from "./command";
import { postEntry } from "./ledger";
import { writeAudit, type AuditContext } from "./audit";
import { dec, roundMoney } from "./money";

export class SupplierOpeningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupplierOpeningError";
  }
}

function money(value: string) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) {
    throw new SupplierOpeningError("Enter a valid amount to the piastre.");
  }
  const amount = roundMoney(dec(value));
  if (amount.lessThanOrEqualTo(0)) throw new SupplierOpeningError("Amount must be greater than zero.");
  return amount;
}

function date(value: Date) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new SupplierOpeningError("Enter a valid date.");
  }
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

/** Carry an existing supplier debt into the ledger, without stock or an expense. */
export async function createSupplierOpeningBalance(
  input: { supplierId: string; entityId: string; amount: string;
    asOfDate: Date; dueDate: Date; note?: string | null },
  ctx: AuditContext,
): Promise<{ id: string; amount: string }> {
  return command("supplierOpening.create", input, ctx, async () => {
    const amount = money(input.amount);
    const asOfDate = date(input.asOfDate);
    const dueDate = date(input.dueDate);
    const [supplier, entity, existing] = await Promise.all([
      db.supplier.findUnique({ where: { id: input.supplierId } }),
      db.entity.findUnique({ where: { id: input.entityId } }),
      db.supplierOpeningBalance.findUnique({
        where: { supplierId_entityId: { supplierId: input.supplierId, entityId: input.entityId } },
      }),
    ]);
    if (!supplier) throw new SupplierOpeningError("Supplier not found.");
    if (!entity) throw new SupplierOpeningError("Company not found.");
    if (existing) {
      throw new SupplierOpeningError(
        `${supplier.nameEn} already has an opening balance in ${entity.nameEn}.`,
      );
    }
    return db.$transaction(async (tx) => {
      const [opening, payable] = await Promise.all([
        tx.account.findUniqueOrThrow({ where: { code: "3400" }, select: { id: true } }),
        tx.account.findUniqueOrThrow({ where: { code: "2110" }, select: { id: true } }),
      ]);
      const row = await tx.supplierOpeningBalance.create({
        data: { supplierId: supplier.id, entityId: entity.id, amount: amount.toString(),
          asOfDate, dueDate, note: input.note?.trim() || null },
      });
      await postEntry(tx, {
        entityId: entity.id,
        postingDate: asOfDate,
        sourceType: "OPENING_BALANCE",
        sourceId: row.id,
        memo: `Opening amount owed to ${supplier.nameEn}`,
        ctx,
        lines: [
          { accountId: opening.id, debit: amount, entityId: entity.id,
            supplierId: supplier.id, description: "Opening supplier debt" },
          { accountId: payable.id, credit: amount, entityId: entity.id,
            supplierId: supplier.id, description: "Opening supplier debt" },
        ],
      });
      await writeAudit(tx, {
        action: "SUPPLIER_OPENING_BALANCE_CREATED",
        entityName: "SupplierOpeningBalance", entityId: row.id,
        after: { supplier: supplier.code, entity: entity.kind, amount: amount.toString(),
          asOfDate: asOfDate.toISOString(), dueDate: dueDate.toISOString() },
        ctx,
      });
      return { id: row.id, amount: amount.toString() };
    });
  });
}

/** Pay an opening debt in part or full; the remaining amount stays on the supplier. */
export async function paySupplierOpeningBalance(
  input: { openingBalanceId: string; amount: string; paidDate: Date;
    method: "CASH" | "CARD" | "BANK_TRANSFER" | "INSTAPAY";
    reference?: string | null },
  ctx: AuditContext,
): Promise<{ outstanding: string }> {
  return command("supplierOpening.pay", input, ctx, async () => {
    const payment = money(input.amount);
    const paidDate = date(input.paidDate);
    if (!["CASH", "CARD", "BANK_TRANSFER", "INSTAPAY"].includes(input.method)) {
      throw new SupplierOpeningError("Choose cash, card, bank transfer, or InstaPay.");
    }
    return db.$transaction(async (tx) => {
      const opening = await tx.supplierOpeningBalance.findUnique({
        where: { id: input.openingBalanceId }, include: { supplier: true },
      });
      if (!opening) throw new SupplierOpeningError("Opening balance not found.");
      const outstanding = dec(opening.amount).minus(dec(opening.paidAmount));
      if (payment.greaterThan(outstanding)) {
        throw new SupplierOpeningError(`Only ${outstanding.toFixed(2)} is still owed.`);
      }
      const claimed = await tx.$executeRaw`
        UPDATE "supplier_opening_balances"
        SET "paidAmount" = "paidAmount" + ${payment.toString()}
        WHERE "id" = ${opening.id}
          AND "amount" - "paidAmount" >= ${payment.toString()}::numeric
      `;
      if (claimed !== 1) throw new SupplierOpeningError("That balance changed; reload and try again.");
      const [payable, funds] = await Promise.all([
        tx.account.findUniqueOrThrow({ where: { code: "2110" }, select: { id: true } }),
        tx.account.findUniqueOrThrow({
          where: { code: input.method === "CASH" ? "1110" : "1120" }, select: { id: true },
        }),
      ]);
      const row = await tx.supplierOpeningPayment.create({
        data: { openingBalanceId: opening.id, amount: payment.toString(),
          method: input.method, paidDate, reference: input.reference?.trim() || null },
      });
      await postEntry(tx, {
        entityId: opening.entityId, postingDate: paidDate,
        sourceType: "PAYMENT", sourceId: row.id,
        memo: `Opening balance payment to ${opening.supplier.nameEn}`, ctx,
        lines: [
          { accountId: payable.id, debit: payment, entityId: opening.entityId,
            supplierId: opening.supplierId, description: "Opening balance payment" },
          { accountId: funds.id, credit: payment, entityId: opening.entityId,
            supplierId: opening.supplierId, description: input.reference || "Opening balance payment" },
        ],
      });
      const stillOwed = outstanding.minus(payment);
      await writeAudit(tx, {
        action: "SUPPLIER_OPENING_BALANCE_PAID",
        entityName: "SupplierOpeningBalance", entityId: opening.id,
        after: { amount: payment.toString(), method: input.method,
          stillOwed: stillOwed.toString() }, ctx,
      });
      return { outstanding: stillOwed.toString() };
    });
  });
}
