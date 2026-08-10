/**
 * Open a till at the Alexandria showroom, so /pos can be looked at.
 *
 *   npx tsx --conditions=react-server scripts/open-till.ts
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { openPosSession } from "../src/lib/sales";

const owner = await db.user.findFirstOrThrow({ where: { role: "OWNER" } });
const alx = await db.location.findFirstOrThrow({ where: { code: "LOC-ALX" } });

const open = await db.posSession.findFirst({
  where: { locationId: alx.id, closedAt: null },
});

if (open) {
  console.log(`${open.sessionNumber} is already open.`);
} else {
  const session = await openPosSession(
    { locationId: alx.id, cashierUserId: owner.id, openingFloat: "500" },
    { userId: owner.id, reason: null },
  );
  console.log(`opened ${session.sessionNumber} at ${alx.nameAr}`);
}

await db.$disconnect();
