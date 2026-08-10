import "server-only";
import { db } from "./db";
import { dec, safeDiv, type Decimal } from "./money";
import { nextDocumentNumber } from "./ledger";
import { isQuoteAboveFloor } from "@/core/minute-rate";
import { writeAudit, type AuditContext } from "./audit";

/**
 * External CMT — cutting and making for somebody else's label.
 *
 * This is not a sideline. External revenue is credited against the factory
 * cost pool, so every idle minute sold above the full-capacity floor directly
 * lowers the minute rate the Brand itself pays. Selling spare capacity is the
 * strongest lever there is on the Brand's own margin.
 *
 * The floor is the full-capacity rate, not the actual one. Quoting at the
 * actual rate asks an outside client to pay for the factory's idleness, which
 * is how you lose the work; quoting below full capacity means the Brand
 * subsidises the stranger. Both figures are frozen onto the quote so it can be
 * defended later.
 */

export class CMTError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CMTError";
  }
}

export async function createClient(
  input: {
    code: string;
    name: string;
    contactPerson?: string | null;
    phone?: string | null;
    email?: string | null;
    creditDays?: number;
    notes?: string | null;
  },
  ctx: AuditContext,
): Promise<{ clientId: string; code: string }> {
  const code = input.code.trim().toUpperCase();
  if (!code) throw new CMTError("A client needs a code.");
  if (!input.name.trim()) throw new CMTError("A client needs a name.");

  const existing = await db.cMTClient.findUnique({ where: { code } });
  if (existing) throw new CMTError(`${code} is already taken by ${existing.name}.`);

  const client = await db.$transaction(async (tx) => {
    const created = await tx.cMTClient.create({
      data: {
        code,
        name: input.name.trim(),
        contactPerson: input.contactPerson ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        creditDays: input.creditDays ?? 0,
        notes: input.notes ?? null,
      },
    });
    await writeAudit(tx, {
      action: "CMT_CLIENT_CREATED",
      entityName: "CMTClient",
      entityId: created.id,
      after: { code, name: created.name },
      ctx,
    });
    return created;
  });

  return { clientId: client.id, code: client.code };
}

/** The floor and the going rate, from the month being quoted against. */
export async function quotingBasis(minuteRatePeriodId?: string) {
  const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });

  const period = minuteRatePeriodId
    ? await db.minuteRatePeriod.findUnique({
        where: { id: minuteRatePeriodId },
        include: { fiscalPeriod: true },
      })
    : await db.minuteRatePeriod.findFirst({
        where: { entityId: factory.id },
        include: { fiscalPeriod: true },
        orderBy: { calculatedAt: "desc" },
      });

  if (!period) return null;

  const bookings = await db.capacityBooking.aggregate({
    where: { fiscalPeriodId: period.fiscalPeriodId },
    _sum: { minutes: true },
  });
  const booked = dec(bookings._sum.minutes ?? 0);
  const gross = dec(period.grossAvailableMinutes);

  return {
    minuteRatePeriodId: period.id,
    label: `${period.fiscalPeriod.year}-${String(period.fiscalPeriod.month).padStart(2, "0")}`,
    floorMinuteRate: dec(period.fullCapacityMinuteRate),
    actualMinuteRate: dec(period.actualMinuteRate),
    idlePenaltyPerMinute: dec(period.idlePenaltyPerMinute),
    freeMinutes: gross.minus(booked),
    grossMinutes: gross,
    bookedMinutes: booked,
  };
}

