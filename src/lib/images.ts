import "server-only";
import { createHash } from "node:crypto";
import { mkdir, writeFile, access, unlink } from "node:fs/promises";
import path from "node:path";

/**
 * Product photographs, on disk.
 *
 * Not in the database. A photograph of a coat is not a secret, and carrying
 * a few hundred megabytes of them inside Postgres makes every backup, restore
 * and replication slower to protect something that needs no protecting.
 *
 * Files are named after a hash of their own contents. That gives three things
 * for free: the same photograph uploaded twice occupies one file, a name can
 * never collide, and a name can never be chosen by whoever uploaded it — which
 * is what makes path traversal impossible rather than merely guarded against.
 */

export class ImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageError";
  }
}

/** Kept out of `public/` so the files survive a rebuild and can be backed up. */
export const UPLOAD_DIR = path.resolve(
  process.env.UPLOAD_DIR ?? path.join(process.cwd(), "data", "uploads"),
);

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * What the bytes actually are, not what the upload claimed.
 *
 * A browser will happily send `image/jpeg` for a file that is nothing of the
 * sort, so the declared type is treated as a hint and the first few bytes
 * decide. Anything unrecognised is refused rather than stored and served back
 * later with a content type somebody else's browser will try to interpret.
 */
function sniff(bytes: Uint8Array): "jpg" | "png" | "webp" | null {
  if (bytes.length < 12) return null;

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";

  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "png";
  }

  // RIFF....WEBP
  const riff = String.fromCharCode(...bytes.slice(0, 4));
  const webp = String.fromCharCode(...bytes.slice(8, 12));
  if (riff === "RIFF" && webp === "WEBP") return "webp";

  return null;
}

export const CONTENT_TYPE: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/**
 * A stored name is always sixteen hex characters and a known extension.
 *
 * Enforced on the way out as well as on the way in: the serving route asks
 * this before touching the disk, so a name from the database that somebody
 * has tampered with cannot walk out of the upload directory.
 */
export function isStoredName(name: string): boolean {
  return /^[a-f0-9]{16}\.(jpg|png|webp)$/.test(name);
}

export function imagePath(name: string): string {
  if (!isStoredName(name)) throw new ImageError("Not a stored image name.");
  return path.join(UPLOAD_DIR, name);
}

/** The URL a page uses. Null in, null out, so callers need no special case. */
export function imageUrl(name: string | null | undefined): string | null {
  if (!name || !isStoredName(name)) return null;
  return `/api/images/${name}`;
}

export async function storeImage(file: File): Promise<string> {
  if (file.size === 0) throw new ImageError("The file is empty.");
  if (file.size > MAX_BYTES) {
    throw new ImageError(
      `The photo is ${(file.size / 1024 / 1024).toFixed(1)}MB; the limit is 5MB.`,
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(bytes);
  if (!kind) {
    throw new ImageError("That is not a JPEG, PNG or WebP image.");
  }

  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const name = `${digest}.${kind}`;
  const target = path.join(UPLOAD_DIR, name);

  await mkdir(UPLOAD_DIR, { recursive: true });

  // Content-addressed, so an identical upload is already here and rewriting it
  // would only risk truncating a file something else is reading.
  try {
    await access(target);
    return name;
  } catch {
    // Not there yet.
  }

  await writeFile(target, bytes);
  return name;
}

/**
 * Forget a photograph.
 *
 * The file is left alone on purpose. The same bytes may be in use by another
 * style — that is the point of naming by content — so deleting here would
 * blank someone else's picture. Unused files are cheap; a wrong deletion is
 * not.
 */
export async function detachImage(): Promise<void> {
  return;
}

/** Only for tests, which should not leave files behind. */
export async function removeStoredFile(name: string): Promise<void> {
  if (!isStoredName(name)) return;
  try {
    await unlink(path.join(UPLOAD_DIR, name));
  } catch {
    // Already gone is the outcome we wanted.
  }
}
