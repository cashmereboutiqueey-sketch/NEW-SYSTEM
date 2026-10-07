import "server-only";
import { db } from "./db";
import { dec, roundMoney, type Decimal } from "./money";
import { nextDocumentNumber } from "./ledger";
import { writeAudit, type AuditContext } from "./audit";
import { command } from "./command";
import type { ShipmentStatus } from "@/generated/prisma/client";
import { EGYPT_GOVERNORATES } from "./egypt-governorates";

/**
 * Handing parcels to the courier, and hearing back from it.
 *
 * Cashmere prepares the parcel and Flextock handles delivery. Manual handoffs
 * require confirmation; API handoffs are recorded only after a create response.
 */

export class ShippingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShippingError";
  }
}

export const FLEXTOCK = "FLEXTOCK";
const DIRECT_BRANCH = "DIRECT";

/* ───────────────────────────────────────────────────────────────── zones */

/** Every area the courier serves, grouped for a governorate-then-area picker. */
export async function courierZones(courier = FLEXTOCK) {
  const zones = await db.courierZone.findMany({
    where: { courier, isActive: true },
    orderBy: [{ governorate: "asc" }, { region: "asc" }],
    select: { id: true, governorate: true, region: true, price: true, branch: true },
  });
  const byGovernorate = new Map<string, { id: string; region: string; price: string }[]>();
  for (const z of zones) {
    const list = byGovernorate.get(z.governorate) ?? [];
    list.push({ id: z.id, region: z.region, price: dec(z.price).toString() });
    byGovernorate.set(z.governorate, list);
  }
  return [...byGovernorate.entries()].map(([governorate, regions]) => ({ governorate, regions }));
}

/** Add one confirmed delivery area and its quoted price. */
export async function createCourierZone(
  input: { governorate: string; region: string; price: string },
  ctx: AuditContext,
): Promise<{ id: string; governorate: string; region: string; price: string; created: boolean }> {
  return command("shipping.createCourierZone", input, ctx, async () => {
    const governorate = input.governorate.trim();
    const region = input.region.trim();
    if (!(EGYPT_GOVERNORATES as readonly string[]).includes(governorate)
      && !(await db.courierZone.findFirst({ where: { courier: FLEXTOCK, governorate } }))) {
      throw new ShippingError("Choose an Egyptian governorate.");
    }
    if (!region || region.length > 120) throw new ShippingError("Enter the courier's area name (up to 120 characters).");
    if (!/^\d+(?:\.\d{1,2})?$/.test(input.price.trim())) throw new ShippingError("Enter the courier's price in pounds and piastres.");
    const price = roundMoney(dec(input.price)).toString();
    if (dec(price).greaterThan(1_000_000)) throw new ShippingError("Check the courier price; it is too large.");
    const existing = await db.courierZone.findUnique({
      where: { courier_governorate_region: { courier: FLEXTOCK, governorate, region } },
    });
    if (existing?.isActive) {
      return { id: existing.id, governorate, region, price: dec(existing.price).toString(), created: false };
    }
    const zone = existing
      ? await db.courierZone.update({ where: { id: existing.id }, data: { isActive: true, price, branch: DIRECT_BRANCH } })
      : await db.courierZone.create({ data: { courier: FLEXTOCK, governorate, region, price, branch: DIRECT_BRANCH } });
    await writeAudit(db, {
      action: "COURIER_ZONE_CREATED",
      entityName: "CourierZone",
      entityId: zone.id,
      before: existing ? { isActive: false, price: dec(existing.price).toString() } : null,
      after: { courier: FLEXTOCK, governorate, region, price, branch: zone.branch },
      ctx,
    });
    return { id: zone.id, governorate, region, price, created: true };
  });
}

/**
 * Loads the courier's price list.
 *
 * An area the courier dropped is deactivated rather than deleted: orders sent
 * there last month still point at it, and deleting it would take their
 * delivery area with it.
 */