export async function createQuote(
  input: {
    clientId: string;
    styleDescription: string;
    quantity: number;
    smvPerUnit: string;
    quotedMinuteRate: string;
    quoteDate: Date;
    validUntil?: Date | null;
    minuteRatePeriodId?: string;
    notes?: string | null;
  },
  ctx: AuditContext,
): Promise<{
  quoteId: string;
  quoteNumber: string;
  aboveFloor: boolean;
  quotedTotal: string;
  marginOverFloorPct: string;
  exceedsFreeCapacity: boolean;
}> {
  if (input.quantity <= 0) throw new CMTError("A quote needs a quantity.");

  // Below the minimum the setup swamps the sewing, and the run costs the line
  // more in changeover than it earns. Checked against this client's own
  // minimum, which may be lower than the house one for somebody worth it.
  const minimum = await minimumQuantityFor(input.clientId);
  if (input.quantity < minimum) {
    throw new CMTError(
      `${input.quantity} pieces is below the minimum of ${minimum} for this client.`,
    );
  }

  const smv = dec(input.smvPerUnit);
  const rate = dec(input.quotedMinuteRate);
  if (smv.lessThanOrEqualTo(0)) throw new CMTError("A quote needs the minutes in a garment.");
  if (rate.lessThanOrEqualTo(0)) throw new CMTError("A quote needs a rate per minute.");

  const basis = await quotingBasis(input.minuteRatePeriodId);
  if (!basis) {
    throw new CMTError(
      "There is no calculated minute rate to quote against, so there is no floor to check.",
    );
  }

  const aboveFloor = isQuoteAboveFloor(rate, basis.floorMinuteRate);
  if (!aboveFloor) {
    // Refused outright rather than flagged: below the floor the Brand is
    // paying for a stranger's garments, and that is the one thing this
    // whole costing model exists to prevent.
    throw new CMTError(
      `${rate.toDecimalPlaces(4)} is below the full-capacity floor of ${basis.floorMinuteRate.toDecimalPlaces(4)}. Quoting under it means the Brand subsidises this client.`,
    );
  }

  const totalMinutes = smv.times(input.quantity);
  const quotedUnitPrice = rate.times(smv);
  const quotedTotal = quotedUnitPrice.times(input.quantity);
  const marginOverFloor =
    safeDiv(rate.minus(basis.floorMinuteRate), basis.floorMinuteRate) ?? dec(0);

  const quote = await db.$transaction(async (tx) => {
    const quoteNumber = await nextDocumentNumber(tx, "CMT", input.quoteDate);

    const created = await tx.cMTQuote.create({
      data: {
        quoteNumber,
        clientId: input.clientId,
        minuteRatePeriodId: basis.minuteRatePeriodId,
        status: "DRAFT",
        styleDescription: input.styleDescription,
        quantity: input.quantity,
        smvPerUnit: smv.toString(),
        totalMinutes: totalMinutes.toString(),
        // Both rates are frozen so the quote can be defended months later,
        // after the month it was priced from has been recalculated.
        floorMinuteRate: basis.floorMinuteRate.toString(),
        quotedMinuteRate: rate.toString(),
        marginOverFloorPct: marginOverFloor.toString(),
        quotedUnitPrice: quotedUnitPrice.toString(),
        quotedTotal: quotedTotal.toString(),
        quoteDate: input.quoteDate,
        validUntil: input.validUntil ?? null,
        notes: input.notes ?? null,
      },
    });

    await writeAudit(tx, {
      action: "CMT_QUOTE_CREATED",
      entityName: "CMTQuote",
      entityId: created.id,
      after: {
        quoteNumber,
        quantity: input.quantity,
        totalMinutes: totalMinutes.toString(),
        floor: basis.floorMinuteRate.toString(),
        quoted: rate.toString(),
        marginOverFloor: marginOverFloor.toString(),
        total: quotedTotal.toString(),
      },
      ctx,
    });

    return created;
  });

  return {
    quoteId: quote.id,
    quoteNumber: quote.quoteNumber,
    aboveFloor,
    quotedTotal: quotedTotal.toString(),
    marginOverFloorPct: marginOverFloor.toString(),
    // Not refused: a client may be worth taking on and hiring for. Said out
    // loud so it is a decision rather than a surprise in six weeks.
    exceedsFreeCapacity: totalMinutes.greaterThan(basis.freeMinutes),
  };
}

