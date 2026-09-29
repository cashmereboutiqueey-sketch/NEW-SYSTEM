"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { authorize } from "@/lib/auth";
import { createSession } from "@/lib/session";
import { authenticateCashierPin, QuickSwitchError } from "@/lib/quick-switch";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/audit";

export type QuickSwitchState = { error?: string };

export async function quickSwitchAction(
  _prev: QuickSwitchState,
  formData: FormData,
): Promise<QuickSwitchState> {
  const current = await authorize("pos:operate");
  if (current.role !== "POS_CASHIER") {
    return { error: "Quick switch is for cashier accounts." };
  }

  let target: { userId: string; sessionVersion: number };
  try {
    target = await authenticateCashierPin(
      String(formData.get("userId") ?? ""),
      String(formData.get("pin") ?? ""),
    );
  } catch (error) {
    return { error: error instanceof QuickSwitchError ? error.message : "Could not switch cashier." };
  }

  await db.$transaction((tx) => writeAudit(tx, {
    action: "CASHIER_QUICK_SWITCH",
    entityName: "User",
    entityId: target.userId,
    before: { userId: current.userId },
    after: { userId: target.userId },
    ctx: { userId: current.userId, reason: null },
  }));
  await createSession(target);
  revalidatePath("/", "layout");
  redirect("/pos");
}
