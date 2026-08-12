import "server-only";
import { db } from "./db";
import { postEntry, nextDocumentNumber } from "./ledger";
import { dec, roundMoney, type Decimal } from "./money";
import { writeAudit, type AuditContext } from "./audit";

/**
 * Selling somebody else's goods for a share of the price.
 *
 * The one thing this module exists to get right is what a consignment sale is
 * *not*. It is not a sale of the shop's stock, and the money is not the
 * shop's takings.
 *
 * A garment on consignment belongs to whoever brought it in, right up to the
 * moment a customer walks out with it. So it is never an InventoryLot: every
 * stock valuation, GMROI figure and dead-stock report reads that table
 * without asking whose goods they are, and one query that forgot to filter
 * would overstate what the business owns.
 *
 * And when it sells, only the commission is revenue:
 *
 *   DR cash                (the whole price)
 *   CR commission (4160)   (the shop's share)
 *   CR owed to owner (2500) (the rest — a debt from the moment of sale)
 *
 * Selling a 2,000 coat on twenty-five per cent earns 500. Booking the 2,000
 * as revenue would inflate turnover with money that was never the shop's, and
 * make every margin, break-even and channel figure resting on it meaningless.
 *
 * There is no cost of sales, because nothing the shop owned left the building.
 */

export class ConsignmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsignmentError";
  }
}

const ACC = {
  POS_DRAWER: "1115",
  BANK: "1120",
  GATEWAY_CLEARING: "1130",
  COD_CLEARING: "1135",
  OWED_TO_CONSIGNORS: "2500",
  COMMISSION: "4160",
} as const;

/** Where the customer's money lands, exactly as an ordinary sale would. */
const FUNDS_ACCOUNT: Record<string, string> = {
  CASH: ACC.POS_DRAWER,
  CARD: ACC.BANK,
  BANK_TRANSFER: ACC.BANK,
  INSTAPAY: ACC.BANK,
  COD: ACC.COD_CLEARING,
};

function asDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ------------------------------------------------------------- consignors

export async function createConsignor(
  input: {
    code: string;
    name: string;
    commissionRate: string;
    settlementDays?: number;
    contactPerson?: string | null;
    phone?: string | null;
    email?: string | null;
    notes?: string | null;
  },
  ctx: AuditContext,
): Promise<{ id: string; code: string }> {
  const code = input.code.trim().toUpperCase();
  if (!code) throw new ConsignmentError("A consignor needs a code.");
  if (!input.name.trim()) throw new ConsignmentError("A consignor needs a name.");

  const rate = dec(input.commissionRate);
  // Percentages are fractions everywhere in this system. A 25 here would pay
  // the shop twenty-five times the sale price.
  if (rate.lessThan(0) || rate.greaterThan(1)) {
    throw new ConsignmentError(
      `A commission of ${rate.toString()} is not a fraction. Twenty-five per cent is 0.25.`,
    );
  }

  const clash = await db.consignor.findUnique({ where: { code } });
  if (clash) throw new ConsignmentError(`${code} is already ${clash.name}.`);

  return db.$transaction(async (tx) => {
    const consignor = await tx.consignor.create({
      data: {
        code,
        name: input.name.trim(),
        commissionRate: rate.toString(),
        settlementDays: input.settlementDays ?? 0,
        contactPerson: input.contactPerson ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        notes: input.notes ?? null,
      },
    });

    await writeAudit(tx, {
      action: "CONSIGNOR_CREATED",
      entityName: "Consignor",
      entityId: consignor.id,
      after: { code, name: consignor.name, commissionRate: rate.toString() },
      ctx,
    });

    return { id: consignor.id, code };
  });
}

// ------------------------------------------------------------------ goods