export async function importCourierZones(
  input: {
    zones: { governorate: string; region: string; price: number | string }[];
  },
  ctx: AuditContext,
): Promise<{ created: number; updated: number; deactivated: number }> {
  return command("shipping.importCourierZones", { courier: FLEXTOCK, count: input.zones.length }, ctx, async () => {
    const existing = await db.courierZone.findMany({ where: { courier: FLEXTOCK } });
    const byKey = new Map(existing.map((z) => [`${z.governorate}|${z.region}`, z]));
    const seen = new Set<string>();
    let created = 0;
    let updated = 0;

    for (const zone of input.zones) {
      const governorate = zone.governorate.trim();
      const region = zone.region.trim();
      const key = `${governorate}|${region}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const price = roundMoney(dec(zone.price)).toString();
      const branch = DIRECT_BRANCH;
      const found = byKey.get(key);
      if (!found) {
        await db.courierZone.create({
          data: { courier: FLEXTOCK, governorate, region, price, branch },
        });
        created += 1;
      } else if (!dec(found.price).equals(price) || found.branch !== branch || !found.isActive) {
        await db.courierZone.update({
          where: { id: found.id },
          data: { price, branch, isActive: true },
        });
        updated += 1;
      }
    }

    const gone = existing.filter((z) => z.isActive && !seen.has(`${z.governorate}|${z.region}`));
    if (gone.length > 0) {
      await db.courierZone.updateMany({
        where: { id: { in: gone.map((z) => z.id) } },
        data: { isActive: false },
      });
    }

    await writeAudit(db, {
      action: "COURIER_ZONES_IMPORTED",
      entityName: "CourierZone",
      entityId: FLEXTOCK,
      ctx,
      after: { courier: FLEXTOCK, zones: seen.size, created, updated, deactivated: gone.length },
    });

    return { created, updated, deactivated: gone.length };
  });
}

/* ────────────────────────────────────────────────────────── ready to ship */

/** What the driver collects: cash on delivery not yet received. */
function codOf(payments: { method: string; status: string; amount: unknown }[]): Decimal {
  return payments
    .filter((p) => p.method === "COD" && p.status === "PENDING")
    .reduce((sum, p) => sum.plus(dec(p.amount as string)), dec(0));
}

/** Why an order cannot be handed to Flextock yet. */
function problemsWith(order: {
  courierZoneId: string | null;
  shippingPhone: string | null;
  addressLine: string | null;
  recipientName: string | null;
  customer: { name: string; phone: string | null } | null;
}): string[] {
  const problems: string[] = [];
  if (!order.courierZoneId) problems.push("no delivery area");
  if (!(order.shippingPhone || order.customer?.phone)) problems.push("no phone number");
  if (!order.addressLine) problems.push("no street address");
  if (!(order.recipientName || order.customer?.name)) problems.push("no recipient name");
  return problems;
}

/**
 * Orders waiting to be handed to the courier.
 *
 * Confirmed, delivered by courier rather than collected in the shop, and not
 * already on an open shipment. Orders that cannot go yet are listed with the
 * reason, so the missing address is fixed before the handoff.
 */
export async function readyToShip(courier = FLEXTOCK) {
  const orders = await db.salesOrder.findMany({
    where: {
      status: "CONFIRMED",
      source: { in: ["MODERATOR", "SHOPIFY", "MANUAL", "WHOLESALE"] },
      shipments: { none: { status: { notIn: ["RETURNED", "FAILED"] } } },
    },
    orderBy: { orderDate: "asc" },
    take: 500,
    include: {
      customOrder: { select: { status: true } },
      customer: { select: { name: true, phone: true } },
      courierZone: { select: { governorate: true, region: true, price: true, branch: true, courier: true } },
      payments: { select: { method: true, status: true, amount: true } },
      lines: { select: { quantity: true } },
    },
  });

  return orders
    .filter((o) => o.customOrder?.status !== "DELIVERED" && (!o.courierZone || o.courierZone.courier === courier))
    .map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      orderDate: o.orderDate,
      source: o.source,
      recipient: o.recipientName || o.customer?.name || null,
      phone: o.shippingPhone || o.customer?.phone || null,
      governorate: o.courierZone?.governorate ?? o.governorate,
      region: o.courierZone?.region ?? o.city,
      addressLine: o.addressLine,
      branch: o.courierZone?.branch ?? null,
      courierPrice: o.courierZone ? dec(o.courierZone.price).toString() : null,
      pieces: o.lines.reduce((sum, l) => sum + l.quantity, 0),
      codAmount: codOf(o.payments).toString(),
      problems: problemsWith(o),
    }));
}

/**
 * Completes where an order goes, before it ships.
 *
 * Website orders arrive with the city as the customer typed it, which rarely
 * matches the courier's own area names. Somebody picks the area here; the
 * governorate follows from it. Only while the order is still waiting: a parcel
 * already handed to the courier keeps its recorded destination.
 */
export async function updateDestination(
  input: {
    salesOrderId: string;
    recipientName?: string | null;
    phone?: string | null;
    secondPhone?: string | null;
    courierZoneId: string;
    addressLine?: string | null;
  },
  ctx: AuditContext,
): Promise<{ orderNumber: string }> {
  return command("shipping.updateDestination", input, ctx, async () => {
    const order = await db.salesOrder.findUnique({
      where: { id: input.salesOrderId },
      select: {
        id: true, orderNumber: true, status: true, recipientName: true, shippingPhone: true,
        secondPhone: true, addressLine: true, courierZoneId: true, governorate: true, city: true,
        shipments: { where: { status: { notIn: ["RETURNED", "FAILED"] } }, select: { id: true } },
      },
    });
    if (!order) throw new ShippingError("That order no longer exists.");
    if (order.status !== "CONFIRMED" || order.shipments.length > 0) {
      throw new ShippingError(`${order.orderNumber} has already gone to the courier; its address cannot change here.`);
    }

    const zone = await db.courierZone.findUnique({ where: { id: input.courierZoneId } });
    if (!zone || !zone.isActive || zone.courier !== FLEXTOCK) throw new ShippingError("Choose an active Flextock delivery area.");

    const clean = (v: string | null | undefined, fallback: string | null) =>
      v === undefined ? fallback : v?.trim() || null;
    const after = {
      recipientName: clean(input.recipientName, order.recipientName),
      shippingPhone: clean(input.phone, order.shippingPhone),
      secondPhone: clean(input.secondPhone, order.secondPhone),
      addressLine: clean(input.addressLine, order.addressLine),
      courierZoneId: zone.id,
      governorate: zone.governorate,
      city: zone.region,
    };

    await db.salesOrder.update({ where: { id: order.id }, data: after });
    await writeAudit(db, {
      action: "ORDER_DESTINATION_UPDATED",
      entityName: "SalesOrder",
      entityId: order.id,
      ctx,
      before: {
        recipientName: order.recipientName, shippingPhone: order.shippingPhone,
        secondPhone: order.secondPhone, addressLine: order.addressLine,
        governorate: order.governorate, city: order.city,
      },
      after,
    });
    return { orderNumber: order.orderNumber };
  });
}

/* ──────────────────────────────────────────────────────── handoff */

/**
 * Records parcels that Flextock has accepted. Every order is checked again
 * because the list the screen showed may be minutes old.
 */
export async function createShipmentBatches(
  input: { courier?: string; salesOrderIds: string[]; acceptedByFlextock: boolean; submittedByApi?: boolean },
  ctx: AuditContext,
): Promise<{ batches: { batchId: string; batchNumber: string; branch: string; shipments: number }[] }> {
  const courier = input.courier ?? FLEXTOCK;
  return command("shipping.createShipmentBatches", { courier, salesOrderIds: [...input.salesOrderIds].sort(), submittedByApi: input.submittedByApi ?? false }, ctx, async () => {
    if (!input.acceptedByFlextock || courier !== FLEXTOCK) {
      throw new ShippingError("Confirm Flextock accepted these orders before recording a handoff.");
    }
    const ids = [...new Set(input.salesOrderIds)];
    if (ids.length === 0) throw new ShippingError("Tick the orders going out today.");

    const orders = await db.salesOrder.findMany({
      where: { id: { in: ids } },
      include: {
        customOrder: { select: { status: true } },
        customer: { select: { name: true, phone: true } },
        courierZone: true,
        payments: { select: { method: true, status: true, amount: true } },
        shipments: { where: { status: { notIn: ["RETURNED", "FAILED"] } }, select: { id: true } },
      },
    });
    if (orders.length !== ids.length) throw new ShippingError("One of those orders no longer exists.");

    for (const o of orders) {
      if (o.customOrder?.status === "DELIVERED") {
        throw new ShippingError(`${o.orderNumber} was handed to the customer in the shop.`);
      }
      if (o.status !== "CONFIRMED") {
        throw new ShippingError(`${o.orderNumber} is ${o.status.toLowerCase()}, not waiting to ship.`);
      }
      if (o.shipments.length > 0) {
        throw new ShippingError(`${o.orderNumber} is already on a shipment.`);
      }
      const problems = problemsWith(o);
      if (problems.length > 0) {
        throw new ShippingError(`${o.orderNumber} cannot go yet: ${problems.join(", ")}.`);
      }
      if (o.courierZone!.courier !== courier || !o.courierZone!.isActive) {
        throw new ShippingError(`${o.orderNumber}'s delivery area is not one this courier serves.`);
      }
    }

    const byBranch = new Map<string, typeof orders>();
    for (const o of orders) {
      const list = byBranch.get(o.courierZone!.branch) ?? [];
      list.push(o);
      byBranch.set(o.courierZone!.branch, list);
    }

    const today = new Date();
    const batches: { batchId: string; batchNumber: string; branch: string; shipments: number }[] = [];

    return db.$transaction(async (tx) => {
      for (const [branch, list] of byBranch) {
        const batchNumber = await nextDocumentNumber(tx, "SHP", today);
        const batch = await tx.shipmentBatch.create({
          data: { batchNumber, courier, branch, createdByUserId: ctx.userId },
        });

        for (const o of list) {
          await tx.shipment.create({
            data: {
              salesOrderId: o.id,
              batchId: batch.id,
              courier,
              branch,
              reference: o.orderNumber,
              apiSubmittedAt: input.submittedByApi ? today : null,
              codAmount: codOf(o.payments).toString(),
            },
          });
          await tx.salesOrder.update({
            where: { id: o.id },
            data: { status: "SHIPPED", shippedDate: today },
          });
        }

        await writeAudit(tx, {
          action: "SHIPMENT_BATCH_CREATED",
          entityName: "ShipmentBatch",
          entityId: batch.id,
          ctx,
          after: {
            batchNumber,
            courier,
            branch,
            orders: list.map((o) => o.orderNumber),
            cod: list.reduce((sum, o) => sum.plus(codOf(o.payments)), dec(0)).toString(),
          },
        });

        batches.push({ batchId: batch.id, batchNumber, branch, shipments: list.length });
      }
      return { batches };
    });
  });
}

