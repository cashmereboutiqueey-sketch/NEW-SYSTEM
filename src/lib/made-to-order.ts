import "server-only";
import { db } from "./db";
import { command } from "./command";
import { type AuditContext } from "./audit";
import { dec } from "./money";
import { makeabilityFrom, type MaterialNeed, type Makeability } from "@/core/makeability";
import { takeCustomOrder, linkProductionOrder, CustomOrderError } from "./custom-orders";
import { createProductionOrder } from "./production";

/**
 * Somebody asks for a garment the shop has not got.
 *
 * There are only three answers and the shop floor should not have to work out
 * which one applies. It is on the shelf, so sell it. It is not, but the cloth
 * is there, so promise it and put it on the line. Or the cloth is not there
 * either, in which case the honest thing is to say so before taking money.
 *
 * This module answers the second and third, and it deliberately does not
 * shorten the path between them. A moderator who can turn a message into a
 * production run in one click still produces an ordinary custom order and an
 * ordinary run: the deposit is a liability, the run is costed against the
 * minute rate, and the piece becomes a sale on the day it is handed over.
 * Nothing about a bespoke garment is allowed to be cheaper to account for
 * than a batch of two hundred.
 */

export type StyleMakeability = Makeability & {
  styleId: string;
  /** Without a bill there is nothing to explode and no run can be raised. */
  hasBom: boolean;
  /** Without operations there is no SMV, and `createProductionOrder` refuses. */
  hasOperations: boolean;
  /** Named for the screen, so it can say which material to go and buy. */
  materials: {
    materialId: string;
    code: string;
    nameAr: string;
    nameEn: string;
    uom: string;
    perUnit: string;
    onHand: string;
    makes: number;
  }[];
};

/**
 * What the factory could cut today, style by style.
 *
 * Every style at once rather than one at a time: the screen offering this has
 * to label a whole product list, and asking per style would be one query per
 * row. Raw material is counted wherever the factory holds it, because cloth
 * in the other store is still cloth.
 */
export async function makeabilityByStyle(): Promise<Map<string, StyleMakeability>> {
  const [styles, lots] = await Promise.all([
    db.style.findMany({
      select: {
        id: true,
        plannedWasteRate: true,
        bomLines: {
          select: {
            materialId: true,
            standardConsumption: true,
            wasteRateOverride: true,
            material: {
              select: { code: true, nameAr: true, nameEn: true, uom: { select: { code: true } } },
            },
          },
        },
        _count: { select: { operations: true } },
      },
    }),
    db.inventoryLot.groupBy({
      by: ["materialId"],
      where: {
        state: "RAW_MATERIAL",
        remainingQty: { gt: 0 },
        materialId: { not: null },
        entity: { kind: "FACTORY" },
      },
      _sum: { remainingQty: true },
    }),
  ]);

  const onHand = new Map<string, string>(
    lots.map((l) => [l.materialId!, (l._sum.remainingQty ?? dec(0)).toString()]),
  );

  const out = new Map<string, StyleMakeability>();
  for (const style of styles) {
    const needs: MaterialNeed[] = style.bomLines.map((l) => ({
      materialId: l.materialId,
      materialCode: l.material.code,
      standardConsumption: l.standardConsumption.toString(),
      wasteRate: (l.wasteRateOverride ?? style.plannedWasteRate).toString(),
    }));

    const verdict = makeabilityFrom(needs, onHand);
    const byId = new Map(style.bomLines.map((l) => [l.materialId, l.material]));

    out.set(style.id, {
      ...verdict,
      styleId: style.id,
      hasBom: style.bomLines.length > 0,
      hasOperations: style._count.operations > 0,
      materials: verdict.lines.map((l) => ({
        materialId: l.materialId,
        code: l.materialCode,
        nameAr: byId.get(l.materialId)?.nameAr ?? l.materialCode,
        nameEn: byId.get(l.materialId)?.nameEn ?? l.materialCode,
        uom: byId.get(l.materialId)?.uom.code ?? "",
        perUnit: l.perUnit.toString(),
        onHand: l.onHand.toString(),
        makes: Number.isFinite(l.makes) ? l.makes : -1,
      })),
    });
  }
  return out;
}