export async function receiveConsignment(
  input: {
    consignorId: string;
    description: string;
    quantity: number;
    retailPrice: string;
    /** Overrides the consignor's usual rate for this piece. */
    commissionRate?: string | null;
    size?: string | null;
    colour?: string | null;
    locationId: string;
    receivedDate: Date;
    expiresAt?: Date | null;
    notes?: string | null;
  },
  ctx: AuditContext,
): Promise<{ id: string; itemCode: string }> {
  if (input.quantity <= 0) throw new ConsignmentError("How many garments arrived?");
  if (!input.description.trim()) throw new ConsignmentError("Say what the garment is.");

  const price = roundMoney(dec(input.retailPrice));
  if (price.lessThanOrEqualTo(0)) throw new ConsignmentError("The garment needs a price.");

  const consignor = await db.consignor.findUnique({ where: { id: input.consignorId } });
  if (!consignor) throw new ConsignmentError("Consignor not found.");
  if (!consignor.isActive) throw new ConsignmentError(`${consignor.name} is no longer active.`);

  if (input.commissionRate != null && input.commissionRate !== "") {
    const rate = dec(input.commissionRate);
    if (rate.lessThan(0) || rate.greaterThan(1)) {
      throw new ConsignmentError("A commission has to be a fraction — 0.25 for a quarter.");
    }
  }

  const receivedDate = asDay(input.receivedDate);
  if (input.expiresAt && asDay(input.expiresAt) < receivedDate) {
    throw new ConsignmentError("The return-by date is before the goods arrived.");
  }

  return db.$transaction(async (tx) => {
    const itemCode = await nextDocumentNumber(tx, "CNS", receivedDate);

    const item = await tx.consignmentItem.create({
      data: {
        itemCode,
        consignorId: input.consignorId,
        description: input.description.trim(),
        size: input.size?.trim() || null,
        colour: input.colour?.trim() || null,
        retailPrice: price.toString(),
        commissionRate:
          input.commissionRate != null && input.commissionRate !== ""
            ? dec(input.commissionRate).toString()
            : null,
        quantityReceived: input.quantity,
        locationId: input.locationId,
        receivedDate,
        expiresAt: input.expiresAt ? asDay(input.expiresAt) : null,
        notes: input.notes ?? null,
      },
    });

    // Deliberately no journal. Nothing was bought and nothing became an asset
    // of this business: the garments are somebody else's, sitting on a rail.
    await writeAudit(tx, {
      action: "CONSIGNMENT_RECEIVED",
      entityName: "ConsignmentItem",
      entityId: item.id,
      after: {
        itemCode,
        consignor: consignor.name,
        description: item.description,
        quantity: input.quantity,
        retailPrice: price.toString(),
      },
      ctx,
    });

    return { id: item.id, itemCode };
  });
}

/** The rate this particular piece sells on. */
function rateFor(item: { commissionRate: Decimal | null }, consignor: { commissionRate: Decimal }): Decimal {
  return item.commissionRate != null ? dec(item.commissionRate) : dec(consignor.commissionRate);
}

// ------------------------------------------------------------------ sales

