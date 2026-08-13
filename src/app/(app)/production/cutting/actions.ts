"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { createCuttingTicket, CuttingError } from "@/lib/cutting";
import type { FormState } from "@/components/entity-form";

export async function createCuttingTicketAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("production:create");

    const marker = String(formData.get("markerLengthM") ?? "").trim();
    const plies = String(formData.get("plies") ?? "").trim();

    const result = await createCuttingTicket(
      {
        productionOrderId: String(formData.get("productionOrderId") ?? ""),
        cutDate: new Date(String(formData.get("cutDate") ?? "")),
        piecesCut: Number(formData.get("piecesCut") ?? 0),
        // Both halves of the lay or neither: half of it cannot measure
        // anything, and a made-up number is worse than an absent one.
        markerLengthM: marker ? Number(marker) : null,
        plies: plies ? Number(plies) : null,
        notes: String(formData.get("notes") ?? "").trim() || null,
      },
      { userId: session.userId, reason: null },
    );

    revalidatePath("/production/cutting");
    revalidatePath("/production");

    return {
      success: result.fabricLaid
        ? `اتعملت تذكرة ${result.ticketNumber} — ${result.fabricLaid} متر على الترابيزة.`
        : `اتعملت تذكرة ${result.ticketNumber}.`,
    };
  } catch (error) {
    if (error instanceof CuttingError) return { error: error.message };
    if (error instanceof ForbiddenError) {
      return { error: "You do not have permission to record cutting." };
    }
    if (error && typeof error === "object" && "issues" in error) {
      return {
        error: (error as { issues: { message: string }[] }).issues
          .map((i) => i.message)
          .join(" "),
      };
    }
    console.error("Unhandled cutting error:", error);
    return { error: "Something went wrong. Nothing was recorded." };
  }
}
