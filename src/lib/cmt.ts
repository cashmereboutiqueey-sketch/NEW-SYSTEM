import "server-only";
import { db } from "./db";
import { dec, safeDiv } from "./money";
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
