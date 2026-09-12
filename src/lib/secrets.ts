import "server-only";
import crypto from "node:crypto";

/**
 * Integration credentials, sealed at rest.
 *
 * A Shopify access token is authority over the shop. Stored as plain text it
 * was readable by anybody with a database login or a copy of a nightly backup
 * — and the backups sit on disk as ordinary files. Sealed, the database and
 * its backups hold ciphertext; the key lives in the server's environment,
 * outside both, so neither alone gives the token away.
 *
 * AES-256-GCM, so a tampered value fails to open rather than opening to
 * something else. Values stored before sealing existed have no prefix and are
 * read as they are; the next save seals them, and
 * `scripts/seal-integration-secrets.ts` seals the lot at once.
 */

const PREFIX = "enc:v1:";

export class SecretKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretKeyError";
  }
}

function key(): Buffer {
  const raw = process.env.INTEGRATION_SECRET_KEY;
  if (!raw) {
    throw new SecretKeyError(
      "INTEGRATION_SECRET_KEY is not set. Generate one with `openssl rand -base64 32` " +
        "and put it in the server's .env — not in the database, and not in a backup.",
    );
  }
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32) {
    throw new SecretKeyError("INTEGRATION_SECRET_KEY must be 32 bytes, base64-encoded.");
  }
  return bytes;
}

/** Whether a stored value is sealed. */
export function isSealed(stored: string | null | undefined): boolean {
  return !!stored && stored.startsWith(PREFIX);
}

/** Seals a credential for storage. */
export function sealSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${body.toString("base64")}`;
}

/** Opens a stored credential. Values from before sealing come back as they are. */
export function openSecret(stored: string | null | undefined): string | null {
  if (stored == null || stored === "") return null;
  if (!isSealed(stored)) return stored;
  const [iv, tag, body] = stored.slice(PREFIX.length).split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}
