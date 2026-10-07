"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { formCommand } from "@/lib/command";
import { createShipmentBatches, updateDestination, createCourierZone, ShippingError } from "@/lib/shipping";
import { flextockApiEnabled, flextockClient, FlextockApiError } from "@/lib/flextock-api";
import { FlextockPayloadError } from "@/lib/flextock-payload";
import { submitFlextockOrder, refreshFlextockShipment } from "@/lib/flextock-shipping";
import { db } from "@/lib/db";
import type { FormState } from "@/components/entity-form";

function toMessage(error: unknown): string {
  if (error instanceof ShippingError || error instanceof FlextockApiError || error instanceof FlextockPayloadError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have permission to hand orders to the courier.";
  console.error("Unhandled shipping error:", error);
  return "Something went wrong. Nothing was saved.";
}

/** Submit selected orders through Flextock's delivery-only API. */
export async function sendFlextockAction(_prev: BatchState, formData: FormData): Promise<BatchState> {
  try {
    const session = await authorize("sales_order:create");
    if (!flextockApiEnabled()) throw new FlextockApiError("Flextock API is not enabled on this server.");
    const ids = [...new Set(formData.getAll("salesOrderId").map(String).filter(Boolean))];
    if (!ids.length || ids.length > 10) throw new ShippingError("Select 1 to 10 orders to send to Flextock.");
    const client = flextockClient();
    const batches: NonNullable<BatchState["batches"]> = [];
    for (const id of ids) {
      try {
        const result = await submitFlextockOrder(id, { userId: session.userId, reason: null }, client);
        batches.push(...result.batches);
      } catch (error) {
        const failedOrder = await db.salesOrder.findUnique({ where: { id }, select: { orderNumber: true } });
        revalidatePath("/shipping");
        revalidatePath("/sales");
        return {
          error: `${batches.length} accepted; ${failedOrder?.orderNumber ?? "the next order"} could not be confirmed: ${toMessage(error)}`,
          batches,
        };
      }
    }
    revalidatePath("/shipping");
    revalidatePath("/sales");
    return { success: `${batches.length} orders accepted by Flextock and recorded.`, batches };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function refreshFlextockAction(_prev: FormState, _formData: FormData): Promise<FormState> {
  try {
    const session = await authorize("sales_order:create");
    if (!flextockApiEnabled()) throw new FlextockApiError("Flextock API is not enabled on this server.");
    const shipments = await db.shipment.findMany({
      where: { courier: "FLEXTOCK", apiSubmittedAt: { not: null }, status: { in: ["SENT", "IN_TRANSIT", "POSTPONED", "NEEDS_REVIEW"] } },
      orderBy: { lastReportAt: "asc" },
      take: 20,
      select: { reference: true },
    });
    let updated = 0;
    const failed: string[] = [];
    const client = flextockClient();
    for (const shipment of shipments) {
      try {
        if ((await refreshFlextockShipment(shipment.reference, { userId: session.userId, reason: null }, client)).changed) updated++;
      } catch {
        failed.push(shipment.reference);
      }
    }
    revalidatePath("/shipping");
    revalidatePath("/sales");
    return { success: `${updated} shipment statuses updated; ${failed.length} need checking with Flextock${failed.length ? ` (${failed.join(", ")})` : ""}.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

/** Add a confirmed Flextock delivery area from an order or the shipping desk. */
export async function createCourierZoneAction(input: { governorate: string; region: string; price: string }) {
  try {
    const session = await authorize("sales_order:create");
    const zone = await createCourierZone(input, { userId: session.userId, reason: null });
    revalidatePath("/moderator");
    revalidatePath("/shipping");
    return { ok: true as const, zone };
  } catch (error) {
    return { ok: false as const, message: toMessage(error) };
  }
}

export type BatchState = FormState & {
  /** The recorded handoff batches. */
  batches?: { batchId: string; batchNumber: string; branch: string; shipments: number }[];
};

/** Record orders only after Flextock accepts them. */
export async function createBatchesAction(_prev: BatchState, formData: FormData): Promise<BatchState> {
  try {
    const session = await authorize("sales_order:create");
    const salesOrderIds = formData.getAll("salesOrderId").map(String).filter(Boolean);

    const result = await formCommand("shipping.createBatches", formData, { userId: session.userId }, () =>
      createShipmentBatches({ salesOrderIds, acceptedByFlextock: formData.get("acceptedByFlextock") === "yes" }, { userId: session.userId, reason: null }),
    );

    revalidatePath("/shipping");
    revalidatePath("/sales");
    const parcels = result.batches.reduce((sum, b) => sum + b.shipments, 0);
    return {
      success: `اتسجل تسليم ${parcels} أوردر لـ Flextock في ${result.batches.length} دفعة.`,
      batches: result.batches,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

/** Completes where an order goes — for website orders whose city matched no area. */
export async function updateDestinationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await authorize("sales_order:create");
    const text = (name: string) => {
      const value = formData.get(name);
      return typeof value === "string" ? value : undefined;
    };
    const result = await formCommand("shipping.destination", formData, { userId: session.userId }, () =>
      updateDestination(
        {
          salesOrderId: String(formData.get("salesOrderId") ?? ""),
          courierZoneId: String(formData.get("courierZoneId") ?? ""),
          recipientName: text("recipientName"),
          phone: text("shippingPhone"),
          secondPhone: text("secondPhone"),
          addressLine: text("addressLine"),
        },
        { userId: session.userId, reason: null },
      ),
    );
    revalidatePath("/shipping");
    return { success: `${result.orderNumber} جاهز يتشحن.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
