/**
 * Code 128 barcode generation.
 *
 * Written out rather than pulled from a library because a barcode is only
 * useful if a scanner reads it, and that depends on details a wrapper tends
 * to hide: the checksum, the quiet zone, and the module width in real
 * millimetres. A label that looks right on screen and refuses to scan at the
 * till is the failure this module exists to prevent.
 *
 * Subset B is used throughout: it covers upper case, lower case, digits and
 * punctuation, which is every SKU this system produces. Subset C would pack
 * digit pairs more tightly, but the complexity buys nothing for a code like
 * DALIA-BLK-2XL.
 */

/**
 * Bar and space widths, in modules, for each of the 107 symbols.
 *
 * Every entry is six alternating widths — bar, space, bar, space, bar, space —
 * summing to eleven modules. The stop pattern is the exception at seven
 * elements and thirteen modules.
 */
const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312",
  "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
  "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131",
  "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
  "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
  "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321",
  "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
  "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114",
  "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112",
  "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
  "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412",
  "211214", "211232", "2331112",
];

const START_B = 104;
const STOP = 106;

/** Ten modules of clear space each side, below which scanners start failing. */
export const QUIET_ZONE_MODULES = 10;

export class BarcodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BarcodeError";
  }
}

/**
 * Turns a value into the symbol codes a Code 128 B barcode is made of.
 *
 * The checksum is what a scanner uses to reject a misread, so it is computed
 * rather than approximated: start value, plus each symbol multiplied by its
 * position, modulo 103.
 */
export function encodeCode128B(value: string): number[] {
  if (value.length === 0) throw new BarcodeError("Nothing to encode.");

  const codes: number[] = [START_B];

  for (const char of value) {
    const point = char.charCodeAt(0);
    // Subset B covers ASCII 32 to 126. Anything outside it — Arabic text, an
    // accent, a tab — cannot be encoded, and silently dropping it would print
    // a label for a different SKU than the one asked for.
    if (point < 32 || point > 126) {
      throw new BarcodeError(
        `"${char}" cannot go in a Code 128 barcode. Barcodes carry the SKU, which is Latin letters, digits and dashes.`,
      );
    }
    codes.push(point - 32);
  }

  let checksum = START_B;
  for (let i = 1; i < codes.length; i++) {
    checksum += codes[i] * i;
  }
  codes.push(checksum % 103);
  codes.push(STOP);

  return codes;
}

export type BarcodeBar = { x: number; width: number };

/**
 * The bars themselves, measured in modules from the left edge.
 *
 * Returned as geometry rather than markup so the caller decides the physical
 * size — the same barcode is a different number of millimetres on a garment
 * tag and on a carton label.
 */
export function code128Bars(value: string): {
  bars: BarcodeBar[];
  totalModules: number;
} {
  const codes = encodeCode128B(value);
  const bars: BarcodeBar[] = [];

  let x = QUIET_ZONE_MODULES;
  for (const code of codes) {
    const pattern = PATTERNS[code];
    let isBar = true;
    for (const widthChar of pattern) {
      const width = Number(widthChar);
      if (isBar) bars.push({ x, width });
      x += width;
      isBar = !isBar;
    }
  }

  return { bars, totalModules: x + QUIET_ZONE_MODULES };
}

/**
 * A complete barcode as inline SVG.
 *
 * Inline because the print CSS forbids external requests, and because an
 * image that fails to load leaves a blank label nobody notices until the
 * garment is on the shelf.
 *
 * `moduleWidthMm` defaults to 0.33mm, comfortably above the 0.25mm most
 * handheld scanners need. Going smaller to fit a longer SKU is how a label
 * becomes unreadable.
 */
export function code128Svg(
  value: string,
  options: {
    moduleWidthMm?: number;
    heightMm?: number;
    showText?: boolean;
    textSizeMm?: number;
  } = {},
): string {
  const moduleWidth = options.moduleWidthMm ?? 0.33;
  const barHeight = options.heightMm ?? 12;
  const showText = options.showText ?? true;
  const textSize = options.textSizeMm ?? 2.6;

  const { bars, totalModules } = code128Bars(value);

  const width = totalModules * moduleWidth;
  // Text sits under the bars, never over them.
  const height = barHeight + (showText ? textSize + 1.2 : 0);

  const rects = bars
    .map(
      (b) =>
        `<rect x="${(b.x * moduleWidth).toFixed(3)}" y="0" width="${(b.width * moduleWidth).toFixed(3)}" height="${barHeight}" />`,
    )
    .join("");

  const text = showText
    ? `<text x="${(width / 2).toFixed(3)}" y="${(barHeight + textSize).toFixed(2)}" font-family="monospace" font-size="${textSize}" text-anchor="middle" fill="#000">${escapeXml(value)}</text>`
    : "";

  // shape-rendering="crispEdges" stops the renderer antialiasing bar edges
  // into grey, which is what makes a printed barcode scan unreliably.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width.toFixed(2)}mm" height="${height.toFixed(2)}mm" viewBox="0 0 ${width.toFixed(3)} ${height.toFixed(3)}" shape-rendering="crispEdges"><g fill="#000">${rects}</g>${text}</svg>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Whether a value can be printed as a barcode at all.
 *
 * Used to check a batch before sending it to a printer, so a bad SKU is
 * caught on screen rather than discovered as a blank space on a sheet of
 * labels.
 */
export function canEncode(value: string): { ok: true } | { ok: false; reason: string } {
  try {
    encodeCode128B(value);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Cannot encode." };
  }
}
