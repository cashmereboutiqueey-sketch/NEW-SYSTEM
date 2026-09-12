import "server-only";
import { db } from "./db";
import { writeAudit, type AuditContext } from "./audit";
import {
  rfmFromTotals, customerValueFromTotals, segment, findDuplicates,
  normalisePhone, normaliseEmail,
  type CustomerTotals,
} from "@/core/crm";
import { dec } from "./money";
import { command } from "./command";

/**
 * Customer intelligence, built from orders that actually happened.
 *
 * Nothing here predicts. Lifetime value is gross profit already earned and
 * segments come from stated thresholds, so every figure traces back to
 * receipts the owner can open.
 */

export class CrmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrmError";
  }
}

/** Keeps the normalised lookup columns in step with what was entered. */
export async function upsertCustomerContact(
  input: {
    customerId: string;
    phone?: string | null;
    email?: string | null;
    marketingConsent?: boolean | null;
    isSuppressed?: boolean;
  },
  ctx: AuditContext,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const before = await tx.customer.findUnique({ where: { id: input.customerId } });
    if (!before) throw new CrmError("Customer not found.");

    const phone = input.phone !== undefined ? input.phone : before.phone;
    const email = input.email !== undefined ? input.email : before.email;

    const after = await tx.customer.update({
      where: { id: input.customerId },
      data: {
        phone,
        email,
        phoneNormalised: normalisePhone(phone),
        emailNormalised: normaliseEmail(email),
        ...(input.marketingConsent !== undefined
          ? { marketingConsent: input.marketingConsent, consentRecordedAt: new Date() }
          : {}),
        ...(input.isSuppressed !== undefined ? { isSuppressed: input.isSuppressed } : {}),
      },
    });

    await writeAudit(tx, {
      action: "CUSTOMER_CONTACT_UPDATED",
      entityName: "Customer",
      entityId: input.customerId,
      before: {
        phone: before.phone, email: before.email,
        marketingConsent: before.marketingConsent, isSuppressed: before.isSuppressed,
      },
      after: {
        phone: after.phone, email: after.email,
        marketingConsent: after.marketingConsent, isSuppressed: after.isSuppressed,
      },
      ctx,
    });
  });
}

/**
 * Every customer with what they are worth, scored.
 *
 * The totals come from the database as totals. Reading each customer's orders,
 * lines and returns to add them up here meant one screen loading every order
 * line the shop has ever sold — which is fine at a hundred customers and is
 * not fine at ten thousand.
 */
export async function customerProfiles(asOf: Date = new Date()) {
  const rows = await db.$queryRaw<
    {
      id: string;
      code: string;
      name: string;
      phone: string | null;
      email: string | null;
      city: string | null;
      acquiredVia: string | null;
      marketingConsent: boolean | null;
      isSuppressed: boolean;
      channelEn: string | null;
      channelAr: string | null;
      orders: number;
      lastOrderDate: Date | null;
      revenue: string;
      cogs: string;
      units: number;
      returnedUnits: number;
    }[]
  >`
    WITH sold AS (
      SELECT "customerId" AS cid,
             COUNT(*)::int AS orders,
             MAX("orderDate") AS last_order_date,
             SUM("netAmount")::text AS revenue,
             SUM("cogsAmount")::text AS cogs
      FROM "sales_orders"
      WHERE "customerId" IS NOT NULL AND "status" <> 'CANCELLED'
      GROUP BY 1
    ),
    bought AS (
      SELECT o."customerId" AS cid, SUM(l."quantity")::int AS units
      FROM "sales_order_lines" l
      JOIN "sales_orders" o ON o."id" = l."salesOrderId"
      WHERE o."customerId" IS NOT NULL AND o."status" <> 'CANCELLED'
      GROUP BY 1
    ),
    sent_back AS (
      SELECT o."customerId" AS cid, SUM(r."quantity")::int AS units
      FROM "returns" r
      JOIN "sales_orders" o ON o."id" = r."salesOrderId"
      WHERE o."customerId" IS NOT NULL AND o."status" <> 'CANCELLED'
      GROUP BY 1
    )
    SELECT c."id", c."code", c."name", c."phone", c."email", c."city",
           c."acquiredVia"::text AS "acquiredVia",
           c."marketingConsent", c."isSuppressed",
           ch."nameEn" AS "channelEn", ch."nameAr" AS "channelAr",
           COALESCE(s."orders", 0) AS "orders",
           s."last_order_date" AS "lastOrderDate",
           COALESCE(s."revenue", '0') AS "revenue",
           COALESCE(s."cogs", '0') AS "cogs",
           COALESCE(b."units", 0) AS "units",
           COALESCE(sb."units", 0) AS "returnedUnits"
    FROM "customers" c
    LEFT JOIN "sales_channels" ch ON ch."id" = c."channelId"
    LEFT JOIN sold s ON s."cid" = c."id"
    LEFT JOIN bought b ON b."cid" = c."id"
    LEFT JOIN sent_back sb ON sb."cid" = c."id"
    WHERE c."mergedIntoId" IS NULL
  `;

  return rows
    .map((r) => {
      const totals: CustomerTotals = {
        orders: r.orders,
        lastOrderDate: r.lastOrderDate,
        revenue: r.revenue,
        cogs: r.cogs,
        units: r.units,
        returnedUnits: r.returnedUnits,
      };
      const score = rfmFromTotals(totals, asOf);

      return {
        id: r.id,
        code: r.code,
        name: r.name,
        phone: r.phone,
        email: r.email,
        city: r.city,
        channelEn: r.channelEn,
        channelAr: r.channelAr,
        acquiredVia: r.acquiredVia,
        marketingConsent: r.marketingConsent,
        isSuppressed: r.isSuppressed,
        lastOrderDate: r.lastOrderDate,
        segment: segment(score),
        ...score,
        ...customerValueFromTotals(totals),
      };
    })
    .sort((a, b) => Number(dec(b.lifetimeValue).minus(dec(a.lifetimeValue))));
}

