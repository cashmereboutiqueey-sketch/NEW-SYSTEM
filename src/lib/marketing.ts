import "server-only";
import { z } from "zod";
import { db } from "./db";
import { writeAudit, type AuditContext } from "./audit";
import { campaignPerformance, parseMetaCsv } from "@/core/marketing";
import { createExpense } from "./expenses";
import { dec } from "./money";

/**
 * Campaigns and their spend.
 *
 * Ad spend is recorded twice on purpose: once against the campaign so its
 * performance can be judged, and once as an expense so it reaches the ledger.
 * The campaign row carries the expense id, so the two can be reconciled
 * rather than quietly diverging.
 */

export class MarketingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketingError";
  }
}

export const campaignSchema = z.object({
  code: z
    .string()
    .min(2, "A code needs at least two characters.")
    .transform((s) => s.trim().toUpperCase().replace(/\s+/g, "-")),
  nameEn: z.string().min(1, "An English name is required."),
  nameAr: z.string().min(1, "An Arabic name is required."),
  platform: z.enum(["META", "GOOGLE", "TIKTOK", "INFLUENCER", "EMAIL", "WHATSAPP", "OTHER"]),
  objective: z.string().nullable().optional(),
  audience: z.string().nullable().optional(),
  collectionId: z.string().min(1).nullable().optional(),
  styleId: z.string().min(1).nullable().optional(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().nullable().optional(),
  budget: z.coerce.number().min(0).default(0),
  couponCode: z.string().nullable().optional(),
  creatorName: z.string().nullable().optional(),
  creatorFee: z.coerce.number().min(0).default(0),
});

export async function createCampaign(
  input: z.input<typeof campaignSchema>,
  ctx: AuditContext,
) {
  const data = campaignSchema.parse(input);

  const clash = await db.campaign.findUnique({ where: { code: data.code } });
  if (clash) throw new MarketingError(`Campaign code ${data.code} is already in use.`);

  const coupon = data.couponCode?.trim().toUpperCase() || null;
  if (coupon) {
    const couponTaken = await db.campaign.findUnique({ where: { couponCode: coupon } });
    if (couponTaken) {
      // Two campaigns sharing a code means neither can be credited honestly.
      throw new MarketingError(
        `Coupon ${coupon} already belongs to ${couponTaken.nameEn}.`,
      );
    }
  }

  return db.$transaction(async (tx) => {
    const campaign = await tx.campaign.create({
      data: {
        ...data,
        couponCode: coupon,
        budget: dec(data.budget).toString(),
        creatorFee: dec(data.creatorFee).toString(),
        status: "RUNNING",
      },
    });

    await writeAudit(tx, {
      action: "CAMPAIGN_CREATED",
      entityName: "Campaign",
      entityId: campaign.id,
      after: { code: campaign.code, platform: campaign.platform, budget: campaign.budget.toString() },
      ctx,
    });

    return campaign;
  });
}

/**
 * Records a day's spend and books it as an expense.
 *
 * The same day twice replaces rather than adds, because re-uploading a report
 * that now covers a longer window is normal and doubling the spend would make
 * every campaign look worse than it is.
 */
export async function recordSpend(
  input: {
    campaignId: string;
    spendDate: Date;
    amount: number;
    impressions?: number;
    clicks?: number;
    reportedConversions?: number;
    notes?: string | null;
  },
  ctx: AuditContext,
) {
  const campaign = await db.campaign.findUnique({ where: { id: input.campaignId } });
  if (!campaign) throw new MarketingError("Campaign not found.");

  const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });
  const category = await db.costCategory.findFirst({
    where: { code: "BRD-MARKETING", entityId: brand.id },
  });
  if (!category) {
    throw new MarketingError("No marketing cost category exists for the Brand.");
  }

  const existing = await db.campaignSpend.findUnique({
    where: { campaignId_spendDate: { campaignId: input.campaignId, spendDate: input.spendDate } },
  });

  // An expense is only raised for genuinely new spend. Re-uploading a report
  // must not post the cost to the ledger a second time.
  let expenseId = existing?.expenseId ?? null;
  if (!existing && input.amount > 0) {
    const expense = await createExpense(
      {
        entityId: brand.id,
        costCategoryId: category.id,
        description: `${campaign.nameEn} — ${input.spendDate.toISOString().slice(0, 10)}`,
        reference: campaign.code,
        amount: input.amount,
        incurredDate: input.spendDate,
        dueDate: input.spendDate,
      },
      ctx,
    );
    expenseId = expense.expenseId;
  }

  return db.$transaction(async (tx) => {
    const spend = await tx.campaignSpend.upsert({
      where: {
        campaignId_spendDate: { campaignId: input.campaignId, spendDate: input.spendDate },
      },
      create: {
        campaignId: input.campaignId,
        spendDate: input.spendDate,
        amount: dec(input.amount).toString(),
        impressions: input.impressions ?? 0,
        clicks: input.clicks ?? 0,
        reportedConversions: input.reportedConversions ?? 0,
        expenseId,
        notes: input.notes ?? null,
      },
      update: {
        amount: dec(input.amount).toString(),
        impressions: input.impressions ?? 0,
        clicks: input.clicks ?? 0,
        reportedConversions: input.reportedConversions ?? 0,
        notes: input.notes ?? null,
      },
    });

    await writeAudit(tx, {
      action: existing ? "CAMPAIGN_SPEND_UPDATED" : "CAMPAIGN_SPEND_RECORDED",
      entityName: "Campaign",
      entityId: input.campaignId,
      before: existing ? { amount: existing.amount.toString() } : undefined,
      after: { date: input.spendDate.toISOString().slice(0, 10), amount: spend.amount.toString() },
      ctx,
    });

    return spend;
  });
}