export async function sellConsignedItem(
  input: {
    itemId: string;
    quantity: number;
    /** What the customer actually paid, which may be under the ticket. */
    soldPrice?: string | null;
    paymentMethod: "CASH" | "CARD" | "BANK_TRANSFER" | "INSTAPAY" | "COD";
    customerId?: string | null;
    posSessionId?: string | null;
    saleDate: Date;
  },
  ctx: AuditContext,
): Promise<{
  saleNumber: string;
  commission: string;
  owedToOwner: string;
  total: string;
}> {
  if (input.quantity <= 0) throw new ConsignmentError("Sell at least one.");

  const item = await db.consignmentItem.findUnique({
    where: { id: input.itemId },
    include: { consignor: true, location: true },
  });
  if (!item) throw new ConsignmentError("That item is not here.");

  const available = item.quantityReceived - item.quantitySold - item.quantityReturned;
  if (input.quantity > available) {
    throw new ConsignmentError(
      available <= 0
        ? `${item.description} has none left.`
        : `Only ${available} of ${item.description} left.`,
    );
  }

  const unitPrice =
    input.soldPrice != null && input.soldPrice !== ""
      ? roundMoney(dec(input.soldPrice))
      : dec(item.retailPrice);
  if (unitPrice.lessThan(0)) throw new ConsignmentError("A price cannot be negative.");

  const rate = rateFor(item, item.consignor);
  const total = roundMoney(unitPrice.times(input.quantity));
  // Rounded to the piastre, and the owner gets the remainder. The split has
  // to add up exactly or the shop is holding money neither side accounts for
  // — the database refuses the row otherwise.
  const commission = roundMoney(total.times(rate));
  const owner = total.minus(commission);

  const entity = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });

  if (input.posSessionId) {
    const session = await db.posSession.findUnique({ where: { id: input.posSessionId } });
    if (!session) throw new ConsignmentError("Till session not found.");
    if (session.closedAt) throw new ConsignmentError("That till session is already closed.");
  }

  const saleDate = asDay(input.saleDate);
  const fundsCode = FUNDS_ACCOUNT[input.paymentMethod];
  if (!fundsCode) throw new ConsignmentError(`Cannot take ${input.paymentMethod} here.`);

  return db.$transaction(async (tx) => {
    const saleNumber = await nextDocumentNumber(tx, "CSL", saleDate);

    const accountId = async (code: string) => {
      const a = await tx.account.findUnique({ where: { code }, select: { id: true } });
      if (!a) throw new ConsignmentError(`Account ${code} is missing from the chart.`);
      return a.id;
    };

    const entry = await postEntry(tx, {
      entityId: entity.id,
      postingDate: saleDate,
      sourceType: "SALES_ORDER",
      sourceId: item.id,
      memo: `Consignment sale ${saleNumber} — ${item.description} (${item.consignor.name})`,
      ctx,
      lines: [
        {
          accountId: await accountId(fundsCode),
          debit: total,
          entityId: entity.id,
          customerId: input.customerId ?? null,
          description: `Taken for ${saleNumber}`,
        },
        {
          // The only part that is income.
          accountId: await accountId(ACC.COMMISSION),
          credit: commission,
          entityId: entity.id,
          description: `Commission at ${rate.times(100).toFixed(2)}% on ${saleNumber}`,
        },
        {
          // Owed from the moment the garment leaves, not when it is remitted.
          accountId: await accountId(ACC.OWED_TO_CONSIGNORS),
          credit: owner,
          entityId: entity.id,
          description: `Owed to ${item.consignor.name} for ${saleNumber}`,
        },
      ],
    });

    const sale = await tx.consignmentSale.create({
      data: {
        saleNumber,
        itemId: item.id,
        quantity: input.quantity,
        soldPrice: unitPrice.toString(),
        // Frozen: changing the consignor's rate later must not rewrite what
        // was owed on a sale that already happened.
        commissionRate: rate.toString(),
        commissionAmount: commission.toString(),
        ownerAmount: owner.toString(),
        customerId: input.customerId ?? null,
        entityId: entity.id,
        locationId: item.locationId,
        posSessionId: input.posSessionId ?? null,
        paymentMethod: input.paymentMethod,
        saleDate,
        soldByUserId: ctx.userId,
      },
    });

    await tx.consignmentItem.update({
      where: { id: item.id },
      data: { quantitySold: { increment: input.quantity } },
    });

    await writeAudit(tx, {
      action: "CONSIGNMENT_SOLD",
      entityName: "ConsignmentSale",
      entityId: sale.id,
      after: {
        saleNumber,
        item: item.description,
        consignor: item.consignor.name,
        quantity: input.quantity,
        total: total.toString(),
        commission: commission.toString(),
        owedToOwner: owner.toString(),
        journal: entry.id,
      },
      ctx,
    });

    return {
      saleNumber,
      commission: commission.toString(),
      owedToOwner: owner.toString(),
      total: total.toString(),
    };
  });
}

/** Unsold goods going back to whoever owns them. */
export async function returnToConsignor(
  input: { itemId: string; quantity: number; reason?: string | null },
  ctx: AuditContext,
): Promise<{ returned: number; left: number }> {
  if (input.quantity <= 0) throw new ConsignmentError("How many are going back?");

  const item = await db.consignmentItem.findUnique({
    where: { id: input.itemId },
    include: { consignor: true },
  });
  if (!item) throw new ConsignmentError("That item is not here.");

  const available = item.quantityReceived - item.quantitySold - item.quantityReturned;
  if (input.quantity > available) {
    throw new ConsignmentError(
      `Only ${available} of ${item.description} are still here; ${item.quantitySold} were sold.`,
    );
  }

  return db.$transaction(async (tx) => {
    const updated = await tx.consignmentItem.update({
      where: { id: item.id },
      data: { quantityReturned: { increment: input.quantity } },
    });

    // Again no journal: the garments were never the shop's, so handing them
    // back changes nothing about what the shop owns or owes.
    await writeAudit(tx, {
      action: "CONSIGNMENT_RETURNED",
      entityName: "ConsignmentItem",
      entityId: item.id,
      after: {
        itemCode: item.itemCode,
        consignor: item.consignor.name,
        returned: input.quantity,
        reason: input.reason ?? null,
      },
      ctx,
    });

    return {
      returned: input.quantity,
      left: updated.quantityReceived - updated.quantitySold - updated.quantityReturned,
    };
  });
}

// ------------------------------------------------------------ settlement

/** What is owed to one consignor and not yet paid. */
export async function owedTo(consignorId: string): Promise<Decimal> {
  const sales = await db.consignmentSale.findMany({
    where: { item: { consignorId }, settlementId: null },
    select: { ownerAmount: true },
  });
  return sales.reduce((s, x) => s.plus(dec(x.ownerAmount)), dec(0));
}

