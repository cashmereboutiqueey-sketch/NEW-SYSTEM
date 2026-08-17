/**
 * Every page, opened by every role.
 *
 * A page that throws only for the accountant, or renders for a cashier who
 * should never see it, is invisible to a test suite and to anybody browsing as
 * the owner. This opens all of them as all twelve roles and reports three
 * different failures, which are not the same problem:
 *
 *   crashed      the page threw. A bug, whoever hit it.
 *   leaked       a role without the permission got content anyway.
 *   unreachable  a role with the permission was turned away.
 *
 * Routes come from the navigation, so a screen added without a menu entry is
 * caught by the wiring audit rather than silently skipped here.
 *
 *   npx tsx --conditions=react-server scripts/qa-pages.ts [baseUrl]
 */
import "dotenv/config";
import { SignJWT } from "jose";
import { db } from "../src/lib/db";
import { navigation } from "../src/lib/navigation";
import { ROLES, permissionsFor, type Role } from "../src/core/permissions";

const BASE = process.argv[2] ?? "http://localhost:3100";

const problems: string[] = [];
const notes: string[] = [];

async function sessionFor(role: Role, userId: string) {
  return new SignJWT({ userId, email: `${role.toLowerCase()}@qa`, name: `QA ${role}`, role })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
}

/**
 * A real user id, because the app layout looks the signed-in user up and a
 * token naming somebody who does not exist fails for the wrong reason.
 */
const anyUser = await db.user.findFirstOrThrow({ where: { isActive: true } });

const routes = [...new Set(navigation.flatMap((s) => s.items).filter((i) => i.shipped).map((i) => i.href))];

/**
 * Which permission each page demands.
 *
 * Read from the page source rather than kept as a list here: a list would go
 * stale the first time a guard changed, and reporting a stale expectation as a
 * leak is how a QA script stops being believed.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function guardOf(href: string): string[] {
  const path = href.split("?")[0];
  const file =
    path === "/"
      ? join(process.cwd(), "src", "app", "(app)", "page.tsx")
      : join(process.cwd(), "src", "app", "(app)", ...path.split("/").filter(Boolean), "page.tsx");
  if (!existsSync(file)) return [];
  const source = readFileSync(file, "utf8");

  const single = /requirePermission\(\s*["'`]([\w:_]+)["'`]/.exec(source)?.[1];
  if (single) return [single];

  // Some pages guard on more than one permission and turn the visitor away
  // themselves — the till opens for whoever can sell *or* whoever can close
  // it. Reading only requirePermission would call those pages open and then
  // report everybody who is correctly refused as unreachable.
  if (/requireUser\(/.test(source) && /redirect\(\s*["'`]\//.test(source)) {
    return [...source.matchAll(/can\(\s*session\.role\s*,\s*["'`]([\w:_]+)["'`]/g)].map((m) => m[1]);
  }

  return [];
}

console.log(`── ${routes.length} pages × ${ROLES.length} roles = ${routes.length * ROLES.length} requests\n`);

let crashed = 0;
let leaked = 0;
let unreachable = 0;
let checked = 0;

for (const href of routes) {
  const guards = guardOf(href);
  const guardLabel = guards.length ? guards.join(" or ") : "(open)";
  const failures: string[] = [];

  for (const role of ROLES) {
    const token = await sessionFor(role, anyUser.id);
    const res = await fetch(`${BASE}${href}`, {
      redirect: "manual",
      headers: { Cookie: `cashmere_session=${token}` },
    });
    checked += 1;

    // Any one of them is enough: a page guarding on two permissions lets in
    // whoever holds either.
    const allowed =
      guards.length === 0 || guards.some((g) => permissionsFor(role).includes(g as never));

    if (res.status >= 500) {
      crashed += 1;
      failures.push(`${role}: crashed (${res.status})`);
      continue;
    }

    if (allowed && res.status !== 200) {
      unreachable += 1;
      failures.push(`${role}: turned away (${res.status}) despite holding ${guardLabel}`);
    }

    if (!allowed && res.status === 200) {
      leaked += 1;
      failures.push(`${role}: served content without ${guardLabel}`);
    }
  }

  if (failures.length === 0) {
    console.log(`   ✓ ${href.padEnd(34)} ${guardLabel}`);
  } else {
    console.log(`   ✗ ${href.padEnd(34)} ${guardLabel}`);
    for (const f of failures) {
      console.log(`       ${f}`);
      problems.push(`${href} — ${f}`);
    }
  }
}

console.log(`\n── ${checked} requests`);
console.log(`   crashed:     ${crashed}`);
console.log(`   leaked:      ${leaked}`);
console.log(`   unreachable: ${unreachable}`);

if (problems.length === 0) {
  console.log("\nevery page opens for everybody who should see it, and nobody else");
} else {
  console.log(`\n${problems.length} problem(s)`);
}

await db.$disconnect();
process.exit(problems.length === 0 ? 0 : 1);