/**
 * Records that look like the same person, for a human to confirm.
 *
 * Merged records are excluded so a confirmed duplicate does not keep
 * resurfacing.
 */
export async function duplicateCandidates() {
  const customers = await db.customer.findMany({
    where: { mergedIntoId: null },
    select: { id: true, code: true, name: true, phone: true, email: true, city: true },
  });

  const byId = new Map(customers.map((c) => [c.id, c]));

  return findDuplicates(customers).map((d) => ({
    ...d,
    a: byId.get(d.aId)!,
    b: byId.get(d.bId)!,
    /// Same contact detail but different names is the case that most needs a
    /// person to look — a shared family phone, not a duplicate.
    namesDiffer: byId.get(d.aId)!.name.trim() !== byId.get(d.bId)!.name.trim(),
  }));
}

/**
 * Confirms two records are the same person.
 *
 * The duplicate is kept and flagged rather than deleted, and its orders are
 * repointed at the surviving record. Deleting would destroy history that
 * cannot be reconstructed, and the audit row records who decided.
 */
export async function mergeCustomers(
  input: { keepId: string; mergeId: string; reason: string },
  ctx: AuditContext,
): Promise<{ ordersMoved: number }> {
  return command("crm.mergeCustomers", input, ctx, async () => {
    if (input.keepId === input.mergeId) {
      throw new CrmError("A customer cannot be merged into itself.");
    }
    if (!input.reason.trim()) {
      throw new CrmError("A merge needs a reason; it cannot be undone automatically.");
    }

    return db.$transaction(async (tx) => {
      const [keep, merge] = await Promise.all([
        tx.customer.findUnique({ where: { id: input.keepId } }),
        tx.customer.findUnique({ where: { id: input.mergeId } }),
      ]);
      if (!keep || !merge) throw new CrmError("Customer not found.");
      if (merge.mergedIntoId) throw new CrmError("That record has already been merged.");
      if (keep.mergedIntoId) {
        throw new CrmError("Cannot merge into a record that is itself a duplicate.");
      }

      // Everything that names the customer moves to the one kept, not just the
      // sales orders. Leaving the rest behind split the person again: a custom
      // order and its deposit on one record, their purchases on the other, and
      // the website still attaching every new order to the record that had
      // been merged away.
      //
      // Posted journal lines keep the name they were posted with. They are the
      // record of what happened, and immutable; what a customer owes is worked
      // out from their orders, which have moved.
      const moved = await tx.salesOrder.updateMany({
        where: { customerId: merge.id },
        data: { customerId: keep.id },
      });
      const customOrders = await tx.customOrder.updateMany({
        where: { customerId: merge.id },
        data: { customerId: keep.id },
      });
      const consignmentSales = await tx.consignmentSale.updateMany({
        where: { customerId: merge.id },
        data: { customerId: keep.id },
      });
      const checkouts = await tx.abandonedCheckout.updateMany({
        where: { customerId: merge.id },
        data: { customerId: keep.id },
      });
      const mappings = await tx.externalMapping.updateMany({
        where: { objectType: "customer", internalId: merge.id },
        data: { internalId: keep.id },
      });

      await tx.customer.update({
        where: { id: merge.id },
        data: { mergedIntoId: keep.id, mergedAt: new Date(), isActive: false },
      });

      await writeAudit(tx, {
        action: "CUSTOMER_MERGED",
        entityName: "Customer",
        entityId: merge.id,
        before: { code: merge.code, name: merge.name, isActive: merge.isActive },
        after: {
          mergedInto: keep.code,
          ordersMoved: moved.count,
          customOrdersMoved: customOrders.count,
          consignmentSalesMoved: consignmentSales.count,
          checkoutsMoved: checkouts.count,
          externalMappingsMoved: mappings.count,
        },
        ctx: { ...ctx, reason: input.reason },
      });

      return { ordersMoved: moved.count };
    });
  });
}

/**
 * The record a customer id stands for now.
 *
 * A merged record is a signpost to the one kept. Anything that writes against
 * a customer — a sale, a custom order, an import — goes through this, so an id
 * held on an old screen, a stale mapping or a bookmarked link cannot quietly
 * start a second history on the record that was merged away.
 */
export async function canonicalCustomerId(
  tx: Pick<typeof db, "customer">,
  customerId: string | null | undefined,
): Promise<string | null> {
  if (!customerId) return null;
  let id = customerId;
  // Chains are short — a merge refuses to target a merged record — but a
  // bound keeps a data error from looping forever.
  for (let hops = 0; hops < 10; hops++) {
    const c = await tx.customer.findUnique({ where: { id }, select: { mergedIntoId: true } });
    if (!c) throw new CrmError("Customer not found.");
    if (!c.mergedIntoId) return id;
    id = c.mergedIntoId;
  }
  throw new CrmError("That customer record points round in a circle of merges.");
}

/**
 * Who may legitimately be marketed to.
 *
 * Suppression outranks consent: an unsubscribe is a later instruction than an
 * old opt-in, and a null consent is not a yes.
 */
export async function marketableCustomers() {
  return db.customer.findMany({
    where: { mergedIntoId: null, isSuppressed: false, marketingConsent: true, isActive: true },
    select: { id: true, code: true, name: true, email: true, phone: true },
  });
}
