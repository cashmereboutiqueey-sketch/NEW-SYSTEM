"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { confirmOrder, completeOrder, cancelOrder, CMTOrderError } from "@/lib/cmt-orders";
import type { FormState } from "@/components/entity-form";

function toMessage(error: unknown): string {
  if (error instanceof CMTOrderError) return error.message;
  if (error instanceof ForbiddenError) {
    return "You do not have permission to manage CMT orders.";
  }
  console.error("Unhandled CMT order error:", error);
  return "Something went wrong. Nothing was saved.";
}

export async function confirmOrderAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("cmt_quote:create");
    const due = String(formData.get("dueDate") ?? "").trim();

    const result = await confirmOrder(
      {
        quoteId: String(formData.get("quoteId") ?? ""),
        orderDate: new Date(String(formData.get("orderDate") ?? "")),
        dueDate: due ? new Date(due) : null,
      },
      { userId: session.userId, reason: null },
    );

    revalidatePath("/cmt/orders");
    revalidatePath("/cmt/quotes");
    revalidatePath("/capacity");

    return {
      success: `اتعمل أمر ${result.orderNumber} — واتحجز ${result.minutesBooked} دقيقة من طاقة الشهر.`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function completeOrderAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("cmt_quote:create");

    const result = await completeOrder(
      {
        cmtOrderId: String(formData.get("cmtOrderId") ?? ""),
        actualMinutes: Number(formData.get("actualMinutes") ?? 0),
        completedAt: new Date(String(formData.get("completedAt") ?? "")),
      },
      { userId: session.userId, reason: null },
    );

    revalidatePath("/cmt/orders");

    const overran = Number(result.minutesOverrun) > 0;
    return {
      success:
        `اتقفل ${result.orderNumber}. الربح المحقق ${result.realisedMargin}` +
        (overran ? ` — زاد ${result.minutesOverrun} دقيقة عن المتفق.` : "."),
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function cancelOrderAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("cmt_quote:create");

    const result = await cancelOrder(
      {
        cmtOrderId: String(formData.get("cmtOrderId") ?? ""),
        reason: String(formData.get("reason") ?? ""),
      },
      { userId: session.userId, reason: null },
    );

    revalidatePath("/cmt/orders");
    revalidatePath("/capacity");

    return {
      success: `اتلغى ${result.orderNumber} ورجعت ${result.minutesReleased} دقيقة للطاقة المتاحة.`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