/** Apply a confirmed Flextock status. This is the entry point for its future API. */
export async function recordFlextockStatus(
  input: {
    reference: string;
    status: ShipmentStatus;
    providerStatus?: string | null;
    trackingNumber?: string | null;
    trackingUrl?: string | null;
    collectedAmount?: string | null;
    courierFee?: string | null;
    dueToUs?: string | null;
    remittedToUs?: string | null;
    followUp?: string | null;
  },
  ctx: AuditContext,
): Promise<{ changed: boolean; delivered: boolean }> {
  return command("shipping.recordFlextockStatus", input, ctx, async () => {
    const shipment = await db.shipment.findFirst({
      where: { courier: FLEXTOCK, reference: input.reference },
      orderBy: { createdAt: "desc" },
      include: { salesOrder: { select: { id: true, status: true, orderNumber: true } } },
    });
    if (!shipment) throw new ShippingError("Flextock shipment was not found.");
    const money = (value: string | null | undefined, current: unknown) => {
      if (value === undefined) return current == null ? null : roundMoney(dec(current as string)).toString();
      if (value == null || value === "") return null;
      if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new ShippingError("Enter a non-negative amount in pounds and piastres.");
      return roundMoney(dec(value)).toString();
    };
    const collectedAmount = money(input.collectedAmount, shipment.collectedAmount);
    const courierFee = money(input.courierFee, shipment.courierFee);
    const dueToUs = money(input.dueToUs, shipment.dueToUs);
    const remittedToUs = money(input.remittedToUs, shipment.remittedToUs);
    const prepaidMismatch = dec(shipment.codAmount).isZero() &&
      [collectedAmount, dueToUs, remittedToUs].some((value) => dec(value ?? 0).greaterThan(0));
    const status: ShipmentStatus = prepaidMismatch ? "NEEDS_REVIEW" : input.status;
    const next = {
      status,
      courierStatus: input.providerStatus || input.status,
      trackingNumber: input.trackingNumber === undefined ? shipment.trackingNumber : input.trackingNumber?.slice(0, 200) || null,
      trackingUrl: input.trackingUrl === undefined ? shipment.trackingUrl :
        input.trackingUrl?.startsWith("https://") ? input.trackingUrl.slice(0, 1000) : null,
      collectedAmount,
      courierFee,
      dueToUs,
      remittedToUs,
      followUp: prepaidMismatch ? "Flextock reports collection on a prepaid parcel; verify it." :
        input.followUp === undefined ? shipment.followUp : input.followUp || null,
    };
    const changed = shipment.status !== next.status || shipment.courierStatus !== next.courierStatus ||
      shipment.trackingNumber !== next.trackingNumber || shipment.trackingUrl !== next.trackingUrl ||
      String(shipment.collectedAmount ?? "") !== String(next.collectedAmount ?? "") ||
      String(shipment.courierFee ?? "") !== String(next.courierFee ?? "") ||
      String(shipment.dueToUs ?? "") !== String(next.dueToUs ?? "") ||
      String(shipment.remittedToUs ?? "") !== String(next.remittedToUs ?? "") ||
      (shipment.followUp ?? null) !== next.followUp;
    if (!changed) return { changed: false, delivered: false };
    const now = new Date();
    await db.$transaction(async (tx) => {
      await tx.shipment.update({ where: { id: shipment.id }, data: { ...next, lastReportAt: now } });
      if (status === "DELIVERED" && shipment.salesOrder.status === "SHIPPED") {
        await tx.salesOrder.update({ where: { id: shipment.salesOrder.id }, data: { status: "DELIVERED", deliveredDate: now } });
        await tx.customOrder.updateMany({
          where: { salesOrderId: shipment.salesOrder.id, status: "READY" },
          data: { status: "DELIVERED", deliveredAt: now },
        });
      }
      await writeAudit(tx, {
        action: "SHIPMENT_STATUS_REPORTED", entityName: "Shipment", entityId: shipment.id, ctx,
        before: { status: shipment.status, courierStatus: shipment.courierStatus },
        after: { order: shipment.salesOrder.orderNumber, ...next },
      });
    });
    return { changed: true, delivered: status === "DELIVERED" && shipment.salesOrder.status === "SHIPPED" };
  });
}

