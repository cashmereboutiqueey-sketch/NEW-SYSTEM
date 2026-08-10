/**
 * The running application, attacked over HTTP.
 *
 * Everything here goes through the network, because that is the only way to
 * prove a claim about access control. A page that hides a column has not
 * withheld the data; a page that never renders it has. The difference is
 * visible in the bytes on the wire and nowhere else.
 *
 * Run against a dev or production server:
 *   npx tsx --conditions=react-server scripts/audit-http.ts [baseUrl]
 */
import "dotenv/config";
import { SignJWT } from "jose";
import { db } from "../src/lib/db";
import { ROLES, type Role } from "../src/core/permissions";

const BASE = process.argv[2] ?? "http://localhost:3100";

const problems: string[] = [];
const ok = (m: string) => console.log(`   ✓ ${m}`);
const bad = (m: string) => { problems.push(m); console.log(`   ✗ ${m}`); };

async function sessionFor(role: Role, userId: string): Promise<string> {
  return new SignJWT({ userId, email: `${role}@audit`, name: `Audit ${role}`, role })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
}

async function get(path: string, token?: string) {
  const res = await fetch(`${BASE}${path}`, {
    redirect: "manual",
    headers: token ? { Cookie: `cashmere_session=${token}` } : {},
  });
  const body = res.status === 200 ? await res.text() : "";
  return { status: res.status, location: res.headers.get("location") ?? "", body };
}

const owner = await db.user.findFirstOrThrow({ where: { email: "owner@cashmere.eg" } });

/* ─────────────────────────── 1. no session, no data ────────────────────── */

console.log("── an anonymous visitor");

const PROTECTED = [
  "/", "/expenses", "/inventory", "/production", "/pos", "/sales", "/customers",
  "/hr", "/settings", "/reconciliation", "/alerts", "/scenarios", "/capacity",
  "/reports/group-pnl", "/reports/entity-pnl", "/cmt/quotes", "/transfers", "/goods-in",
];

let leaked = 0;
for (const path of PROTECTED) {
  const res = await get(path);
  // A guard redirects to the login page. A 200 with content would be a leak.
  if (res.status === 200) {
    bad(`${path} served content with no session`);
    leaked++;
  } else if (!res.location.includes("/login")) {
    bad(`${path} returned ${res.status} → ${res.location || "(nowhere)"} instead of the login page`);
    leaked++;
  }
}
if (leaked === 0) ok(`all ${PROTECTED.length} protected pages send an anonymous visitor to login`);

const loginPage = await get("/login");
if (loginPage.status !== 200) bad(`the login page itself returns ${loginPage.status}`);
else ok("the login page is reachable");

/* ─────────────────────── 2. a forged session is refused ────────────────── */

console.log("\n── a forged session");

const forged = await new SignJWT({
  userId: owner.id, email: "attacker@evil", name: "Attacker", role: "OWNER",
})
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode("a-wrong-secret-that-is-long-enough-to-pass"));

const forgedRes = await get("/", forged);
if (forgedRes.status === 200) bad("a token signed with the wrong secret was accepted");
else ok("a token signed with the wrong secret is refused");

const garbage = await get("/", "not-a-token-at-all");
if (garbage.status === 200) bad("a malformed token was accepted");
else ok("a malformed token is refused");

const expired = await new SignJWT({
  userId: owner.id, email: owner.email, name: owner.name, role: owner.role,
})
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
  .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
  .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));

const expiredRes = await get("/", expired);
if (expiredRes.status === 200) bad("an expired session was accepted");
else ok("an expired session is refused");

/* ──────────────── 3. a role is sent away from what it may not see ──────── */

console.log("\n── page access by role");

// The screen each role has no business opening, and one it must be able to.
const pageMatrix: { role: Role; denied: string[]; allowed: string[] }[] = [
  { role: "POS_CASHIER", denied: ["/expenses", "/reports/group-pnl", "/settings"], allowed: ["/pos"] },
  { role: "MODERATOR", denied: ["/expenses", "/settings", "/capacity"], allowed: ["/sales"] },
  { role: "PRODUCTION", denied: ["/expenses", "/settings"], allowed: ["/production", "/inventory"] },
  { role: "MARKETING", denied: ["/expenses", "/settings", "/capacity"], allowed: ["/marketing"] },
  { role: "WAREHOUSE", denied: ["/expenses", "/settings"], allowed: ["/inventory"] },
  { role: "VIEWER", denied: ["/settings"], allowed: [] },
  { role: "HR", denied: ["/expenses", "/settings"], allowed: ["/hr"] },
];

