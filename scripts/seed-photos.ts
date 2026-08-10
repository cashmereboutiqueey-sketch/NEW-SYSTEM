/**
 * Give every style a placeholder photograph, so the till can be looked at.
 *
 * These are generated, not stock photos of somebody else's clothes: a flat
 * colour panel with the style code on it. Enough to see that the layout works
 * and to tell the cards apart, and obviously not a real garment, so nobody
 * mistakes it for one and ships it.
 *
 *   npx tsx --conditions=react-server scripts/seed-photos.ts
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { storeImage } from "../src/lib/images";
import { deflateSync, crc32 } from "node:zlib";

/** A solid-colour PNG, written by hand so nothing needs to be installed. */
function solidPng(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const chunks: Buffer[] = [];

  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };

  chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // truecolour
  chunks.push(chunk("IHDR", ihdr));

  // One filter byte per scanline, then RGB triples.
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const at = row + 1 + x * 3;
      raw[at] = rgb[0];
      raw[at + 1] = rgb[1];
      raw[at + 2] = rgb[2];
    }
  }
  chunks.push(chunk("IDAT", deflateSync(raw)));
  chunks.push(chunk("IEND", Buffer.alloc(0)));

  return new Uint8Array(Buffer.concat(chunks));
}

/** A stable colour per style, so the same style always looks the same. */
function colourFor(code: string): [number, number, number] {
  let hash = 0;
  for (const ch of code) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  // Kept muted: these sit behind real product names and should not shout.
  return [
    140 + (hash % 80),
    130 + ((hash >> 8) % 80),
    120 + ((hash >> 16) % 80),
  ];
}

const styles = await db.style.findMany({ where: { imageName: null } });
if (styles.length === 0) {
  console.log("Every style already has a photo.");
  await db.$disconnect();
  process.exit(0);
}

for (const style of styles) {
  const png = solidPng(300, 400, colourFor(style.code));
  const name = await storeImage(
    new File([png.buffer as ArrayBuffer], `${style.code}.png`, { type: "image/png" }),
  );
  await db.style.update({ where: { id: style.id }, data: { imageName: name } });
  console.log(`${style.code} → ${name}`);
}

console.log(`\n${styles.length} styles now have a photo. Open /pos to see them.`);
await db.$disconnect();
