import "server-only";
import { db } from "./db";
import { writeAudit, type AuditContext } from "./audit";
import {
  rfm, customerValue, segment, findDuplicates,
  normalisePhone, normaliseEmail,
  type CustomerOrder,
} from "@/core/crm";
import { dec } from "./money";

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

export async function customerProfiles(asOf: Date = new Date()) {
  const customers = await db.customer.findMany({
    where: { mergedIntoId: null },
    include: {
      channel: true,
      salesOrders: {
        include: { lines: true, returns: true },
        orderBy: { orderDate: "desc" },
      },
    },
  });

  return customers
    .map((c) => {
      const orders: CustomerOrder[] = c.salesOrders
        .filter((o) => o.status !== "CANCELLED")
        .map((o) => ({
          orderDate: o.orderDate,
          netAmount: o.netAmount.toString(),
          cogsAmount: o.cogsAmount.toString(),
          quantity: o.lines.reduce((s, l) => s + l.quantity, 0),
          returnedQty: o.returns.reduce((s, r) => s + r.quantity, 0),
        }));

      const score = rfm(orders, asOf);
      const value = customerValue(orders);

      return {
        id: c.id,
        code: c.code,
        name: c.name,
        phone: c.phone,
        email: c.email,
        city: c.city,
        channelEn: c.channel?.nameEn ?? null,
        channelAr: c.channel?.nameAr ?? null,
        acquiredVia: c.acquiredVia,
        marketingConsent: c.marketingConsent,
        isSuppressed: c.isSuppressed,
        lastOrderDate: orders[0]?.orderDate ?? null,
        segment: segment(score),
        ...score,
        ...value,
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

    const moved = await tx.salesOrder.updateMany({
      where: { customerId: merge.id },
      data: { customerId: keep.id },
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
      after: { mergedInto: keep.code, ordersMoved: moved.count },
      ctx: { ...ctx, reason: input.reason },
    });

    return { ordersMoved: moved.count };
  });
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
