/**
 * The authorisation matrix, proven rather than assumed.
 *
 * This half is static: it checks that the permission map is coherent, that
 * segregated duties really are separated, and that every server action reaches
 * an authorization guard before it does anything. It deliberately imports
 * nothing that touches the database or Next's runtime, so it can be run
 * anywhere, including in CI before a deployment.
 *
 * The live half — a real session for a real role being refused over HTTP — is
 * `audit-http.ts`, because a screen that merely hides its buttons is not
 * access control and only a request can prove otherwise.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ROLES,
  PERMISSIONS,
  can,
  SEGREGATED_DUTIES,
  violatesSeparationOfDuties,
  type Role,
  type Permission,
} from "../src/core/permissions";

const problems: string[] = [];
const ok = (m: string) => console.log(`   ✓ ${m}`);
const bad = (m: string) => { problems.push(m); console.log(`   ✗ ${m}`); };

/* ───────────────────────────── the map is coherent ─────────────────────── */

console.log("── the permission map");

const grants = new Map<Role, Permission[]>();
for (const role of ROLES) grants.set(role, PERMISSIONS.filter((p) => can(role, p)));

const ownerHolds = grants.get("OWNER")!.length;
if (ownerHolds !== PERMISSIONS.length) {
  bad(`OWNER holds ${ownerHolds} of ${PERMISSIONS.length} permissions; it is meant to hold all`);
} else ok(`OWNER holds all ${PERMISSIONS.length} permissions`);

const otherBlanket = ROLES.filter(
  (r) => r !== "OWNER" && grants.get(r)!.length === PERMISSIONS.length,
);
if (otherBlanket.length > 0) bad(`also all-powerful: ${otherBlanket.join(", ")}`);
else ok("no other role holds everything");

const viewerMutations = grants
  .get("VIEWER")!
  .filter((p) => !/:view$|^report:/.test(p));
if (viewerMutations.length > 0) bad(`VIEWER can mutate: ${viewerMutations.join(", ")}`);
else ok("VIEWER holds only read rights");

/* ───────────────────────────── segregation of duties ───────────────────── */

console.log("\n── segregation of duties");

for (const [a, b] of SEGREGATED_DUTIES) {
  const offenders = ROLES.filter((r) => r !== "OWNER" && can(r, a) && can(r, b));
  if (offenders.length > 0) bad(`${a} + ${b} both held by ${offenders.join(", ")}`);
  else ok(`${a} is separated from ${b}`);
}

// The role check above is one half. The other is the same *person* approving
// their own document, which no role map can prevent.
for (const [createPermission, approvePermission] of SEGREGATED_DUTIES) {
  const sameHand = violatesSeparationOfDuties({
    creatorUserId: "u1", approverUserId: "u1", createPermission, approvePermission,
  });
  const twoHands = violatesSeparationOfDuties({
    creatorUserId: "u1", approverUserId: "u2", createPermission, approvePermission,
  });
  if (!sameHand) bad(`one person can both ${createPermission} and ${approvePermission}`);
  if (twoHands) bad(`two different people are wrongly blocked on ${createPermission}`);
}
ok("the same person cannot approve what they created");

/* ───────────────────── every guard names a real permission ─────────────── */

console.log("\n── the guards in the code");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.(ts|tsx)$/.test(path)) out.push(path);
  }
  return out;
}

const files = [...walk("src/app"), ...walk("src/lib")].filter((f) => !f.endsWith(".test.ts"));

const guarded = new Set<string>();
const checkedByCan = new Set<string>();
let guardCount = 0;

for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/(?:authorize|requirePermission)\(\s*"([^"]+)"/g)) {
    guarded.add(m[1]);
    guardCount++;
  }
  for (const m of text.matchAll(/\bcan\(\s*[\w.]+\s*,\s*"([^"]+)"/g)) {
    checkedByCan.add(m[1]);
  }
}

