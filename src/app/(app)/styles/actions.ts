"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import {
  createStyle, createCollection, addBomLine, removeBomLine,
  addOperation, removeOperation, generateVariants, ProductError,
} from "@/lib/products";
import type { FormState } from "@/components/entity-form";
import { db } from "@/lib/db";
import { storeImage, ImageError } from "@/lib/images";

function toMessage(error: unknown): string {
  if (error instanceof ProductError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  if (error && typeof error === "object" && "issues" in error) {
    return (error as { issues: { message: string }[] }).issues
      .map((i) => i.message)
      .join(" ");
  }
  console.error("Unhandled product error:", error);
  return "Something went wrong. Nothing was saved.";
}

/** Percentages are typed as 8, stored as 0.08. */
const pct = (v: FormDataEntryValue | null) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n / 100 : 0;
};

export async function createCollectionAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("retail_price:manage");
    const c = await createCollection(
      {
        code: String(formData.get("code") ?? ""),
        nameEn: String(formData.get("nameEn") ?? ""),
        nameAr: String(formData.get("nameAr") ?? ""),
        season: String(formData.get("season") ?? ""),
        year: Number(formData.get("year") ?? new Date().getFullYear()),
      },
      { userId: session.userId },
    );
    revalidatePath("/styles");
    return { success: `Collection ${c.code} created.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function createStyleAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("retail_price:manage");
    const style = await createStyle(
      {
        code: String(formData.get("code") ?? ""),
        nameEn: String(formData.get("nameEn") ?? ""),
        nameAr: String(formData.get("nameAr") ?? ""),
        collectionId: String(formData.get("collectionId") ?? ""),
        plannedWasteRate: pct(formData.get("plannedWasteRate")),
        retailPrice: formData.get("retailPrice") ? Number(formData.get("retailPrice")) : null,
      },
      { userId: session.userId },
    );
    revalidatePath("/styles");
    return { success: `${style.nameEn} created as ${style.code}. Add its materials and operations next.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function addBomLineAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("production:create");
    const line = await addBomLine(
      {
        styleId: String(formData.get("styleId") ?? ""),
        materialId: String(formData.get("materialId") ?? ""),
        standardConsumption: Number(formData.get("standardConsumption") ?? 0),
        wasteRateOverride: formData.get("wasteRateOverride")
          ? pct(formData.get("wasteRateOverride"))
          : null,
      },
      { userId: session.userId },
    );
    revalidatePath("/styles");
    return { success: `${line.material.code} added to the bill of materials.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function removeBomLineAction(formData: FormData): Promise<void> {
  const session = await authorize("production:create");
  await removeBomLine(
    { id: String(formData.get("id") ?? ""), styleId: String(formData.get("styleId") ?? "") },
    { userId: session.userId },
  );
  revalidatePath("/styles");
}

export async function addOperationAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("production:create");
    const op = await addOperation(
      {
        styleId: String(formData.get("styleId") ?? ""),
        nameEn: String(formData.get("nameEn") ?? ""),
        nameAr: String(formData.get("nameAr") ?? ""),
        smvMinutes: Number(formData.get("smvMinutes") ?? 0),
        lineId: (formData.get("lineId") as string) || null,
        machineType: (formData.get("machineType") as string) || null,
      },
      { userId: session.userId },
    );
    revalidatePath("/styles");
    return { success: `${op.nameEn} added at ${op.smvMinutes} minutes.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function removeOperationAction(formData: FormData): Promise<void> {
  const session = await authorize("production:create");
  await removeOperation(
    { id: String(formData.get("id") ?? ""), styleId: String(formData.get("styleId") ?? "") },
    { userId: session.userId },
  );
  revalidatePath("/styles");
}

export async function generateVariantsAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("retail_price:manage");
    const result = await generateVariants(
      {
        styleId: String(formData.get("styleId") ?? ""),
        colorCodeIds: formData.getAll("colorCodeIds").map(String),
        sizeCodeIds: formData.getAll("sizeCodeIds").map(String),
      },
      { userId: session.userId },
    );

    revalidatePath("/styles");
    return {
      success:
        result.skipped > 0
          ? `${result.created} SKUs created, ${result.skipped} already existed.`
          : `${result.created} SKUs created.`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

/**
 * Attach a photograph to a style, or to one colour of it.
 *
 * Uploading is treated as a pricing-and-presentation decision rather than a
 * stock one, so it sits with whoever manages retail prices. The file itself
 * is validated by its own bytes in `storeImage`; nothing here trusts what the
 * browser said it was sending.
 */
export async function uploadImageAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    await authorize("retail_price:manage");

    const file = formData.get("photo");
    if (!(file instanceof File) || file.size === 0) {
      return { error: "اختار صورة الأول." };
    }

    const name = await storeImage(file);

    const styleId = String(formData.get("styleId") ?? "");
    const variantId = String(formData.get("variantId") ?? "");

    if (variantId) {
      await db.variant.update({ where: { id: variantId }, data: { imageName: name } });
    } else if (styleId) {
      await db.style.update({ where: { id: styleId }, data: { imageName: name } });
    } else {
      return { error: "مش واضح الصورة دي لإيه." };
    }

    revalidatePath("/styles");
    revalidatePath("/pos");
    return { success: "الصورة اتحفظت." };
  } catch (error) {
    if (error instanceof ImageError) return { error: error.message };
    return { error: toMessage(error) };
  }
}
