"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import {
  createProductionOrder,
  confirmProductionOrder,
  issueForOrder,
  completeProductionOrder,
  ProductionError,
} from "@/lib/production";
import { InventoryError } from "@/lib/inventory";
import { CostingError } from "@/lib/costing";
import { LedgerError } from "@/lib/ledger";
import type { FormState } from "@/components/entity-form";
import { formCommand, CommandError } from "@/lib/command";

function toMessage(error: unknown): string {
  if (
    error instanceof ProductionError ||
    error instanceof InventoryError ||
    error instanceof CostingError ||
    error instanceof LedgerError ||
    error instanceof CommandError
  ) {
    return error.message;
  }
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  console.error("Unhandled production error:", error);
  return "Something went wrong. Nothing was saved.";
}

export async function createProductionOrderAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("production:create");

    const result = await createProductionOrder(
      {
        styleId: String(formData.get("styleId") ?? ""),
        plannedQty: Number(formData.get("plannedQty") ?? 0),
        orderDate: new Date(String(formData.get("orderDate") ?? "")),
        plannedStart: formData.get("plannedStart")
          ? new Date(String(formData.get("plannedStart")))
          : null,
        plannedFinish: formData.get("plannedFinish")
          ? new Date(String(formData.get("plannedFinish")))
          : null,
        notes: (formData.get("notes") as string) || null,
      },
      { userId: session.userId },
    );

    revalidatePath("/production");
    return {
      success: `Order ${result.orderNumber} raised as a draft. Confirm it to freeze its cost.`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function confirmProductionOrderAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    // Confirming freezes the cost the run will carry forever, so it is a
    // separate right from merely raising the order.
    const session = await authorize("production:confirm_cost");

    const result = await confirmProductionOrder(
      {
        productionOrderId: String(formData.get("productionOrderId") ?? ""),
        minuteRatePeriodId: String(formData.get("minuteRatePeriodId") ?? ""),
      },
      { userId: session.userId },
    );

    revalidatePath("/production");
    revalidatePath("/costing");
    return {
      success:
        `${result.orderNumber} confirmed at ${Number(result.plannedTotalCost).toFixed(2)} ` +
        `for the run. That cost basis is frozen and will not move again.`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function issueForOrderAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("production:record");

    // A second press after a lost response returns this issue rather than
    // taking the fabric off the shelf twice.
    const result = await formCommand("production.issue", formData, { userId: session.userId }, () =>
      issueForOrder(
        {
          productionOrderId: String(formData.get("productionOrderId") ?? ""),
          materialId: String(formData.get("materialId") ?? ""),
          locationId: String(formData.get("locationId") ?? ""),
          entityId: String(formData.get("entityId") ?? ""),
          quantity: String(formData.get("quantity") ?? ""),
          issueDate: new Date(String(formData.get("issueDate") ?? "")),
          piecesCut: formData.get("piecesCut")
            ? Number(formData.get("piecesCut"))
            : undefined,
        },
        { userId: session.userId },
      ),
    );

    revalidatePath("/production");
    revalidatePath("/inventory");

    // Costing keeps using the planned rate; this is for the eye on the floor.
    const waste = result.actualWasteRate == null ? null : Number(result.actualWasteRate);
    return {
      success:
        `Issued to the floor at ${Number(result.totalCost).toFixed(2)}.` +
        (waste == null
          ? ""
          : ` Waste on this cut ran at ${(waste * 100).toFixed(1)}%.`),
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function completeProductionOrderAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("production:record");

    const outputs = JSON.parse(String(formData.get("outputs") ?? "[]"));
    const close = formData.get("close") != null;

    // Letting a run through on less material than it made is an approved
    // variance, not a floor decision: it takes the right to confirm costs.
    const shortfallReason = String(formData.get("shortfallReason") ?? "").trim() || null;
    if (shortfallReason) await authorize("production:confirm_cost");

    // A second press after a lost response returns this completion rather
    // than putting the same run into stock twice.
    const result = await formCommand("production.complete", formData, { userId: session.userId }, () =>
      completeProductionOrder(
        {
          productionOrderId: String(formData.get("productionOrderId") ?? ""),
          outputs,
          rejectedQty: Number(formData.get("rejectedQty") ?? 0),
          locationId: String(formData.get("locationId") ?? ""),
          entityId: String(formData.get("entityId") ?? ""),
          completedDate: new Date(String(formData.get("completedDate") ?? "")),
          actualTotalMinutes: (formData.get("actualTotalMinutes") as string) || undefined,
          close,
          shortfallReason,
        },
        { userId: session.userId },
      ),
    );

    revalidatePath("/production");
    revalidatePath("/inventory");
    revalidatePath("/transfers");

    if (!result.closed) {
      return {
        success:
          `${result.goodQty} garments into stock on ${result.orderNumber}, ` +
          `${result.totalGoodQty} so far. The order stays open for the rest.`,
      };
    }

    const fabric = Number(result.fabricVariance);
    return {
      success:
        `${result.orderNumber} closed. ${result.goodQty} garments into stock across ` +
        `${result.finishedLotNumbers.length} lot(s). ` +
        (fabric === 0
          ? "Fabric came in exactly on plan."
          : `Fabric was ${Math.abs(fabric).toFixed(2)} ${fabric > 0 ? "over" : "under"} plan.`) +
        " They are still the Factory's — transfer them to the Brand to sell them.",
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
