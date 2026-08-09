"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { authorize, ForbiddenError } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import type { FormState } from "@/components/entity-form";

/**
 * Changing a configured number.
 *
 * Every setting drives a calculation somewhere, so a change here is a change
 * to how the business is measured. Each one is written with its old value
 * beside the new one in the audit log — "the margin was 18% until someone
 * moved it" is the kind of question that gets asked months later.
 */

function parseValue(
  type: string,
  raw: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const trimmed = raw.trim();

  switch (type) {
    case "BOOLEAN": {
      const value = trimmed === "true" || trimmed === "on" ? "true" : "false";
      return { ok: true, value };
    }
    case "INTEGER": {
      const n = Number(trimmed);
      if (!Number.isInteger(n)) return { ok: false, message: "That has to be a whole number." };
      return { ok: true, value: String(n) };
    }
    case "DECIMAL": {
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return { ok: false, message: "That has to be a number." };
      return { ok: true, value: trimmed };
    }
    case "PERCENT": {
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return { ok: false, message: "That has to be a number." };
      // Stored as a fraction, shown as a percentage. Anything at or above 1
      // is almost certainly someone typing 18 where 0.18 was meant.
      if (n < 0 || n >= 1) {
        return {
          ok: false,
          message: "Percentages are stored as a fraction — 18% is 0.18, not 18.",
        };
      }
      return { ok: true, value: trimmed };
    }
    default:
      if (trimmed.length === 0) return { ok: false, message: "This cannot be left empty." };
      return { ok: true, value: trimmed };
  }
}

/**
 * Measurements that describe the paper in the printer, and the range each one
 * has to stay inside to produce a label a scanner can read.
 */
const PHYSICAL_LIMITS: Record<string, { min: number; max: number; why: string }> = {
  "label.widthMm": { min: 20, max: 120, why: "A label narrower than 20mm cannot hold a barcode." },
  "label.heightMm": { min: 10, max: 120, why: "A label shorter than 10mm has nowhere for the bars." },
  "label.gapMm": { min: 0, max: 20, why: "The gap the printer's sensor looks for is a few millimetres." },
  "label.moduleWidthMm": {
    min: 0.2,
    max: 1,
    why: "Below 0.2mm a thermal head smears the bars together and scanners stop reading.",
  },
  "label.barcodeHeightMm": { min: 3, max: 60, why: "Bars under 3mm tall are hard to scan at an angle." },
};

export async function updateSettingAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("settings:manage");

    const key = String(formData.get("key") ?? "");
    const setting = await db.setting.findUnique({ where: { key } });
    if (!setting) return { error: "That setting does not exist." };

    const parsed = parseValue(setting.type, String(formData.get("value") ?? ""));
    if (!parsed.ok) return { error: parsed.message };

    const limit = PHYSICAL_LIMITS[key];
    if (limit) {
      const n = Number(parsed.value);
      if (n < limit.min || n > limit.max) {
        return {
          error: `${key} has to be between ${limit.min} and ${limit.max}mm. ${limit.why}`,
        };
      }
    }

    if (parsed.value === setting.value) {
      return { success: "That is already the value; nothing was changed." };
    }

    await db.$transaction(async (tx) => {
      await tx.setting.update({ where: { key }, data: { value: parsed.value } });
      await writeAudit(tx, {
        action: "SETTING_CHANGED",
        entityName: "Setting",
        entityId: setting.id,
        before: { key, value: setting.value },
        after: { key, value: parsed.value },
        ctx: { userId: session.userId },
      });
    });

    revalidatePath("/settings");
    // A label measurement changes what comes out of the printer, so the
    // preview has to be rebuilt too.
    if (key.startsWith("label.")) revalidatePath("/print/labels", "layout");

    return { success: `${key} is now ${parsed.value}.` };
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return { error: "Changing settings is not yours to do." };
    }
    console.error("Unhandled settings error:", error);
    return { error: "Something went wrong. Nothing was saved." };
  }
}
