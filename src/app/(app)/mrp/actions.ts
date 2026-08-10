"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { authorize, ForbiddenError } from "@/lib/auth";
import { createPurchaseOrder, PurchasingError } from "@/lib/purchasing";
import { materialRequirements } from "@/lib/mrp";
import type { FormState } from "@/components/entity-form";

function toMessage(error: unknown): string {
  if (error instanceof PurchasingError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  if (error && typeof error === "object" && "issues" in error) {
    return (error as { issues: { message: string }[] }).issues.map((i) => i.message).join(" ");
  }
  console.error("Unhandled MRP error:", error);
  return "Something went wrong. Nothing was saved.";
}

/**
 * Turning the plan into orders.
 *
 * One order per supplier rather than one per material: a supplier who receives
 * four separate orders for four fabrics on the same morning will ask why, and
 * the delivery arrives as one lorry regardless.
 *
 * The quantities come from the plan as it stands right now, re-read here
 * rather than taken from the form. A page left open for an hour while stock
 * moved would otherwise order against figures that have since changed.
 */
export async function raiseOrdersFromPlanAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("purchase_order:create");

    const chosen = new Set(
      String(formData.get("materialIds") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    if (chosen.size === 0) return { error: "Nothing was selected to order." };

    const plan = await materialRequirements();
    const lines = plan.suggestions.filter(
      (s) => chosen.has(s.materialId) && s.suggestedQty.greaterThan(0),
    );
    if (lines.length === 0) {
      return {
        error: "The plan no longer needs any of those — stock or orders have changed since this page loaded.",
      };
    }

    const materials = await db.material.findMany({
      where: { id: { in: lines.map((l) => l.materialId) } },
      select: { id: true, code: true, supplierId: true, basePrice: true },
    });

    const withoutSupplier = materials.filter((m) => !m.supplierId);
    if (withoutSupplier.length > 0) {
      return {
        error: `No supplier is set for ${withoutSupplier.map((m) => m.code).join(", ")}. Set one on the material first.`,
      };
    }

    const bySupplier = new Map<string, typeof lines>();
    for (const line of lines) {
      const material = materials.find((m) => m.id === line.materialId)!;
      const bucket = bySupplier.get(material.supplierId!) ?? [];
      bucket.push(line);
      bySupplier.set(material.supplierId!, bucket);
    }

    const orderDate = new Date();
    const raised: string[] = [];

    for (const [supplierId, supplierLines] of bySupplier) {
      // The date the last of them has to be ordered by is the one that governs
      // the whole delivery.
      const earliest = supplierLines
        .map((l) => l.orderBy)
        .filter((d): d is Date => d != null)
        .sort((a, b) => a.getTime() - b.getTime())[0];

      const result = await createPurchaseOrder(
        {
          supplierId,
          orderDate,
          expectedDate: earliest ?? null,
          notes: "Raised from the requirements plan.",
          lines: supplierLines.map((l) => ({
            materialId: l.materialId,
            quantity: Number(l.suggestedQty),
            unitPrice: Number(
              materials.find((m) => m.id === l.materialId)?.basePrice ?? 0,
            ),
          })),
        },
        { userId: session.userId },
      );
      raised.push(result.poNumber);
    }

    revalidatePath("/mrp");
    revalidatePath("/purchasing");
    revalidatePath("/cash-flow");

    return {
      success:
        raised.length === 1
          ? `${raised[0]} raised. Prices came from each material's base price — check them against the supplier's quote before sending.`
          : `${raised.length} orders raised (${raised.join(", ")}), one per supplier. Prices came from each material's base price — check them before sending.`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
