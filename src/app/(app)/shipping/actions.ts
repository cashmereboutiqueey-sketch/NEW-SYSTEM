"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { formCommand } from "@/lib/command";
import { createShipmentBatches, updateDestination, createCourierZone, ShippingError } from "@/lib/shipping";
import type { FormState } from "@/components/entity-form";

function toMessage(error: unknown): string {
  if (error instanceof ShippingError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have permission to hand orders to the courier.";
  console.error("Unhandled shipping error:", error);
  return "Something went wrong. Nothing was saved.";
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
