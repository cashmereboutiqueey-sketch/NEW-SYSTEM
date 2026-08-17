import "server-only";
import { z } from "zod";
import { db } from "./db";
import { dec, type Decimal } from "./money";
import { writeAudit, type AuditContext } from "./audit";

/**
 * VAT, and the reason it is switched off.
 *
 * `tax_rates` has been seeded since the first migration and nothing has ever
 * read it. That is not an oversight: `vat.registered` is false because the
 * business is not registered, and a system that charged VAT it did not owe
 * would be worse than one that charged none.
 *
 * What was missing is everything around that decision — no way to see which
 * rates are on file, no way to add one when the law changes, and no way to
 * see what would be owed once registration happens. A dormant feature with no
 * switch and no dial is indistinguishable from a forgotten one.
 *
 * Rates are effective-dated and never edited. When a rate changes, a new row
 * starts where the old one ends, because a posting made last year was made at
 * last year's rate and rewriting the rate would restate it. `appliedTaxRate`
 * is already carried on every journal line and through every reversal for
 * exactly this reason.
 */

export class TaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaxError";
  }
}

/** Where VAT lands once it is being charged. Both exist in every install. */
export const VAT_ACCOUNTS = {
  /** VAT paid to suppliers, reclaimable from the authority. */
  INPUT: "1450",
  /** VAT charged to customers, owed to the authority. */
  OUTPUT: "2300",
} as const;

/**
 * The rate in force on a given day.
 *
 * Null when the code has no row covering that date — which is a refusal, not a
 * zero. Falling back to zero would post a sale as exempt because somebody
 * forgot to extend a rate, and nothing would say so.
 */
export async function effectiveRate(code: string, on: Date = new Date()) {
  const rate = await db.taxRate.findFirst({
    where: {
      code,
      isActive: true,
      effectiveFrom: { lte: on },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: on } }],
    },
    orderBy: { effectiveFrom: "desc" },
  });

  if (!rate) return null;
  return {
    id: rate.id,
    code: rate.code,
    nameAr: rate.nameAr,
    nameEn: rate.nameEn,
    rate: dec(rate.rate),
    effectiveFrom: rate.effectiveFrom,
    effectiveTo: rate.effectiveTo,
  };
}

/** Whether VAT is being charged at all, and at what. */
export async function taxStatus(on: Date = new Date()) {
  const settings = await db.setting.findMany({
    where: { key: { in: ["vat.registered", "vat.defaultRateCode"] } },
  });
  const value = (key: string, fallback: string) =>
    settings.find((s) => s.key === key)?.value ?? fallback;

  const registered = value("vat.registered", "false") === "true";
  const defaultCode = value("vat.defaultRateCode", "VAT-EXEMPT");
  const rate = await effectiveRate(defaultCode, on);

  return {
    registered,
    defaultCode,
    rate,
    /**
     * The rate that would actually be applied. Zero while unregistered
     * whatever the default code says — being registered is what creates the
     * obligation, not which code is selected.
     */
    applicable: registered && rate ? rate.rate : dec(0),
    /** The default names a code with no rate covering today. */
    misconfigured: rate === null,
  };
}

/** Every rate on file, current and historical. */
export async function taxRates() {
  const rows = await db.taxRate.findMany({
    orderBy: [{ code: "asc" }, { effectiveFrom: "desc" }],
  });

  const today = new Date();
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    nameAr: r.nameAr,
    nameEn: r.nameEn,
    rate: dec(r.rate),
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
    isActive: r.isActive,
    current:
      r.isActive &&
      r.effectiveFrom <= today &&
      (r.effectiveTo === null || r.effectiveTo >= today),
  }));
}

const rateSchema = z
  .object({
    code: z.string().trim().min(2).max(20),
    nameAr: z.string().trim().min(1),
    nameEn: z.string().trim().min(1),
    /** A fraction: 0.14, never 14. */
    rate: z.coerce.number().min(0).max(1, "A rate is a fraction: 0.14, not 14."),
    effectiveFrom: z.coerce.date(),
  })
  .strict();

/**
 * Record a new rate for a code.
 *
 * The previous row is closed the day before this one starts rather than
 * edited. A posting made at 14% stays a posting made at 14% even after the
 * rate moves, and the only way to keep that true is to leave the old row
 * exactly where it is.
 */
