"use server";

import { authorize, ForbiddenError } from "@/lib/auth";
import { rateCard, CMTError } from "@/lib/cmt";

export type RateCardResult = NonNullable<Awaited<ReturnType<typeof rateCard>>>;

/**
 * Work out the price table for a garment.
 *
 * Guarded even though it only reads: the floor rate and the factory's free
 * capacity are exactly what a competitor would want, and both are on this
 * table.
 */
export async function fetchRateCardAction(input: {
  smvPerUnit: string;
  clientId: string | null;
  marginOverFloor: string;
}): Promise<RateCardResult | { error: string }> {
  try {
    await authorize("cmt_quote:view");

    const card = await rateCard({
      smvPerUnit: input.smvPerUnit,
      clientId: input.clientId,
      marginOverFloor: input.marginOverFloor,
    });

    if (!card) {
      return {
        error:
          "مفيش سعر دقيقة محسوب للشهر ده، فمفيش أساس نسعّر عليه. احسب سعر الدقيقة الأول.",
      };
    }
    return card;
  } catch (error) {
    if (error instanceof CMTError) return { error: error.message };
    if (error instanceof ForbiddenError) {
      return { error: "You do not have permission to do that." };
    }
    console.error("Unhandled rate card error:", error);
    return { error: "Something went wrong." };
  }
}
