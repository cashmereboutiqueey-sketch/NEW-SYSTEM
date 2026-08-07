import { z } from "zod";

/**
 * SKU convention, already in use by the business and respected exactly:
 *
 *   [STYLENAME]-[COLORCODE]-[SIZE]      e.g. DALIA-BLK-2XL
 *
 * One generator and one parser, used everywhere. Colour codes and sizes are
 * reference data in the database — this module validates *shape*, and the
 * database validates *membership*. Hardcoding the colour list here would
 * mean a new colour needs a deploy.
 */

export const SKU_SEPARATOR = "-";

/** Style codes are uppercase A–Z and digits, no separator character. */
export const styleCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,20}$/, "Style code must be 2–20 uppercase letters or digits");

export const colorCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Colour code must be exactly 3 uppercase letters");

export const sizeCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{1,4}$/, "Size code must be 1–4 uppercase letters or digits");

export type SkuParts = {
  styleCode: string;
  colorCode: string;
  sizeCode: string;
};

export function buildSku(parts: SkuParts): string {
  const styleCode = styleCodeSchema.parse(parts.styleCode);
  const colorCode = colorCodeSchema.parse(parts.colorCode);
  const sizeCode = sizeCodeSchema.parse(parts.sizeCode);
  return [styleCode, colorCode, sizeCode].join(SKU_SEPARATOR);
}

/**
 * Splits from the right, so a style code is free to contain no separator but
 * any future convention change stays predictable. Returns null instead of
 * throwing — callers importing external data (Shopify) get plenty of
 * malformed SKUs and need to route them to a review queue, not crash.
 */
export function parseSku(sku: string): SkuParts | null {
  const trimmed = sku.trim().toUpperCase();
  const segments = trimmed.split(SKU_SEPARATOR);
  if (segments.length !== 3) return null;

  const [styleCode, colorCode, sizeCode] = segments;
  const result = z
    .object({
      styleCode: styleCodeSchema,
      colorCode: colorCodeSchema,
      sizeCode: sizeCodeSchema,
    })
    .safeParse({ styleCode, colorCode, sizeCode });

  return result.success ? result.data : null;
}

export function isValidSku(sku: string): boolean {
  return parseSku(sku) !== null;
}
