"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { LedgerError } from "@/lib/ledger";
import {
  openExhibition,
  sendToExhibition,
  closeExhibition,
  ExhibitionError,
} from "@/lib/exhibitions";

export type ExhibitionState = { error?: string; success?: string };

function toMessage(error: unknown): string {
  if (error instanceof ExhibitionError || error instanceof LedgerError) {
    return error.message;
  }
  if (error instanceof ForbiddenError) {
    return "You do not have permission to do that.";
  }
  console.error("Unhandled exhibition error:", error);
  return "Something went wrong. Nothing was saved.";
}

function day(value: FormDataEntryValue | null): Date {
  const text = String(value ?? "");
  const parsed = text ? new Date(text) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export async function openExhibitionAction(
  _prev: ExhibitionState,
  formData: FormData,
): Promise<ExhibitionState> {
  try {
    const session = await authorize("inventory:transfer");

    const result = await openExhibition(
      {
        nameAr: String(formData.get("nameAr") ?? ""),
        nameEn: String(formData.get("nameEn") ?? ""),
        city: String(formData.get("city") ?? "") || null,
        opensAt: day(formData.get("opensAt")),
        closesAt: day(formData.get("closesAt")),
        parentLocationId: String(formData.get("parentLocationId") ?? ""),
      },
      { userId: session.userId, reason: null },
    );

    revalidatePath("/exhibitions");
    return { success: `تم فتح ${result.code}` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function sendToExhibitionAction(
  _prev: ExhibitionState,
  formData: FormData,
): Promise<ExhibitionState> {
  try {
    const session = await authorize("inventory:transfer");

    const exhibitionId = String(formData.get("exhibitionId") ?? "");
    const lines: { variantId: string; quantity: string }[] = [];

    for (const [key, value] of formData.entries()) {
      if (!key.startsWith("qty_")) continue;
      const quantity = String(value).trim();
      if (!quantity || Number(quantity) <= 0) continue;
      lines.push({ variantId: key.slice(4), quantity });
    }

    if (lines.length === 0) {
      return { error: "اكتب الكميات اللي هتروح الأول." };
    }

    const result = await sendToExhibition(
      { exhibitionId, lines, sendDate: day(formData.get("sendDate")) },
      { userId: session.userId, reason: null },
    );

    revalidatePath("/exhibitions");
    revalidatePath(`/exhibitions/${exhibitionId}`);
    return { success: `راح ${result.totalQty} قطعة (${result.despatchNumber})` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function closeExhibitionAction(
  _prev: ExhibitionState,
  formData: FormData,
): Promise<ExhibitionState> {
  try {
    const session = await authorize("inventory:transfer");

    const exhibitionId = String(formData.get("exhibitionId") ?? "");
    const counts: { variantId: string; countedQty: string }[] = [];

    for (const [key, value] of formData.entries()) {
      if (!key.startsWith("count_")) continue;
      const counted = String(value).trim();
      // A blank line is not a zero. Leaving it out lets the service treat it
      // as uncounted — which it records as missing, loudly.
      if (counted === "") continue;
      counts.push({ variantId: key.slice(6), countedQty: counted });
    }

    const result = await closeExhibition(
      {
        exhibitionId,
        closeDate: day(formData.get("closeDate")),
        counts,
        approvedByUserId: String(formData.get("approvedByUserId") ?? "") || null,
        notes: String(formData.get("notes") ?? "") || null,
      },
      { userId: session.userId, reason: null },
    );

    revalidatePath("/exhibitions");
    revalidatePath(`/exhibitions/${exhibitionId}`);
    revalidatePath("/inventory");

    const missing = Number(result.missing);
    return {
      success:
        missing > 0
          ? `رجع ${result.returned} قطعة، وناقص ${result.missing} بتكلفة ${Number(result.shortfallValue).toFixed(2)} جنيه اتقيدت خسارة.`
          : `رجع ${result.returned} قطعة، ومفيش أي نقص.`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
