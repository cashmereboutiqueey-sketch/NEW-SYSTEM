"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { can } from "@/core/permissions";
import { takeOrderToMake } from "@/lib/made-to-order";
import { CustomOrderError } from "@/lib/custom-orders";
import { ProductionError } from "@/lib/production";
import { LedgerError } from "@/lib/ledger";
import { formCommand, CommandError } from "@/lib/command";
import type { FormState } from "@/components/entity-form";

function toMessage(error: unknown): string {
  if (
    error instanceof CustomOrderError ||
    error instanceof ProductionError ||
    error instanceof LedgerError ||
    error instanceof CommandError
  ) {
    return error.message;
  }
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  if (error && typeof error === "object" && "issues" in error) {
    return (error as { issues: { message: string }[] }).issues.map((i) => i.message).join(" ");
  }
  console.error("Unhandled made-to-order error:", error);
  return "Something went wrong. Nothing was saved.";
}

function day(value: FormDataEntryValue | null): Date {
  const text = String(value ?? "");
  return text ? new Date(`${text}T00:00:00.000Z`) : new Date();
}

/**
 * A message asking for something the shop has not got.
 *
 * Taking the promise and raising the run are one submission, because they are
 * one decision on the shop floor and splitting them across two screens is how
 * orders end up sitting for a week waiting for somebody to notice.
 *
 * Raising the run is a separate right from taking the order. A moderator who
 * may promise a garment does not thereby get to book the factory's cloth and
 * its capacity, so the box is only obeyed for somebody who holds
 * `production:create` — and the order is still taken either way, because
 * refusing it outright would lose the customer to a permission problem.
 */
export async function takeOrderToMakeAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("sales_order:create");

    const depositAmount = String(formData.get("depositAmount") ?? "").trim();
    const hasDeposit = depositAmount !== "" && Number(depositAmount) > 0;
    const promised = String(formData.get("promisedDate") ?? "");

    const asked = formData.get("raiseRun") === "on";
    const mayPlan = can(session.role, "production:create");

    const result = await formCommand(
      "moderator.takeOrderToMake",
      formData,
      { userId: session.userId },
      () =>
        takeOrderToMake(
          {
            customerId: String(formData.get("customerId") ?? ""),
            variantId: String(formData.get("variantId") ?? ""),
            quantity: Number(formData.get("quantity") ?? 1),
            agreedUnitPrice: String(formData.get("agreedUnitPrice") ?? "0"),
            deposit: hasDeposit
              ? {
                  amount: depositAmount,
                  method: String(formData.get("depositMethod") ?? "CASH") as
                    | "CASH" | "CARD" | "BANK_TRANSFER" | "INSTAPAY",
                }
              : null,
            entityId: String(formData.get("entityId") ?? ""),
            locationId: String(formData.get("locationId") ?? ""),
            orderDate: day(formData.get("orderDate")),
            promisedDate: promised ? new Date(promised) : null,
            notes: String(formData.get("notes") ?? "") || null,
            raiseRun: asked && mayPlan,
          },
          { userId: session.userId, reason: null },
        ),
    );

    revalidatePath("/moderator");
    revalidatePath("/custom-orders");
    revalidatePath("/production");
    revalidatePath("/receivables");

    const money = (v: string) => Number(v).toFixed(2);
    const head =
      `اتسجّل ${result.orderNumber} بـ ${money(result.agreedTotal)}` +
      (Number(result.deposit) > 0 ? ` وعربون ${money(result.deposit)}` : " من غير عربون");

    if (result.runNumber) {
      return { success: `${head} — واتعمل أمر إنتاج ${result.runNumber} في المصنع.` };
    }
    if (asked && !mayPlan) {
      return {
        success: `${head} — الأوردر اتسجّل، بس مالكش صلاحية تعمل أمر إنتاج. حد من الإنتاج لازم يعمله.`,
      };
    }
    return { success: `${head} — من غير أمر إنتاج: ${result.runSkippedBecause}` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
