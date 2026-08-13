import "server-only";
import { z } from "zod";
import { db } from "./db";
import { dec, safeDiv, type Decimal } from "./money";
import { nextDocumentNumber } from "./ledger";
import { writeAudit, type AuditContext } from "./audit";

/**
 * The cutting ticket — what was laid on the table and what came off it.
 *
 * Material issues already carried a `cuttingTicketId` and nothing ever created
 * a ticket, so the column was always null and the link went nowhere.
 *
 * It matters because it is the only place fabric utilisation can actually be
 * measured. A bill of materials says a garment should take 2.3 metres; the
 * cutting table says what a lay of forty plies at 9.4 metres really produced.
 * The gap between the two is the marker, and it is usually the largest single
 * saving available in a garment factory — but it is invisible unless somebody
 * writes down the lay alongside the pieces.
 *
 * No journal. The fabric is costed when it is issued, and the ticket describes
 * how it was used rather than moving any money.
 */

export class CuttingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CuttingError";
  }
}

const ticketSchema = z.object({
  productionOrderId: z.string().min(1),
  cutDate: z.coerce.date(),
  piecesCut: z.coerce.number().int().positive("A cutting ticket records pieces that were cut."),
  /** Metres of the marker — one length of the lay. */
  markerLengthM: z.coerce.number().positive().nullable().optional(),
  /** How many layers were stacked under it. */
  plies: z.coerce.number().int().positive().nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

export type CreateTicketInput = z.input<typeof ticketSchema>;

export async function createCuttingTicket(input: CreateTicketInput, ctx: AuditContext) {
  const data = ticketSchema.parse(input);

  const order = await db.productionOrder.findUnique({
    where: { id: data.productionOrderId },
    select: { id: true, orderNumber: true, plannedQty: true },
  });
  if (!order) throw new CuttingError("Production order not found.");

  return db.$transaction(async (tx) => {
    const ticketNumber = await nextDocumentNumber(tx, "CUT", data.cutDate);

    const ticket = await tx.cuttingTicket.create({
      data: {
        ticketNumber,
        productionOrderId: data.productionOrderId,
        cutDate: data.cutDate,
        markerLengthM: data.markerLengthM?.toString() ?? null,
        plies: data.plies ?? null,
        piecesCut: data.piecesCut,
        notes: data.notes ?? null,
      },
    });

    await writeAudit(tx, {
      action: "CUTTING_TICKET_CREATED",
      entityName: "CuttingTicket",
      entityId: ticket.id,
      ctx,
      after: {
        ticketNumber,
        order: order.orderNumber,
        piecesCut: data.piecesCut,
        markerLengthM: data.markerLengthM ?? null,
        plies: data.plies ?? null,
      },
    });

    return {
      cuttingTicketId: ticket.id,
      ticketNumber,
      /** Metres laid on the table, when both halves of the lay are known. */
      fabricLaid:
        data.markerLengthM != null && data.plies != null
          ? dec(data.markerLengthM).times(data.plies).toString()
          : null,
    };
  });
}

/**
 * What the cutting room actually got out of the cloth.
 *
 * Utilisation is metres per garment as cut, against metres per garment as
 * costed. Better than the standard means the marker beat the bill of
 * materials; worse means the run is quietly eating the margin it was priced
 * with.
 */
export async function cuttingReport(sinceDays = 180) {
  const since = new Date();
  since.setDate(since.getDate() - sinceDays);

  const tickets = await db.cuttingTicket.findMany({
    where: { cutDate: { gte: since } },
    include: {
      issues: { include: { material: { select: { code: true, nameAr: true, nameEn: true } } } },
      productionOrder: {
        select: {
          id: true, orderNumber: true, plannedQty: true,
          style: {
            select: {
              code: true, nameAr: true, nameEn: true, plannedWasteRate: true,
              bomLines: {
                where: { material: { type: "FABRIC" } },
                select: { standardConsumption: true },
              },
            },
          },
        },
      },
    },
    orderBy: { cutDate: "desc" },
  });

  const rows = tickets.map((t) => {
    const laid =
      t.markerLengthM != null && t.plies != null
        ? dec(t.markerLengthM).times(t.plies)
        : null;

    // What actually left the store against this ticket. More reliable than the
    // lay when only part of it was cut from one roll.
    const issued = t.issues.reduce((s, i) => s.plus(dec(i.actualQty)), dec(0));
    const consumed = issued.greaterThan(0) ? issued : laid;

    const standardPerPiece = t.productionOrder.style.bomLines
      .reduce((s, b) => s.plus(dec(b.standardConsumption)), dec(0))
      .times(dec(t.productionOrder.style.plannedWasteRate).plus(1));

    const actualPerPiece = t.piecesCut > 0 && consumed ? consumed.div(t.piecesCut) : null;

    return {
      id: t.id,
      ticketNumber: t.ticketNumber,
      cutDate: t.cutDate,
      orderNumber: t.productionOrder.orderNumber,
      styleCode: t.productionOrder.style.code,
      styleAr: t.productionOrder.style.nameAr,
      styleEn: t.productionOrder.style.nameEn,
      piecesCut: t.piecesCut,
      markerLengthM: t.markerLengthM?.toString() ?? null,
      plies: t.plies,
      fabricLaid: laid?.toString() ?? null,
      fabricIssued: issued.greaterThan(0) ? issued.toString() : null,
      standardPerPiece: standardPerPiece.greaterThan(0) ? standardPerPiece.toString() : null,
      actualPerPiece: actualPerPiece?.toString() ?? null,
      /**
       * Above 1 means the cut used more cloth than the costing allowed for,
       * which is margin leaving the building a metre at a time.
       */
      utilisation:
        actualPerPiece && standardPerPiece.greaterThan(0)
          ? actualPerPiece.div(standardPerPiece)
          : null,
      issues: t.issues.length,
      notes: t.notes,
    };
  });

  const measured = rows.filter((r) => r.utilisation != null);
  const overStandard = measured.filter((r) => Number(r.utilisation) > 1);

  return {
    rows,
    totals: {
      tickets: rows.length,
      piecesCut: rows.reduce((n, r) => n + r.piecesCut, 0),
      measured: measured.length,
      overStandard: overStandard.length,
      averageUtilisation:
        measured.length > 0
          ? measured
              .reduce((t, r) => t.plus(r.utilisation as Decimal), dec(0))
              .div(measured.length)
          : null,
    },
  };
}

/** Tickets that material can still be issued against. */
export async function openTickets(productionOrderId?: string | null) {
  const tickets = await db.cuttingTicket.findMany({
    where: productionOrderId ? { productionOrderId } : {},
    include: {
      productionOrder: {
        select: { orderNumber: true, style: { select: { nameAr: true, nameEn: true } } },
      },
    },
    orderBy: { cutDate: "desc" },
    take: 50,
  });

  return tickets.map((t) => ({
    id: t.id,
    ticketNumber: t.ticketNumber,
    orderNumber: t.productionOrder.orderNumber,
    styleAr: t.productionOrder.style.nameAr,
    styleEn: t.productionOrder.style.nameEn,
    piecesCut: t.piecesCut,
    cutDate: t.cutDate,
  }));
}