/** Recent Flextock handoffs, with what each is waiting on. */
export async function shipmentBatches(limit = 30) {
  const batches = await db.shipmentBatch.findMany({
    where: { courier: FLEXTOCK },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      createdBy: { select: { name: true } },
      shipments: { select: { status: true, codAmount: true } },
    },
  });
  return batches.map((b) => ({
    id: b.id,
    batchNumber: b.batchNumber,
    courier: b.courier,
    branch: b.branch,
    createdAt: b.createdAt,
    createdBy: b.createdBy?.name ?? null,
    parcels: b.shipments.length,
    cod: b.shipments.reduce((sum, s) => sum.plus(dec(s.codAmount)), dec(0)).toString(),
    delivered: b.shipments.filter((s) => s.status === "DELIVERED").length,
    open: b.shipments.filter((s) => ["SENT", "IN_TRANSIT", "POSTPONED"].includes(s.status)).length,
  }));
}

export async function recentFlextockApiShipments(limit = 50) {
  const shipments = await db.shipment.findMany({
    where: { courier: FLEXTOCK, apiSubmittedAt: { not: null } },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true, reference: true, status: true, courierStatus: true,
      trackingNumber: true, trackingUrl: true, lastReportAt: true,
    },
  });
  return shipments;
}

/**
 * Parcels somebody has to do something about.
 *
 * Returned goods to receive at the returns desk, deliveries that came back
 * changed, and failures to chase or re-send.
 */