/** The same verdict for one style, for a screen that only needs the one. */
export async function makeabilityOfStyle(styleId: string): Promise<StyleMakeability | null> {
  return (await makeabilityByStyle()).get(styleId) ?? null;
}

/**
 * Takes the promise and, where the cloth allows it, raises the run in the
 * same breath.
 *
 * One command, so a run without an order or an order whose run half-exists
 * cannot be left behind by a failure between the two.
 *
 * The run is raised as a draft and not confirmed. Confirming freezes the cost
 * basis against a minute-rate period, which is a decision about a month and
 * belongs to whoever costs the factory — not to a moderator answering a
 * message. The order says `IN_PRODUCTION` because a run exists for it; the
 * factory starts it the way it starts everything else.
 */
export async function takeOrderToMake(
  input: {
    customerId: string;
    variantId: string;
    quantity: number;
    agreedUnitPrice: string;
    deposit?: { amount: string; method: "CASH" | "CARD" | "BANK_TRANSFER" | "INSTAPAY" } | null;
    entityId: string;
    locationId: string;
    promisedDate?: Date | null;
    orderDate: Date;
    notes?: string | null;
    /** Off when the shop wants the promise on the books and the run decided later. */
    raiseRun: boolean;
  },
  ctx: AuditContext,
): Promise<{
  customOrderId: string;
  orderNumber: string;
  agreedTotal: string;
  deposit: string;
  runNumber: string | null;
  /** Said plainly when no run was raised, so the screen never implies one was. */
  runSkippedBecause: string | null;
}> {
  return command("made-to-order.takeOrderToMake", input, ctx, async () => {
    const variant = await db.variant.findUnique({
      where: { id: input.variantId },
      select: { id: true, styleId: true },
    });
    if (!variant) throw new CustomOrderError("That style, colour and size does not exist.");

    // Read before anything is written: a promise the factory cannot start is
    // still a promise worth recording, but the person taking it has to be
    // told, and told before the customer is.
    const verdict = await makeabilityOfStyle(variant.styleId);

    const order = await takeCustomOrder(
      {
        customerId: input.customerId,
        variantId: input.variantId,
        quantity: input.quantity,
        agreedUnitPrice: input.agreedUnitPrice,
        deposit: input.deposit ?? null,
        entityId: input.entityId,
        locationId: input.locationId,
        promisedDate: input.promisedDate ?? null,
        orderDate: input.orderDate,
        notes: input.notes ?? null,
      },
      ctx,
    );

    let runSkippedBecause: string | null = null;
    if (!input.raiseRun) {
      runSkippedBecause = "No run was asked for.";
    } else if (!verdict || !verdict.hasBom) {
      runSkippedBecause = "This style has no bill of materials, so no run can be raised against it.";
    } else if (!verdict.hasOperations) {
      runSkippedBecause = "This style has no operations, so it has no SMV and no run can be raised.";
    } else if (verdict.makeable < input.quantity) {
      const short = verdict.limitedBy;
      runSkippedBecause = short
        ? `The cloth on hand makes ${verdict.makeable}, not ${input.quantity}. ${short.materialCode} runs out first.`
        : `The cloth on hand makes ${verdict.makeable}, not ${input.quantity}.`;
    }

    const taken = {
      customOrderId: order.id,
      orderNumber: order.orderNumber,
      agreedTotal: order.agreedTotal,
      deposit: order.deposit,
    };

    if (runSkippedBecause) {
      return { ...taken, runNumber: null, runSkippedBecause };
    }

    const run = await createProductionOrder(
      {
        styleId: variant.styleId,
        plannedQty: input.quantity,
        orderDate: input.orderDate,
        plannedFinish: input.promisedDate ?? null,
        lines: [{ variantId: input.variantId, plannedQty: input.quantity }],
        notes: `Made to order against ${order.orderNumber}`,
      },
      ctx,
    );

    await linkProductionOrder(
      { customOrderId: order.id, productionOrderId: run.productionOrderId },
      ctx,
    );

    return { ...taken, runNumber: run.orderNumber, runSkippedBecause: null };
  });
}
