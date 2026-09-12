/**
 * Seal integration credentials stored before sealing existed.
 *
 * Tokens and webhook secrets saved as plain text are read as they are until
 * the next save seals them; this seals them all at once, so the database and
 * its backups stop holding them readable. Safe to run more than once —
 * anything already sealed is left alone.
 *
 * Needs INTEGRATION_SECRET_KEY in the environment (see .env.example). Take a
 * backup first; losing the key after this means reconnecting the shop.
 *
 *   npx tsx --conditions=react-server scripts/seal-integration-secrets.ts
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { sealSecret, isSealed } from "../src/lib/secrets";

const connections = await db.integrationConnection.findMany({
  select: { id: true, externalRef: true, accessToken: true, webhookSecret: true },
});

let sealed = 0;
for (const c of connections) {
  const data: { accessToken?: string; webhookSecret?: string } = {};
  if (c.accessToken && !isSealed(c.accessToken)) data.accessToken = sealSecret(c.accessToken);
  if (c.webhookSecret && !isSealed(c.webhookSecret)) data.webhookSecret = sealSecret(c.webhookSecret);
  if (Object.keys(data).length === 0) continue;
  await db.integrationConnection.update({ where: { id: c.id }, data });
  sealed += 1;
  console.log(`  sealed ${c.externalRef}`);
}

console.log(`${sealed} of ${connections.length} connection(s) needed sealing.`);
await db.$disconnect();
