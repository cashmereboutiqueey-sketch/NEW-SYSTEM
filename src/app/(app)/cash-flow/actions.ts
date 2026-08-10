"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { authorize, ForbiddenError } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { dec } from "@/lib/money";
import type { FormState } from "@/components/entity-form";

/**
 * The known payments that have no invoice yet.
 *
 * Rent, payroll, an equipment instalment — none of them appear as a liability
 * until somebody raises the paperwork, but all of them will absolutely need
 * funding. Leaving them out of the forecast makes next month look survivable
 * when it is not.
 */
function toMessage(error: unknown): string {
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  console.error("Unhandled cash item error:", error);
  return "Something went wrong. Nothing was saved.";
}

export async function createScheduledItemAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("expense:create");

    const amount = dec(String(formData.get("amount") ?? 0));
    if (amount.lessThanOrEqualTo(0)) return { error: "An amount is needed." };

    const dayOfMonth = Number(formData.get("dayOfMonth") ?? 1);
    if (dayOfMonth < 1 || dayOfMonth > 28) {
      // Capped at 28 so a monthly item does not silently skip February.
      return { error: "Pick a day between 1 and 28, so the item never skips a short month." };
    }

    const nameEn = String(formData.get("nameEn") ?? "").trim();
    if (!nameEn) return { error: "Give it a name." };

    const item = await db.$transaction(async (tx) => {
      const created = await tx.scheduledCashItem.create({
        data: {
          entityId: String(formData.get("entityId") ?? ""),
          nameEn,
          nameAr: (formData.get("nameAr") as string)?.trim() || nameEn,
          direction: String(formData.get("direction") ?? "OUTFLOW") as "INFLOW" | "OUTFLOW",
          amount: amount.toString(),
          frequency: String(formData.get("frequency") ?? "MONTHLY") as
            | "ONE_OFF" | "MONTHLY" | "QUARTERLY" | "ANNUAL",
          dayOfMonth,
          startDate: new Date(String(formData.get("startDate") ?? "")),
          endDate: formData.get("endDate") ? new Date(String(formData.get("endDate"))) : null,
        },
      });

      await writeAudit(tx, {
        action: "SCHEDULED_CASH_ITEM_CREATED",
        entityName: "ScheduledCashItem",
        entityId: created.id,
        after: {
          name: created.nameEn,
          amount: created.amount.toString(),
          frequency: created.frequency,
          direction: created.direction,
        },
        ctx: { userId: session.userId },
      });

      return created;
    });

    revalidatePath("/cash-flow");
    return { success: `${item.nameEn} added to the forecast.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function stopScheduledItemAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("expense:create");
    const id = String(formData.get("itemId") ?? "");

    const item = await db.scheduledCashItem.findUnique({ where: { id } });
    if (!item) return { error: "That item has already gone." };

    await db.$transaction(async (tx) => {
      // Deactivated rather than deleted: it was in last month's forecast, and
      // deleting it would rewrite what that forecast said.
      await tx.scheduledCashItem.update({ where: { id }, data: { isActive: false } });
      await writeAudit(tx, {
        action: "SCHEDULED_CASH_ITEM_STOPPED",
        entityName: "ScheduledCashItem",
        entityId: id,
        before: { isActive: true, name: item.nameEn },
        after: { isActive: false },
        ctx: { userId: session.userId },
      });
    });

    revalidatePath("/cash-flow");
    return { success: `${item.nameEn} stopped.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