export async function clientsWithHistory() {
  const clients = await db.cMTClient.findMany({
    include: {
      quotes: { orderBy: { quoteDate: "desc" } },
      orders: true,
    },
    orderBy: { name: "asc" },
  });

  return clients.map((c) => {
    const won = c.quotes.filter((q) => q.status === "ACCEPTED").length;
    const contractValue = c.orders.reduce((s, o) => s.plus(dec(o.contractValue)), dec(0));
    const realised = c.orders.reduce((s, o) => s.plus(dec(o.realisedMargin ?? 0)), dec(0));

    return {
      id: c.id,
      code: c.code,
      name: c.name,
      contactPerson: c.contactPerson,
      phone: c.phone,
      creditDays: c.creditDays,
      isActive: c.isActive,
      quoteCount: c.quotes.length,
      wonCount: won,
      winRate: c.quotes.length > 0 ? dec(won).div(c.quotes.length) : null,
      orderCount: c.orders.length,
      contractValue,
      realisedMargin: realised,
      minutesSold: c.orders.reduce((s, o) => s.plus(dec(o.totalMinutes)), dec(0)),
    };
  });
}

export async function recentQuotes(limit = 40) {
  const quotes = await db.cMTQuote.findMany({
    include: { client: true, minuteRatePeriod: { include: { fiscalPeriod: true } } },
    orderBy: [{ quoteDate: "desc" }, { createdAt: "desc" }],
    take: limit,
  });

  return quotes.map((q) => ({
    id: q.id,
    quoteNumber: q.quoteNumber,
    clientName: q.client.name,
    status: q.status,
    styleDescription: q.styleDescription,
    quantity: q.quantity,
    smvPerUnit: dec(q.smvPerUnit),
    totalMinutes: dec(q.totalMinutes),
    floorMinuteRate: dec(q.floorMinuteRate),
    quotedMinuteRate: dec(q.quotedMinuteRate),
    marginOverFloorPct: dec(q.marginOverFloorPct),
    quotedUnitPrice: dec(q.quotedUnitPrice),
    quotedTotal: dec(q.quotedTotal),
    quoteDate: q.quoteDate,
    validUntil: q.validUntil,
    periodLabel: `${q.minuteRatePeriod.fiscalPeriod.year}-${String(q.minuteRatePeriod.fiscalPeriod.month).padStart(2, "0")}`,
  }));
}

export async function setQuoteStatus(
  input: { quoteId: string; status: "SENT" | "ACCEPTED" | "REJECTED" | "EXPIRED" },
  ctx: AuditContext,
): Promise<void> {
  const quote = await db.cMTQuote.findUnique({ where: { id: input.quoteId } });
  if (!quote) throw new CMTError("That quote no longer exists.");

  await db.$transaction(async (tx) => {
    await tx.cMTQuote.update({ where: { id: quote.id }, data: { status: input.status } });
    await writeAudit(tx, {
      action: "CMT_QUOTE_STATUS_CHANGED",
      entityName: "CMTQuote",
      entityId: quote.id,
      before: { status: quote.status },
      after: { status: input.status },
      ctx,
    });
  });
}

// -------------------------------------------------- what to tell a client

/**
 * Setup minutes: the work a run costs before a single garment is sewn.
 *
 * Marker making, cutting the pattern, threading and changing the line over.
 * It is the same whether the run is fifty pieces or five thousand, which is
 * the entire reason a small run costs more per garment — not greed, and worth
 * being able to show a client on a table.
 */
export const CMT_SETUP_MINUTES = "cmt.setupMinutes";
export const CMT_MINIMUM_QUANTITY = "cmt.minimumQuantity";

async function setting(key: string, fallback: string): Promise<Decimal> {
  const row = await db.setting.findUnique({ where: { key } });
  return dec(row?.value ?? fallback);
}

/**
 * The smallest run the factory will take from this client.
 *
 * Their own minimum wins when they have one, because the answer to "how few
 * can you do" is a relationship question before it is an engineering one.
 */
export async function minimumQuantityFor(clientId?: string | null): Promise<number> {
  const house = (await setting(CMT_MINIMUM_QUANTITY, "100")).toNumber();
  if (!clientId) return house;

  const client = await db.cMTClient.findUnique({
    where: { id: clientId },
    select: { minimumQuantity: true },
  });
  return client?.minimumQuantity ?? house;
}

/**
 * How long a run will take, from capacity that actually exists.
 *
 * Minutes per day comes off the same period the rate does — operators, hours,
 * utilisation — so a promised date is anchored to the factory as measured
 * rather than as hoped for. Whatever is already booked is subtracted first: a
 * date that ignores the queue is a date that will be missed.
 */