/**
 * Imports a Meta Ads Manager export.
 *
 * Campaigns are matched by name. An unrecognised name is reported rather than
 * created, because a typo would otherwise become a second campaign that
 * quietly splits the spend for the same effort in two.
 */
export async function importMetaCsv(
  input: { csv: string },
  ctx: AuditContext,
): Promise<{
  imported: number;
  updated: number;
  unmatched: string[];
  errors: { line: number; reason: string }[];
}> {
  const { rows, errors } = parseMetaCsv(input.csv);
  if (rows.length === 0) return { imported: 0, updated: 0, unmatched: [], errors };

  const campaigns = await db.campaign.findMany();
  const byName = new Map(campaigns.map((c) => [c.nameEn.trim().toLowerCase(), c]));
  const byCode = new Map(campaigns.map((c) => [c.code.toLowerCase(), c]));

  let imported = 0;
  let updated = 0;
  const unmatched = new Set<string>();

  for (const row of rows) {
    const key = row.campaignName.trim().toLowerCase();
    const campaign = byName.get(key) ?? byCode.get(key);
    if (!campaign) {
      unmatched.add(row.campaignName);
      continue;
    }

    const spendDate = new Date(`${row.date}T00:00:00.000Z`);
    if (Number.isNaN(spendDate.getTime())) {
      errors.push({ line: 0, reason: `Could not read the date "${row.date}".` });
      continue;
    }

    const existed = await db.campaignSpend.findUnique({
      where: { campaignId_spendDate: { campaignId: campaign.id, spendDate } },
    });

    await recordSpend(
      {
        campaignId: campaign.id,
        spendDate,
        amount: Number(row.amountSpent),
        impressions: row.impressions ? Number(row.impressions.replace(/[^0-9]/g, "")) : 0,
        clicks: row.clicks ? Number(row.clicks.replace(/[^0-9]/g, "")) : 0,
        reportedConversions: row.purchases ? Number(row.purchases.replace(/[^0-9]/g, "")) : 0,
        notes: "Imported from Meta Ads Manager",
      },
      ctx,
    );

    if (existed) updated += 1;
    else imported += 1;
  }

  return { imported, updated, unmatched: [...unmatched], errors };
}