const invented = [...guarded, ...checkedByCan].filter(
  (p) => !(PERMISSIONS as readonly string[]).includes(p),
);
if (invented.length > 0) bad(`guards naming permissions that do not exist: ${invented.join(", ")}`);
else ok(`${guardCount} hard guards, all naming real permissions`);

// A permission checked only with `can` gates what is rendered, not what is
// fetched. That is fine for hiding a column on a server-rendered page and
// wrong for anything that mutates.
const softOnly = [...checkedByCan].filter((p) => !guarded.has(p));
if (softOnly.length > 0) {
  console.log(`   • display-only checks (server-rendered, never sent to the browser): ${softOnly.join(", ")}`);
}

const never = PERMISSIONS.filter((p) => !guarded.has(p) && !checkedByCan.has(p));
if (never.length > 0) {
  console.log(`   • ${never.length} permission(s) nothing checks yet: ${never.join(", ")}`);
}

/* ─────────────────── every server action reaches a guard ───────────────── */

console.log("\n── server actions");

// Sign-in and preference actions are unauthenticated by definition: a login
// that required a session could never be used.
const OPEN_BY_DESIGN = new Set(["loginAction", "logoutAction", "setLocaleAction"]);

let unguarded = 0;
let actionCount = 0;

for (const file of files.filter((f) => f.endsWith("actions.ts"))) {
  const text = readFileSync(file, "utf8");
  if (!text.includes('"use server"')) continue;

  const actions = [...text.matchAll(/export async function (\w+)\s*\(/g)].map((m) => m[1]);
  for (const action of actions) {
    actionCount++;
    if (OPEN_BY_DESIGN.has(action)) continue;

    const start = text.indexOf(`export async function ${action}`);
    const next = text.indexOf("export async function ", start + 10);
    const body = text.slice(start, next === -1 ? undefined : next);

    if (!/authorize\(|requirePermission\(|requireUser\(|getSession\(/.test(body)) {
      bad(`${file} :: ${action}() reaches no authorization guard`);
      unguarded++;
    }
  }
}
if (unguarded === 0) ok(`${actionCount} server actions, every one guarded or open by design`);

/* ──────────────── the refusals that would actually hurt ────────────────── */

console.log("\n── dangerous combinations");

const dangerous: [Role, Permission][] = [
  ["VIEWER", "journal:post"], ["VIEWER", "inventory:adjust"],
  ["POS_CASHIER", "journal:post"], ["POS_CASHIER", "sales_order:refund"],
  ["POS_CASHIER", "salary:view"], ["POS_CASHIER", "settings:manage"],
  ["MODERATOR", "sales_order:discount"], ["MODERATOR", "inventory:adjust"],
  ["PRODUCTION", "salary:view"], ["PRODUCTION", "payroll:approve"],
  ["PRODUCTION", "journal:post"],
  ["MARKETING", "journal:post"], ["MARKETING", "customer:export"],
  ["WAREHOUSE", "journal:post"], ["WAREHOUSE", "transfer_price:view"],
  ["HR", "journal:post"], ["HR", "inventory:adjust"],
  ["ACCOUNTANT", "expense:approve"], ["ACCOUNTANT", "payment:approve"],
  ["ACCOUNTANT", "period:close"], ["ACCOUNTANT", "payroll:approve"],
  ["BRAND_MANAGER", "journal:post"], ["BRAND_MANAGER", "salary:view"],
  ["SERVICE_ACCOUNT", "journal:post"], ["SERVICE_ACCOUNT", "settings:manage"],
];

let allowed = 0;
for (const [role, permission] of dangerous) {
  if (can(role, permission)) { bad(`${role} CAN ${permission} — it should not`); allowed++; }
}
if (allowed === 0) ok(`${dangerous.length} dangerous combinations all refused`);

console.log("\n" + "═".repeat(58));
if (problems.length === 0) console.log("The authorisation map is coherent and enforced in code.");
else {
  console.log(`${problems.length} authorisation problem(s):\n`);
  problems.forEach((p, i) => console.log(`${i + 1}. ${p}`));
}

process.exit(problems.length === 0 ? 0 : 1);
