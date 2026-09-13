"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { formCommand } from "@/lib/command";
import {
  createShipmentBatches, parseCourierReport, applyCourierReport, updateDestination, ShippingError,
} from "@/lib/shipping";
import type { FormState } from "@/components/entity-form";

function toMessage(error: unknown): string {
  if (error instanceof ShippingError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have permission to hand orders to the courier.";
  console.error("Unhandled shipping error:", error);
  return "Something went wrong. Nothing was saved.";
}

export type BatchState = FormState & {
  /** The sheets just made, to download straight away. */
  batches?: { batchId: string; batchNumber: string; branch: string; shipments: number }[];
};

/** The day's orders onto the courier's sheets, one per branch. */
export async function createBatchesAction(_prev: BatchState, formData: FormData): Promise<BatchState> {
  try {
    const session = await authorize("sales_order:create");
    const salesOrderIds = formData.getAll("salesOrderId").map(String).filter(Boolean);

    const result = await formCommand("shipping.createBatches", formData, { userId: session.userId }, () =>
      createShipmentBatches({ salesOrderIds }, { userId: session.userId, reason: null }),
    );

    revalidatePath("/shipping");
    revalidatePath("/sales");
    const parcels = result.batches.reduce((sum, b) => sum + b.shipments, 0);
    return {
      success: `اتعمل ${result.batches.length} شيت لـ ${parcels} أوردر. نزّلهم وارفعهم على موقع MG من «تسجيل من الاكسيل».`,
      batches: result.batches,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

/** The courier's orders report, read back onto the shipments it describes. */
export async function uploadReportAction(_prev: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await authorize("sales_order:create");
    const file = formData.get("report") as File | null;
    if (!file || file.size === 0) {
      return { error: "اختار ملف التقرير اللي نزّلته من موقع MG («تقرير الاوردرات» ← تصدير Excel)." };
    }

    const parsed = await parseCourierReport(Buffer.from(await file.arrayBuffer()));
    if (parsed.missing.length > 0) {
      return {
        error: `الملف ده مش تقرير MG اللي بنقراه: مفيهوش عمود ${parsed.missing.join(" و")}. نزّله تاني من «تقرير الاوردرات».`,
      };
    }
    if (parsed.rows.length === 0) return { error: "التقرير فاضي — مفيش ولا شحنة فيه." };

    const result = await formCommand("shipping.courierReport", formData, { userId: session.userId }, () =>
      applyCourierReport({ rows: parsed.rows }, { userId: session.userId, reason: null }),
    );

    revalidatePath("/shipping");
    revalidatePath("/sales");

    const parts = [`اتحدّث ${result.updated} شحنة`];
    if (result.delivered > 0) parts.push(`${result.delivered} اتسلّمت`);
    if (result.unchanged > 0) parts.push(`${result.unchanged} زي ما هي`);
    if (result.needsAttention.length > 0) parts.push(`${result.needsAttention.length} محتاجة متابعة`);
    if (result.unmatched.length > 0) {
      parts.push(`${result.unmatched.length} مش بتوعنا: ${result.unmatched.slice(0, 5).join("، ")}`);
    }
    if (result.unknownStatuses.length > 0) {
      parts.push(`حالات جديدة محتاجة حد يشوفها: ${result.unknownStatuses.join("، ")}`);
    }
    return { success: parts.join(" · ") + "." };
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