export async function settleConsignor(
  input: {
    consignorId: string;
    method: "CASH" | "BANK_TRANSFER" | "INSTAPAY";
    paidOn: Date;
    /** Blank pays everything outstanding. */
    amount?: string | null;
    reference?: string | null;
    notes?: string | null;
  },
  ctx: AuditContext,
): Promise<{ settlementNumber: string; amount: string; salesCovered: number }> {
  const consignor = await db.consignor.findUnique({ where: { id: input.consignorId } });
  if (!consignor) throw new ConsignmentError("Consignor not found.");

  const unsettled = await db.consignmentSale.findMany({
    where: { item: { consignorId: input.consignorId }, settlementId: null },
    orderBy: { saleDate: "asc" },
  });
  if (unsettled.length === 0) {
    throw new ConsignmentError(`Nothing is owed to ${consignor.name}.`);
  }

  const outstanding = unsettled.reduce((s, x) => s.plus(dec(x.ownerAmount)), dec(0));

  // Settling covers whole sales: paying an arbitrary part would leave a sale
  // half-settled with no way to say which half.
  const covered: typeof unsettled = [];
  let amount = dec(0);

  if (input.amount != null && input.amount !== "") {
    const wanted = roundMoney(dec(input.amount));
    if (wanted.lessThanOrEqualTo(0)) throw new ConsignmentError("Pay more than zero.");
    if (wanted.greaterThan(outstanding)) {
      throw new ConsignmentError(
        `${consignor.name} is owed ${outstanding.toFixed(2)}; ${wanted.toFixed(2)} is more than that.`,
      );
    }
    for (const sale of unsettled) {
      if (amount.plus(dec(sale.ownerAmount)).greaterThan(wanted)) break;
      covered.push(sale);
      amount = amount.plus(dec(sale.ownerAmount));
    }
    if (covered.length === 0) {
      throw new ConsignmentError(
        `The oldest unpaid sale is ${dec(unsettled[0].ownerAmount).toFixed(2)}; pay at least that.`,
      );
    }
  } else {
    covered.push(...unsettled);
    amount = outstanding;
  }

  const entity = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });
  const paidOn = asDay(input.paidOn);
  const fundsCode = input.method === "CASH" ? ACC.POS_DRAWER : ACC.BANK;

  return db.$transaction(async (tx) => {
    const settlementNumber = await nextDocumentNumber(tx, "CST", paidOn);

    const accountId = async (code: string) => {
      const a = await tx.account.findUnique({ where: { code }, select: { id: true } });
      if (!a) throw new ConsignmentError(`Account ${code} is missing from the chart.`);
      return a.id;
    };

    await postEntry(tx, {
      entityId: entity.id,
      postingDate: paidOn,
      sourceType: "PAYMENT",
      sourceId: consignor.id,
      memo: `Paid ${consignor.name} for consigned sales — ${settlementNumber}`,
      ctx,
      lines: [
        {
          // Discharging the debt the sale created.
          accountId: await accountId(ACC.OWED_TO_CONSIGNORS),
          debit: amount,
          entityId: entity.id,
          description: `Settled ${covered.length} sale(s) for ${consignor.name}`,
        },
        {
          accountId: await accountId(fundsCode),
          credit: amount,
          entityId: entity.id,
          description: `Paid to ${consignor.name} — ${settlementNumber}`,
        },
      ],
    });

    const settlement = await tx.consignorSettlement.create({
      data: {
        settlementNumber,
        consignorId: consignor.id,
        amount: amount.toString(),
        method: input.method,
        paidOn,
        reference: input.reference ?? null,
        notes: input.notes ?? null,
        entityId: entity.id,
        paidByUserId: ctx.userId,
      },
    });

    await tx.consignmentSale.updateMany({
      where: { id: { in: covered.map((s) => s.id) } },
      data: { settlementId: settlement.id },
    });

    await writeAudit(tx, {
      action: "CONSIGNOR_SETTLED",
      entityName: "ConsignorSettlement",
      entityId: settlement.id,
      after: {
        settlementNumber,
        consignor: consignor.name,
        amount: amount.toString(),
        sales: covered.length,
        method: input.method,
      },
      ctx,
    });

    return { settlementNumber, amount: amount.toString(), salesCovered: covered.length };
  });
}

// ------------------------------------------------------------------ views

