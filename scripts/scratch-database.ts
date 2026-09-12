/**
 * Refuses to run against anything but a scratch database.
 *
 * Some scripts here exist to destroy or invent data: a reset that clears every
 * transaction, a volume test that writes ten thousand fake customers. Run
 * against the shop's own database by a tired person with the wrong DATABASE_URL
 * in their shell, either one is unrecoverable without a backup.
 *
 * A local database is the normal case and passes silently. Anything else has
 * to be said out loud, per script, in the environment.
 */
import { db } from "../src/lib/db";

export async function refuseUnlessScratchDatabase(
  whatItDoes: string,
  override = "ALLOW_REMOTE_RESET",
): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  if (isLocal || process.env[override] === "yes") return;

  console.error(
    `DATABASE_URL does not point at localhost. This ${whatItDoes};\n` +
      `if that is genuinely what you want on a remote database, set ${override}=yes.`,
  );
  await db.$disconnect();
  process.exit(1);
}