export async function shipmentsNeedingAttention() {
  const shipments = await db.shipment.findMany({
    where: { courier: FLEXTOCK, status: { in: ["NEEDS_REVIEW", "RETURNED", "FAILED"] } },
    orderBy: { updatedAt: "desc" },
    take: 200,
    include: {
      salesOrder: {
        select: {
          id: true,
          orderNumber: true,
          status: true,
          recipientName: true,
          customer: { select: { name: true } },
        },
      },
    },
  });
  return shipments
    // A return the desk has already recorded is dealt with.
    .filter((s) => !(s.status === "RETURNED" && s.salesOrder.status === "RETURNED"))
    .map((s) => ({
      id: s.id,
      salesOrderId: s.salesOrder.id,
      orderNumber: s.salesOrder.orderNumber,
      recipient: s.salesOrder.recipientName || s.salesOrder.customer?.name || null,
      status: s.status,
      courierStatus: s.courierStatus,
      codAmount: dec(s.codAmount).toString(),
      collected: s.collectedAmount ? dec(s.collectedAmount).toString() : null,
      followUp: s.followUp,
      updatedAt: s.updatedAt,
    }));
}

/**
 * What the courier has collected on delivered parcels and not yet paid over.
 *
 * The money itself is cleared on the reconciliation screen when it lands in
 * the bank; this is what to expect, so a short remittance is noticed.
 */
export async function courierOwesUs(courier = FLEXTOCK) {
  const shipments = await db.shipment.findMany({
    where: { courier, status: "DELIVERED" },
    select: { collectedAmount: true, codAmount: true, courierFee: true, dueToUs: true, remittedToUs: true },
  });
  let collected = dec(0);
  let fees = dec(0);
  let due = dec(0);
  let remitted = dec(0);
  for (const s of shipments) {
    collected = collected.plus(dec(s.collectedAmount ?? s.codAmount));
    fees = fees.plus(dec(s.courierFee ?? 0));
    due = due.plus(dec(s.dueToUs ?? 0));
    remitted = remitted.plus(dec(s.remittedToUs ?? 0));
  }
  return {
    parcels: shipments.length,
    collected: collected.toString(),
    fees: fees.toString(),
    due: due.toString(),
    remitted: remitted.toString(),
    outstanding: due.minus(remitted).toString(),
  };
}