/** What is on the rail that belongs to somebody else. */
export async function consignedStock(locationId?: string | null) {
  const items = await db.consignmentItem.findMany({
    where: locationId ? { locationId } : {},
    include: { consignor: true, location: true },
    orderBy: [{ receivedDate: "asc" }],
  });

  const today = new Date();
  return items.map((i) => {
    const left = i.quantityReceived - i.quantitySold - i.quantityReturned;
    const rate = rateFor(i, i.consignor);
    return {
      id: i.id,
      itemCode: i.itemCode,
      consignorId: i.consignorId,
      consignorName: i.consignor.name,
      description: i.description,
      size: i.size,
      colour: i.colour,
      retailPrice: dec(i.retailPrice).toString(),
      commissionRate: rate.toString(),
      commissionPct: rate.times(100).toFixed(1),
      received: i.quantityReceived,
      sold: i.quantitySold,
      returned: i.quantityReturned,
      left,
      locationId: i.locationId,
      locationName: i.location.nameAr || i.location.nameEn,
      receivedDate: i.receivedDate,
      expiresAt: i.expiresAt,
      /** Past the date the owner wants them back, and still here. */
      overdue: !!i.expiresAt && i.expiresAt < today && left > 0,
      daysHeld: Math.floor(
        (today.getTime() - new Date(i.receivedDate).getTime()) / 86_400_000,
      ),
    };
  });
}

/** Every consignor, what they have here and what they are owed. */
export async function consignorPositions() {
  const consignors = await db.consignor.findMany({ orderBy: { name: "asc" } });

  return Promise.all(
    consignors.map(async (c) => {
      const [items, sales, owed] = await Promise.all([
        db.consignmentItem.findMany({ where: { consignorId: c.id } }),
        db.consignmentSale.findMany({ where: { item: { consignorId: c.id } } }),
        owedTo(c.id),
      ]);

      const onRail = items.reduce(
        (s, i) => s + (i.quantityReceived - i.quantitySold - i.quantityReturned),
        0,
      );
      const commission = sales.reduce((s, x) => s.plus(dec(x.commissionAmount)), dec(0));
      const takings = sales.reduce(
        (s, x) => s.plus(dec(x.soldPrice).times(x.quantity)),
        dec(0),
      );

      return {
        id: c.id,
        code: c.code,
        name: c.name,
        phone: c.phone,
        commissionPct: dec(c.commissionRate).times(100).toFixed(1),
        settlementDays: c.settlementDays,
        isActive: c.isActive,
        itemsOnRail: onRail,
        salesCount: sales.length,
        takings: takings.toString(),
        /** What the shop earned from selling their goods. */
        commissionEarned: commission.toString(),
        owed: owed.toString(),
      };
    }),
  );
}

export async function recentConsignmentSales(limit = 50) {
  const sales = await db.consignmentSale.findMany({
    include: {
      item: { include: { consignor: true } },
      customer: true,
      settlement: true,
    },
    orderBy: [{ saleDate: "desc" }, { createdAt: "desc" }],
    take: limit,
  });

  return sales.map((s) => ({
    id: s.id,
    saleNumber: s.saleNumber,
    itemCode: s.item.itemCode,
    description: s.item.description,
    consignorName: s.item.consignor.name,
    quantity: s.quantity,
    total: dec(s.soldPrice).times(s.quantity).toString(),
    commission: dec(s.commissionAmount).toString(),
    owedToOwner: dec(s.ownerAmount).toString(),
    commissionPct: dec(s.commissionRate).times(100).toFixed(1),
    customerName: s.customer?.name ?? null,
    paymentMethod: s.paymentMethod,
    saleDate: s.saleDate,
    settled: !!s.settlementId,
    settlementNumber: s.settlement?.settlementNumber ?? null,
  }));
}

/** Everything the shop is holding for other people, in total. */
export async function totalOwedToConsignors(): Promise<Decimal> {
  const sales = await db.consignmentSale.findMany({
    where: { settlementId: null },
    select: { ownerAmount: true },
  });
  return sales.reduce((s, x) => s.plus(dec(x.ownerAmount)), dec(0));
}

/**
 * Consigned goods the till can sell, at this location.
 *
 * Shaped to sit beside `sellableStock` in the terminal, because to a cashier
 * with a customer waiting they are simply things on the rail. The difference
 * is entirely in what happens afterwards, and that is the system's problem
 * rather than theirs.
 */
export async function sellableConsignedStock(locationId: string) {
  const items = await db.consignmentItem.findMany({
    where: { locationId },
    include: { consignor: true },
    orderBy: { receivedDate: "asc" },
  });

  return items
    .map((i) => {
      const rate = rateFor(i, i.consignor);
      return {
        itemId: i.id,
        itemCode: i.itemCode,
        description: i.description,
        size: i.size ?? "",
        colour: i.colour ?? "",
        consignorId: i.consignorId,
        consignorName: i.consignor.name,
        retailPrice: dec(i.retailPrice).toString(),
        commissionRate: rate.toString(),
        available: i.quantityReceived - i.quantitySold - i.quantityReturned,
      };
    })
    .filter((i) => i.available > 0);
}