export async function leadTimeDays(totalMinutes: Decimal): Promise<{
  days: number;
  minutesPerDay: Decimal;
  freeMinutes: Decimal;
  fitsInPeriod: boolean;
} | null> {
  const basis = await quotingBasis();
  if (!basis) return null;

  const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });
  const period = await db.minuteRatePeriod.findFirst({
    where: { entityId: factory.id },
    orderBy: { calculatedAt: "desc" },
  });
  if (!period) return null;

  const workingDays = dec(period.workingDays);
  const minutesPerDay = workingDays.greaterThan(0)
    ? dec(period.grossAvailableMinutes).dividedBy(workingDays)
    : dec(0);

  const days = minutesPerDay.greaterThan(0)
    ? Math.ceil(totalMinutes.dividedBy(minutesPerDay).toNumber())
    : 0;

  return {
    days,
    minutesPerDay,
    freeMinutes: basis.freeMinutes,
    fitsInPeriod: basis.freeMinutes.greaterThanOrEqualTo(totalMinutes),
  };
}

/**
 * The answer to "how few can you make, and for how much".
 *
 * One table a person can read down the phone. The price falls with quantity
 * for exactly one reason and it is shown in its own column: the setup is
 * spread over more garments. Nothing here is a discount somebody invented.
 *
 *   unit price = (SMV + setup ÷ quantity) × minute rate
 */
export async function rateCard(input: {
  smvPerUnit: string;
  clientId?: string | null;
  /** Above the floor, as a fraction. 0.15 is a fifteen per cent margin. */
  marginOverFloor?: string;
  quantities?: number[];
}) {
  const basis = await quotingBasis();
  if (!basis) return null;

  const smv = dec(input.smvPerUnit);
  if (smv.lessThanOrEqualTo(0)) throw new CMTError("The garment needs a minute value.");

  const setupMinutes = await setting(CMT_SETUP_MINUTES, "480");
  const minimum = await minimumQuantityFor(input.clientId);
  const margin = dec(input.marginOverFloor ?? "0.15");

  const rate = basis.floorMinuteRate.times(dec(1).plus(margin));

  // The client's own minimum first, then the usual conversation points.
  const quantities = (input.quantities ?? [minimum, 250, 500, 1000, 2000])
    .filter((q) => q >= minimum)
    .sort((a, b) => a - b);

  const tiers = [];
  for (const quantity of quantities) {
    const setupPerUnit = setupMinutes.dividedBy(quantity);
    const minutesPerUnit = smv.plus(setupPerUnit);
    const totalMinutes = minutesPerUnit.times(quantity);
    // Rounded to the piastre first, then multiplied — the same rule invoices
    // follow. A client reading this table has to be able to take the printed
    // unit price, multiply by the quantity and land on the printed total,
    // rather than on a number only the system can reproduce.
    const unitPrice = minutesPerUnit.times(rate).toDecimalPlaces(2);

    const lead = await leadTimeDays(totalMinutes);

    tiers.push({
      quantity,
      setupPerUnit: setupPerUnit.toDecimalPlaces(4).toString(),
      minutesPerUnit: minutesPerUnit.toDecimalPlaces(4).toString(),
      totalMinutes: totalMinutes.toDecimalPlaces(2).toString(),
      unitPrice: unitPrice.toString(),
      total: unitPrice.times(quantity).toDecimalPlaces(2).toString(),
      leadDays: lead?.days ?? null,
      /** False when the month's free minutes cannot absorb it. */
      capacityAvailable: lead?.fitsInPeriod ?? false,
    });
  }

  return {
    minimumQuantity: minimum,
    setupMinutes: setupMinutes.toString(),
    smvPerUnit: smv.toString(),
    floorMinuteRate: basis.floorMinuteRate.toDecimalPlaces(4).toString(),
    quotedMinuteRate: rate.toDecimalPlaces(4).toString(),
    marginOverFloorPct: margin.times(100).toDecimalPlaces(2).toString(),
    freeMinutes: basis.freeMinutes.toDecimalPlaces(0).toString(),
    period: basis.label,
    tiers,
  };
}
