import "server-only";
import ExcelJS from "exceljs";
import { db } from "./db";
import { dec, roundMoney, type Decimal } from "./money";
import { nextDocumentNumber } from "./ledger";
import { writeAudit, type AuditContext } from "./audit";
import { command } from "./command";
import type { ShipmentStatus } from "@/generated/prisma/client";

/**
 * Handing parcels to the courier, and hearing back from it.
 *
 * MG Express has no API. Somebody used to type every social order into its
 * portal by hand, from a system that already held every one of them. What it
 * does have is an import: an Excel sheet in its own template, one file per
 * branch. And it reports back through an orders report its portal exports.
 *
 * So shipping is two sheets. Out: the day's orders, written in the courier's
 * template exactly, so nobody retypes them. In: the courier's report, read
 * back and matched by shipment number — which is the order number, because
 * that is what went out.
 */

export class ShippingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShippingError";
  }
}

export const MG_EXPRESS = "MG_EXPRESS";

/** The courier's branches, by the codes its import screen uses. */
export const MG_BRANCHES: Record<string, string> = {
  "1": "MG Express",
  "5": "MG Cairo",
};

/* ───────────────────────────────────────────────────────────────── zones */

/** Every area the courier serves, grouped for a governorate-then-area picker. */
export async function courierZones(courier = MG_EXPRESS) {
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

/**
 * Loads the courier's price list.
 *
 * An area the courier dropped is deactivated rather than deleted: orders sent
 * there last month still point at it, and deleting it would take their
 * delivery area with it.
 */
export async function importCourierZones(
  input: {
    courier: string;
    zones: { governorate: string; region: string; price: number | string }[];
    /** Which branch serves a governorate. */
    branchFor: (governorate: string) => string;
  },
  ctx: AuditContext,
): Promise<{ created: number; updated: number; deactivated: number }> {
  return command("shipping.importCourierZones", { courier: input.courier, count: input.zones.length }, ctx, async () => {
    const existing = await db.courierZone.findMany({ where: { courier: input.courier } });
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
      const branch = input.branchFor(governorate);
      const found = byKey.get(key);
      if (!found) {
        await db.courierZone.create({
          data: { courier: input.courier, governorate, region, price, branch },
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
      entityId: input.courier,
      ctx,
      after: { courier: input.courier, zones: seen.size, created, updated, deactivated: gone.length },
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

/** Why an order cannot go on today's sheet, in words somebody can act on. */
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
 * reason, so the missing address is fixed before the sheet is made rather
 * than discovered when the courier's import rejects the row.
 */
export async function readyToShip(courier = MG_EXPRESS) {
  const orders = await db.salesOrder.findMany({
    where: {
      status: "CONFIRMED",
      source: { in: ["MODERATOR", "SHOPIFY", "MANUAL", "WHOLESALE"] },
      shipments: { none: { status: { notIn: ["RETURNED", "FAILED"] } } },
    },
    orderBy: { orderDate: "asc" },
    take: 500,
    include: {
      customer: { select: { name: true, phone: true } },
      courierZone: { select: { governorate: true, region: true, price: true, branch: true, courier: true } },
      payments: { select: { method: true, status: true, amount: true } },
      lines: { select: { quantity: true } },
    },
  });

  return orders
    .filter((o) => !o.courierZone || o.courierZone.courier === courier)
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
 * already on the courier's sheet goes where that sheet said.
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
    if (!zone || !zone.isActive) throw new ShippingError("Choose one of the courier's areas.");

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

/* ──────────────────────────────────────────────────────── the day's sheet */

/**
 * Puts orders on shipments, one batch per courier branch.
 *
 * The courier's import takes one branch per file, so a day's parcels for
 * Cairo and for Alexandria are two sheets. Every order is checked again here:
 * the list the screen showed may be minutes old, and an order that went out
 * on another sheet meanwhile must not go out twice.
 */
export async function createShipmentBatches(
  input: { courier?: string; salesOrderIds: string[] },
  ctx: AuditContext,
): Promise<{ batches: { batchId: string; batchNumber: string; branch: string; shipments: number }[] }> {
  const courier = input.courier ?? MG_EXPRESS;
  return command("shipping.createShipmentBatches", { courier, salesOrderIds: [...input.salesOrderIds].sort() }, ctx, async () => {
    const ids = [...new Set(input.salesOrderIds)];
    if (ids.length === 0) throw new ShippingError("Tick the orders going out today.");

    const orders = await db.salesOrder.findMany({
      where: { id: { in: ids } },
      include: {
        customer: { select: { name: true, phone: true } },
        courierZone: true,
        payments: { select: { method: true, status: true, amount: true } },
        shipments: { where: { status: { notIn: ["RETURNED", "FAILED"] } }, select: { id: true } },
      },
    });
    if (orders.length !== ids.length) throw new ShippingError("One of those orders no longer exists.");

    for (const o of orders) {
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
            branch: MG_BRANCHES[branch] ?? branch,
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

/** The columns of MG Express's import template, in its order, both header rows. */
const MG_COLUMNS: [key: string, label: string][] = [
  ["م", "1"],
  ["CustName", "المرسل اليه"],
  ["Company", "العميل"],
  ["subComp", "عميل فرعى"],
  ["Cost", "التكلفة"],
  ["Weight", "الوزن"],
  ["Parcode", "رقم الشحنة"],
  ["Phone", "الهاتف"],
  ["SecPhone", "هاتف آخر"],
  ["City", "المحافظة"],
  ["Region", "المدينة"],
  ["address", "العنوان"],
  ["createdDate", "التاريخ"],
  ["Notes", "ملحوظة"],
  ["Replacing", "استبدال"],
  ["OrderContent", "محتوى الأوردر"],
  ["PiecesNum", "عدد القطع"],
  ["EmpName", "المندوب"],
];

/**
 * A batch as the courier's import expects it.
 *
 * Two header rows exactly as its own template has them — its English keys,
 * then its Arabic labels — and one row per parcel. Nothing is added: an extra
 * column is a column its import may refuse the whole file over.
 */
export async function manifestWorkbook(batchId: string): Promise<{ fileName: string; data: Buffer }> {
  const batch = await db.shipmentBatch.findUnique({
    where: { id: batchId },
    include: {
      shipments: {
        orderBy: { reference: "asc" },
        include: {
          salesOrder: {
            include: {
              customer: { select: { name: true, phone: true } },
              courierZone: { select: { governorate: true, region: true } },
              lines: {
                select: {
                  quantity: true,
                  variant: {
                    select: {
                      sku: true,
                      style: { select: { nameAr: true } },
                      colorCode: { select: { nameAr: true } },
                      sizeCode: { select: { code: true } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!batch) throw new ShippingError("That shipment batch no longer exists.");

  const company = (await db.setting.findUnique({ where: { key: "courier.mg.companyName" } }))?.value ?? "cashmere";

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1", { views: [{ rightToLeft: true }] });
  sheet.addRow(MG_COLUMNS.map(([key]) => key));
  sheet.addRow(MG_COLUMNS.map(([, label], i) => (i === 0 ? 1 : label)));

  batch.shipments.forEach((s, i) => {
    const o = s.salesOrder;
    const content = o.lines
      .map((l) => {
        const v = l.variant;
        const name = [v.style?.nameAr, v.colorCode?.nameAr, v.sizeCode?.code].filter(Boolean).join(" ");
        return `${l.quantity}× ${name || v.sku}`;
      })
      .join(" + ");
    const row = sheet.addRow([
      i + 1,
      o.recipientName || o.customer?.name || "",
      company,
      "",
      Number(dec(s.codAmount).toFixed(2)),
      "",
      s.reference,
      o.shippingPhone || o.customer?.phone || "",
      o.secondPhone || "",
      o.courierZone?.governorate ?? o.governorate ?? "",
      o.courierZone?.region ?? o.city ?? "",
      o.addressLine ?? "",
      o.shippedDate ?? batch.createdAt,
      o.notes ?? "",
      "",
      content,
      o.lines.reduce((sum, l) => sum + l.quantity, 0),
      "",
    ]);
    // The courier writes dates day first; its own file names do.
    row.getCell(13).numFmt = "dd/mm/yyyy";
    // Phone numbers as text: a leading zero dropped is a number nobody answers.
    row.getCell(8).numFmt = "@";
    row.getCell(9).numFmt = "@";
  });

  const branchName = (MG_BRANCHES[batch.branch] ?? batch.branch).replace(/\s+/g, "-");
  const fileName = `${branchName}_${batch.batchNumber}.xlsx`;
  const data = Buffer.from(await workbook.xlsx.writeBuffer());
  return { fileName, data };
}

/* ─────────────────────────────────────────────── hearing back from them */

/** Arabic as the courier's report spells it, made comparable. */
function normalise(text: string): string {
  return text
    .replace(/[ً-ْ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The courier's statuses, in what they mean here.
 *
 * Anything that moves money or stock beyond a plain delivery — a partial
 * return, a changed price, an exchange — is a thing to look at, not a thing to
 * do automatically. The courier's word says what happened at the door; the
 * returns desk says what came back.
 */
const MG_STATUS: [pattern: string, status: ShipmentStatus][] = [
  ["اوردر بيك اب", "IN_TRANSIT"],
  ["تم استلام بيك اب", "IN_TRANSIT"],
  ["قيد التوصيل", "IN_TRANSIT"],
  ["المسلمة ودفع كامل", "DELIVERED"],
  ["المسلمة ومرتجع جزئي", "NEEDS_REVIEW"],
  ["المسلمة وتعديل السعر", "NEEDS_REVIEW"],
  ["استبدال", "NEEDS_REVIEW"],
  ["مرتجع ودفع الشحن", "RETURNED"],
  ["مرتجع ولم يدفع الشحن", "RETURNED"],
  ["فشل التسليم", "FAILED"],
  ["تهرب بعد وصول المندوب", "FAILED"],
  ["مؤجل", "POSTPONED"],
];

export function mgStatus(text: string): ShipmentStatus | null {
  const n = normalise(text);
  const exact = MG_STATUS.find(([pattern]) => normalise(pattern) === n);
  return exact ? exact[1] : null;
}

/** One row of the courier's orders report, by the columns this reads. */
export type CourierReportRow = {
  reference: string;
  status: string;
  collected?: string | number | null;
  fee?: string | number | null;
  dueToUs?: string | number | null;
  remittedToUs?: string | number | null;
  attempts?: string | number | null;
  followUp?: string | null;
};

const REPORT_HEADERS: Record<keyof CourierReportRow, string[]> = {
  reference: ["رقم الشحنة"],
  status: ["الحالة", "حالة الأوردر", "حالة الاوردر"],
  collected: ["المدفوع", "التحصيل"],
  fee: ["الشحن"],
  dueToUs: ["المستحق للعميل"],
  remittedToUs: ["الدفع للعميل", "دفع للعميل"],
  attempts: ["مرات الشحن"],
  followUp: ["رد المتابعة"],
};

/** A table of text, whatever file it came out of. */
function rowsFromTable(table: string[][]): { rows: CourierReportRow[]; missing: string[] } {
  const headerIndex = table.findIndex((row) =>
    row.some((cell) => REPORT_HEADERS.reference.some((h) => normalise(cell) === normalise(h))),
  );
  if (headerIndex < 0) return { rows: [], missing: ["رقم الشحنة"] };

  const header = table[headerIndex].map(normalise);
  const column = (names: string[]) => header.findIndex((cell) => names.some((n) => normalise(n) === cell));
  const at = Object.fromEntries(
    (Object.keys(REPORT_HEADERS) as (keyof CourierReportRow)[]).map((k) => [k, column(REPORT_HEADERS[k])]),
  ) as Record<keyof CourierReportRow, number>;

  const missing = (["reference", "status"] as const).filter((k) => at[k] < 0).map((k) => REPORT_HEADERS[k][0]);
  if (missing.length > 0) return { rows: [], missing };

  const cell = (row: string[], i: number) => (i >= 0 ? (row[i] ?? "").trim() : "");
  const rows = table
    .slice(headerIndex + 1)
    .map((row) => ({
      reference: cell(row, at.reference),
      status: cell(row, at.status),
      collected: cell(row, at.collected) || null,
      fee: cell(row, at.fee) || null,
      dueToUs: cell(row, at.dueToUs) || null,
      remittedToUs: cell(row, at.remittedToUs) || null,
      attempts: cell(row, at.attempts) || null,
      followUp: cell(row, at.followUp) || null,
    }))
    .filter((r) => r.reference);
  return { rows, missing: [] };
}

/**
 * Reads the courier's orders report, as its portal exports it.
 *
 * Portals like this one often "export to Excel" by sending an HTML table with
 * a spreadsheet's name, so both a real workbook and an HTML table are read.
 * Columns are found by their Arabic headers rather than by position: a column
 * added to the courier's report must not shift every figure one to the left.
 */
export async function parseCourierReport(file: Buffer): Promise<{ rows: CourierReportRow[]; missing: string[] }> {
  const head = file.subarray(0, 512).toString("utf8").toLowerCase();
  if (head.includes("<table") || head.includes("<html") || head.includes("<tr")) {
    const html = file.toString("utf8");
    const table = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
      [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
        c[1].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim(),
      ),
    );
    return rowsFromTable(table);
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(file as unknown as ArrayBuffer);
  } catch {
    throw new ShippingError("That file is not a report this can read. Export it again from the courier's portal.");
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) return { rows: [], missing: ["رقم الشحنة"] };
  const table: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values as unknown[];
    table.push(
      values.slice(1).map((v) => {
        if (v == null) return "";
        if (typeof v === "object" && v !== null && "text" in v) return String((v as { text: unknown }).text);
        if (typeof v === "object" && v !== null && "result" in v) return String((v as { result: unknown }).result);
        return String(v);
      }),
    );
  });
  return rowsFromTable(table);
}

function amount(value: string | number | null | undefined): string | null {
  if (value == null || value === "") return null;
  const cleaned = String(value).replace(/[^\d.\-]/g, "");
  if (!cleaned || Number.isNaN(Number(cleaned))) return null;
  return roundMoney(dec(cleaned)).toString();
}

/**
 * Applies what the courier's report says.
 *
 * Matched by shipment number, which is the order number. A plain delivery
 * marks the order delivered. Anything else that changes what happened to the
 * goods or the money is recorded and listed for somebody to settle — the
 * system does not restock a garment or refund a customer because a courier's
 * status column said a word.
 *
 * Reading the same report twice changes nothing the second time.
 */
export async function applyCourierReport(
  input: { courier?: string; rows: CourierReportRow[] },
  ctx: AuditContext,
): Promise<{
  updated: number;
  unchanged: number;
  delivered: number;
  needsAttention: string[];
  unmatched: string[];
  unknownStatuses: string[];
}> {
  const courier = input.courier ?? MG_EXPRESS;
  return command("shipping.applyCourierReport", { courier, rows: input.rows }, ctx, async () => {
    let updated = 0;
    let unchanged = 0;
    let delivered = 0;
    const needsAttention: string[] = [];
    const unmatched: string[] = [];
    const unknownStatuses = new Set<string>();
    const now = new Date();

    for (const row of input.rows) {
      const shipment = await db.shipment.findFirst({
        where: { courier, reference: row.reference },
        orderBy: { createdAt: "desc" },
        include: { salesOrder: { select: { id: true, status: true, orderNumber: true } } },
      });
      if (!shipment) {
        unmatched.push(row.reference);
        continue;
      }

      const mapped = mgStatus(row.status);
      if (!mapped) unknownStatuses.add(row.status);
      // A word this does not know is not a delivery; somebody reads it.
      const status: ShipmentStatus = mapped ?? "NEEDS_REVIEW";

      const next = {
        status,
        courierStatus: row.status || null,
        collectedAmount: amount(row.collected),
        courierFee: amount(row.fee),
        dueToUs: amount(row.dueToUs),
        remittedToUs: amount(row.remittedToUs),
        attempts: row.attempts != null && row.attempts !== "" ? Number(String(row.attempts).replace(/\D/g, "")) || 0 : null,
        followUp: row.followUp || null,
      };

      const same =
        shipment.status === next.status &&
        shipment.courierStatus === next.courierStatus &&
        String(shipment.collectedAmount ?? "") === String(next.collectedAmount ?? "") &&
        String(shipment.courierFee ?? "") === String(next.courierFee ?? "") &&
        String(shipment.dueToUs ?? "") === String(next.dueToUs ?? "") &&
        String(shipment.remittedToUs ?? "") === String(next.remittedToUs ?? "") &&
        (shipment.attempts ?? null) === next.attempts &&
        (shipment.followUp ?? null) === next.followUp;

      if (same) {
        unchanged += 1;
      } else {
        await db.shipment.update({
          where: { id: shipment.id },
          data: { ...next, lastReportAt: now },
        });

        if (status === "DELIVERED" && shipment.salesOrder.status === "SHIPPED") {
          await db.salesOrder.update({
            where: { id: shipment.salesOrder.id },
            data: { status: "DELIVERED", deliveredDate: now },
          });
          delivered += 1;
        }

        await writeAudit(db, {
          action: "SHIPMENT_STATUS_REPORTED",
          entityName: "Shipment",
          entityId: shipment.id,
          ctx,
          before: { status: shipment.status, courierStatus: shipment.courierStatus },
          after: { order: shipment.salesOrder.orderNumber, ...next },
        });
        updated += 1;
      }

      if (status === "NEEDS_REVIEW" || status === "RETURNED") {
        needsAttention.push(`${row.reference}: ${row.status}`);
      }
    }

    return {
      updated,
      unchanged,
      delivered,
      needsAttention,
      unmatched,
      unknownStatuses: [...unknownStatuses],
    };
  });
}

/* ───────────────────────────────────────────────────────── the screen */

/** Recent sheets, with what each is waiting on. */
export async function shipmentBatches(limit = 30) {
  const batches = await db.shipmentBatch.findMany({
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
    branch: MG_BRANCHES[b.branch] ?? b.branch,
    createdAt: b.createdAt,
    createdBy: b.createdBy?.name ?? null,
    parcels: b.shipments.length,
    cod: b.shipments.reduce((sum, s) => sum.plus(dec(s.codAmount)), dec(0)).toString(),
    delivered: b.shipments.filter((s) => s.status === "DELIVERED").length,
    open: b.shipments.filter((s) => ["SENT", "IN_TRANSIT", "POSTPONED"].includes(s.status)).length,
  }));
}

/**
 * Parcels somebody has to do something about.
 *
 * Returned goods to receive at the returns desk, deliveries that came back
 * changed, and failures to chase or re-send.
 */
export async function shipmentsNeedingAttention() {
  const shipments = await db.shipment.findMany({
    where: { status: { in: ["NEEDS_REVIEW", "RETURNED", "FAILED"] } },
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
export async function courierOwesUs(courier = MG_EXPRESS) {
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