/** Every campaign with what it actually earned. */
export async function campaignResults() {
  const campaigns = await db.campaign.findMany({
    include: {
      spend: true,
      collection: true,
      style: true,
      salesOrders: {
        where: { status: { not: "CANCELLED" } },
        include: { lines: true, returns: true },
      },
    },
    orderBy: { startDate: "desc" },
  });

  return campaigns.map((c) => {
    const spend = c.spend.reduce((s, x) => s.plus(dec(x.amount)), dec(0));
    const revenue = c.salesOrders.reduce((s, o) => s.plus(dec(o.netAmount)), dec(0));
    const cogs = c.salesOrders.reduce((s, o) => s.plus(dec(o.cogsAmount)), dec(0));
    const units = c.salesOrders.reduce(
      (s, o) => s + o.lines.reduce((t, l) => t + l.quantity, 0), 0,
    );
    const returnedUnits = c.salesOrders.reduce(
      (s, o) => s + o.returns.reduce((t, r) => t + r.quantity, 0), 0,
    );

    return {
      id: c.id,
      code: c.code,
      nameEn: c.nameEn,
      nameAr: c.nameAr,
      platform: c.platform,
      status: c.status,
      couponCode: c.couponCode,
      creatorName: c.creatorName,
      budget: dec(c.budget),
      startDate: c.startDate,
      endDate: c.endDate,
      scopeEn: c.style?.nameEn ?? c.collection?.nameEn ?? null,
      scopeAr: c.style?.nameAr ?? c.collection?.nameAr ?? null,
      daysRecorded: c.spend.length,
      // Counts we can point at orders for, carried alongside the derived
      // performance figures so a screen never has to recount them.
      orders: c.salesOrders.length,
      units,
      returnedUnits,
      // The platform's own conversion count, kept beside our counted orders
      // rather than instead of them — the platform is marking its own homework.
      reportedConversions: c.spend.reduce((s, x) => s + x.reportedConversions, 0),
      ...campaignPerformance({
        spend,
        creatorFee: c.creatorFee,
        revenue,
        cogs,
        orders: c.salesOrders.length,
        units,
        returnedUnits,
        clicks: c.spend.reduce((s, x) => s + x.clicks, 0),
        impressions: c.spend.reduce((s, x) => s + x.impressions, 0),
      }),
    };
  });
}

/**
 * Pausing or finishing a campaign.
 *
 * A campaign was started and could never be stopped, so every one ever run
 * stayed RUNNING — and marketing cost is spread across the garments sold while
 * campaigns are live. A campaign that finished in March and still says it is
 * running keeps taking a share of the spend allocation for the rest of the
 * year, which quietly moves cost onto styles that never benefited from it.
 *
 * Finishing sets the end date if it has none, because a campaign with no end
 * is what caused the problem in the first place.
 */
export async function setCampaignStatus(
  input: {
    campaignId: string;
    status: "PLANNED" | "RUNNING" | "PAUSED" | "FINISHED";
    endedOn?: Date | null;
  },
  ctx: AuditContext,
) {
  const before = await db.campaign.findUnique({
    where: { id: input.campaignId },
    include: { _count: { select: { spend: true } } },
  });
  if (!before) throw new MarketingError("Campaign not found.");

  const finishing = input.status === "FINISHED";
  const endDate = finishing ? (input.endedOn ?? before.endDate ?? new Date()) : before.endDate;

  const after = await db.$transaction(async (tx) => {
    const updated = await tx.campaign.update({
      where: { id: input.campaignId },
      data: { status: input.status, endDate },
    });

    await writeAudit(tx, {
      action: "CAMPAIGN_STATUS_CHANGED",
      entityName: "Campaign",
      entityId: updated.id,
      ctx,
      before: {
        status: before.status,
        endDate: before.endDate?.toISOString().slice(0, 10) ?? null,
      },
      after: {
        status: updated.status,
        endDate: updated.endDate?.toISOString().slice(0, 10) ?? null,
      },
    });

    return updated;
  });

  return {
    id: after.id,
    name: after.nameAr,
    status: after.status,
    endDate: after.endDate,
    /** Spend already recorded against it, which finishing does not touch. */
    spendEntries: before._count.spend,
  };
}