export async function addTaxRate(input: z.input<typeof rateSchema>, ctx: AuditContext) {
  const data = rateSchema.parse(input);

  const clash = await db.taxRate.findUnique({
    where: { code_effectiveFrom: { code: data.code, effectiveFrom: data.effectiveFrom } },
  });
  if (clash) {
    throw new TaxError(
      `${data.code} already has a rate starting ${data.effectiveFrom.toISOString().slice(0, 10)}.`,
    );
  }

  return db.$transaction(async (tx) => {
    // Whatever was open for this code ends the day before the new one starts.
    const previous = await tx.taxRate.findFirst({
      where: { code: data.code, effectiveTo: null, effectiveFrom: { lt: data.effectiveFrom } },
      orderBy: { effectiveFrom: "desc" },
    });

    if (previous) {
      const endsOn = new Date(data.effectiveFrom.getTime() - 86_400_000);
      await tx.taxRate.update({ where: { id: previous.id }, data: { effectiveTo: endsOn } });
    }

    const created = await tx.taxRate.create({
      data: {
        code: data.code,
        nameAr: data.nameAr,
        nameEn: data.nameEn,
        rate: dec(data.rate).toString(),
        effectiveFrom: data.effectiveFrom,
      },
    });

    await writeAudit(tx, {
      action: "TAX_RATE_ADDED",
      entityName: "TaxRate",
      entityId: created.id,
      ctx,
      after: {
        code: created.code,
        rate: created.rate.toString(),
        effectiveFrom: created.effectiveFrom.toISOString().slice(0, 10),
        supersedes: previous?.id ?? null,
      },
    });

    return {
      taxRateId: created.id,
      code: created.code,
      /** True when an earlier open-ended rate was closed to make room. */
      supersededPrevious: previous !== null,
    };
  });
}

/**
 * What would be owed to the authority for a period.
 *
 * Output VAT less input VAT, read from the two accounts that already exist.
 * While unregistered both are zero and the screen says why — which is a more
 * useful answer than an empty report.
 */
export async function vatPosition(from: Date, to: Date) {
  const rows = await db.$queryRaw<{ code: string; total: string }[]>`
    SELECT a."code" AS code,
           (SUM(l."debit") - SUM(l."credit"))::text AS total
    FROM "journal_lines" l
    JOIN "journal_entries" e ON e."id" = l."journalEntryId"
    JOIN "accounts" a ON a."id" = l."accountId"
    WHERE e."status" = 'POSTED'
      AND e."postingDate" >= ${from}
      AND e."postingDate" <= ${to}
      AND a."code" IN (${VAT_ACCOUNTS.INPUT}, ${VAT_ACCOUNTS.OUTPUT})
    GROUP BY a."code"
  `;

  const balance = (code: string) => dec(rows.find((r) => r.code === code)?.total ?? 0);

  // Decimal keeps a signed zero, so flipping the sign of nothing gives −0 and
  // the screen would read "−0.00". Minus nothing is nothing.
  const unsigned = (v: Decimal) => (v.isZero() ? dec(0) : v);

  // Input VAT is an asset, so a debit balance is VAT reclaimable. Output VAT
  // is a liability, so its credit balance reads negative here and is flipped.
  const reclaimable = unsigned(balance(VAT_ACCOUNTS.INPUT));
  const charged = unsigned(balance(VAT_ACCOUNTS.OUTPUT).negated());

  return {
    from,
    to,
    /** VAT charged to customers, owed onward. */
    outputVat: charged,
    /** VAT paid to suppliers, reclaimable. */
    inputVat: reclaimable,
    /** Positive is owed to the authority; negative is a refund due. */
    net: unsigned(charged.minus(reclaimable)),
  };
}

/**
 * Turn VAT on or off.
 *
 * Deliberately a setting rather than a code change, and deliberately audited:
 * the day this flips is the day the business's obligations change, and that
 * date needs to be findable afterwards.
 */
export async function setVatRegistered(registered: boolean, ctx: AuditContext) {
  const before = await db.setting.findUnique({ where: { key: "vat.registered" } });

  const updated = await db.setting.update({
    where: { key: "vat.registered" },
    data: { value: registered ? "true" : "false" },
  });

  await writeAudit(db, {
    action: "VAT_REGISTRATION_CHANGED",
    entityName: "Setting",
    entityId: updated.id,
    ctx,
    before: { registered: before?.value ?? "false" },
    after: { registered: updated.value },
  });

  return { registered };
}