for (const { role, denied, allowed } of pageMatrix) {
  const token = await sessionFor(role, owner.id);

  for (const path of denied) {
    const res = await get(path, token);
    // requirePermission sends an unauthorised user home rather than showing an
    // empty screen, so anything but a 200 is a correct refusal.
    if (res.status === 200) bad(`${role} could open ${path}`);
  }
  for (const path of allowed) {
    const res = await get(path, token);
    if (res.status !== 200) bad(`${role} was blocked from ${path} (${res.status})`);
  }
}
ok(`${pageMatrix.length} roles checked against the pages they may and may not open`);

/* ─────────── 4. hidden figures are absent from the wire, not just CSS ──── */

console.log("\n── whether hidden means withheld");

const salaries = await db.employee.findMany({
  select: { baseSalary: true }, take: 20,
});

if (salaries.length === 0) {
  console.log("   • no employees on file; salary withholding not exercised");
} else {
  const withSalary = await sessionFor("HR", owner.id);
  const withoutSalary = await sessionFor("PRODUCTION", owner.id);

  const seen = await get("/hr", withSalary);
  const unseen = await get("/hr", withoutSalary);

  // A distinctive salary figure, formatted the way the page formats money.
  const figures = salaries
    .map((e) => Number(e.baseSalary))
    .filter((n) => n > 999)
    .map((n) => Math.round(n).toLocaleString("en-US"));

  const leakedFigures = figures.filter((f) => unseen.status === 200 && unseen.body.includes(f));

  if (unseen.status !== 200) {
    console.log("   • PRODUCTION cannot open /hr at all, so nothing can leak from it");
  } else if (leakedFigures.length > 0) {
    bad(`a role without salary:view received salary figures in the HTML: ${leakedFigures[0]}`);
  } else {
    ok("a role without salary:view receives no salary figures in the HTML");
  }

  if (seen.status === 200 && figures.length > 0) {
    const shown = figures.some((f) => seen.body.includes(f));
    if (!shown) console.log("   • HR sees the page but no figure matched the formatting check");
    else ok("a role with salary:view does receive them");
  }
}

/* ───────────────── 5. server actions refuse the wrong role ─────────────── */

console.log("\n── server actions over HTTP");

// Next server actions need their generated id, which is embedded in the page
// that renders the form. Without a session there is no page and therefore no
// id — which is itself the finding worth stating.
const anonAction = await fetch(`${BASE}/expenses`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: "amount=1000&description=attack",
  redirect: "manual",
});
if (anonAction.status === 200) {
  const text = await anonAction.text();
  if (text.includes("attack")) bad("an anonymous POST to /expenses was processed");
  else ok("an anonymous POST to /expenses is not processed as an action");
} else ok(`an anonymous POST to /expenses returns ${anonAction.status}`);

/* ─────────────────────────── 6. injection attempts ─────────────────────── */

console.log("\n── injection and traversal");

const token = await sessionFor("OWNER", owner.id);
const nasty = [
  "/reports/entity-pnl?entity=FACTORY'%20OR%201=1--",
  "/inventory?count=%27%3B%20DROP%20TABLE%20users%3B--",
  "/reconciliation?statement=../../etc/passwd",
  "/print/labels/despatch/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd",
  "/reports/entity-pnl?entity=<script>alert(1)</script>",
];

for (const path of nasty) {
  const res = await get(path, token);
  if (res.status >= 500) bad(`${path.slice(0, 50)} caused a ${res.status}`);
  if (res.body.includes("<script>alert(1)</script>")) {
    bad(`${path.slice(0, 50)} reflected a script tag unescaped`);
  }
}

const usersStillThere = await db.user.count();
if (usersStillThere === 0) bad("the users table is gone");
else ok(`${nasty.length} injection and traversal attempts handled; ${usersStillThere} users intact`);

/* ─────────────────────── 7. nothing secret on the wire ─────────────────── */

console.log("\n── secrets on the wire");

const home = await get("/", token);
const secrets = [
  process.env.AUTH_SECRET,
  process.env.POSTGRES_PASSWORD,
  (process.env.DATABASE_URL ?? "").split("@")[0],
].filter((v): v is string => typeof v === "string" && v.length > 8);

const exposed = secrets.filter((s) => home.body.includes(s));
if (exposed.length > 0) bad(`${exposed.length} secret(s) appear in the page HTML`);
else ok("no secret appears in the rendered HTML");

if (home.body.includes("postgresql://")) bad("a database URL appears in the page HTML");
else ok("no database URL in the page HTML");

console.log("\n" + "═".repeat(58));
if (problems.length === 0) console.log("The running application refused every attack.");
else {
  console.log(`${problems.length} problem(s):\n`);
  problems.forEach((p, i) => console.log(`${i + 1}. ${p}`));
}

await db.$disconnect();
process.exit(problems.length === 0 ? 0 : 1);
