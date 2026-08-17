/**
 * Is the database actually wired to the application?
 *
 * The schema can be perfect and the books can balance while a table nobody
 * reads quietly fills up, a setting the code depends on was never seeded, a
 * menu entry points at a page that does not exist, or a permission is declared
 * and never checked. None of those show up in a test suite, because nothing is
 * broken — there is simply nothing there.
 *
 * Everything here is derived from the files and the live database, never from
 * a list kept by hand: a hand-kept list goes stale the first time somebody
 * adds a model and forgets to update it, which is the same failure this is
 * meant to catch.
 *
 *   npx tsx --conditions=react-server scripts/audit-wiring.ts
 */
import "dotenv/config";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { db } from "../src/lib/db";
import { navigation } from "../src/lib/navigation";
import { PERMISSIONS, ROLES, permissionsFor } from "../src/core/permissions";
import { dictionary } from "../src/lib/i18n";

const ROOT = process.cwd();
const problems: string[] = [];
const warnings: string[] = [];

const ok = (m: string) => console.log(`   ✓ ${m}`);
const bad = (m: string) => { problems.push(m); console.log(`   ✗ ${m}`); };
const warn = (m: string) => { warnings.push(m); console.log(`   ⚠ ${m}`); };

/** Every .ts/.tsx under a directory, tests and generated code excluded. */
function sources(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "generated" || entry === "node_modules" || entry === ".next") continue;
      sources(path, acc);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      acc.push(path);
    }
  }
  return acc;
}

const appFiles = [
  ...sources(join(ROOT, "src")),
  ...sources(join(ROOT, "scripts")),
  join(ROOT, "prisma", "seed.ts"),
  join(ROOT, "prisma", "demo.ts"),
].filter(existsSync);

const code = appFiles.map((f) => ({ path: f, text: readFileSync(f, "utf8") }));
const allCode = code.map((c) => c.text).join("\n");

/** Only the application itself — scripts and seeds do not count as "used". */
const appOnly = code
  .filter((c) => c.path.includes(`${join("src", "")}`))
  .map((c) => c.text)
  .join("\n");

/* ──────────────────────────── 1. every table is reachable ───────────────── */

console.log("\n── every table the schema declares, does anything read it?");

const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");
const models = [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)].map((m) => ({
  name: m[1],
  body: m[2],
  table: /@@map\("([^"]+)"\)/.exec(m[2])?.[1] ?? m[1],
}));

const client = (name: string) => name.charAt(0).toLowerCase() + name.slice(1);

/**
 * The names a parent uses for this model when it writes it as a nested create.
 *
 * A child row is very often never touched through its own client accessor:
 * purchase order lines are written as `lines: { create: [...] }` inside the
 * order, and looking only for `db.purchaseOrderLine.create` reports a table
 * that is written on every single purchase order as dead.
 */
function relationFieldsTo(target: string): string[] {
  const names = new Set<string>();
  for (const model of models) {
    for (const line of model.body.split("\n")) {
      const m = /^\s*(\w+)\s+([A-Z]\w*)(\[\])?\s*(@|$)/.exec(line);
      if (m && m[2] === target) names.add(m[1]);
    }
  }
  return [...names];
}

/**
 * Whether anything reaches this model at all — by any of the three routes.
 *
 * The client accessor is the obvious one. Nested writes through a parent are
 * the second: a purchase order line is never written any other way. Raw SQL
 * against the table name is the third, and it is not a smell — document
 * numbers are allocated by an atomic upsert precisely because two people
 * saving at once must not receive the same number, and no ORM call can do
 * that safely.
 */
const touched = (name: string, table: string, haystack: string) => {
  if (new RegExp(`\\b(?:db|tx|prisma)\\.${client(name)}\\b`).test(haystack)) return true;
  if (new RegExp(`["'\`]\\s*${table}\\s*["'\`]`).test(haystack)) return true;
  return relationFieldsTo(name).some((field) =>
    new RegExp(`\\b${field}\\s*:\\s*\\{\\s*(create|createMany|connect|update|set)`).test(haystack),
  );
};

const unused: string[] = [];
const seedOnly: string[] = [];
for (const model of models) {
  if (touched(model.name, model.table, appOnly)) continue;
  if (touched(model.name, model.table, allCode)) seedOnly.push(model.name);
  else unused.push(model.name);
}

if (unused.length === 0) ok(`all ${models.length} models are read by something`);
else warn(`${unused.length} model(s) nothing reads at all: ${unused.join(", ")}`);
if (seedOnly.length) {
  warn(`${seedOnly.length} model(s) only ever touched by seeds or scripts: ${seedOnly.join(", ")}`);
}

/* ────────────────────────── 2. every table holds rows ───────────────────── */

console.log("\n── and does anything actually put rows in it?");

const counts = await db.$queryRaw<{ table_name: string; n: bigint }[]>`
  SELECT relname AS table_name, n_live_tup AS n
  FROM pg_stat_user_tables WHERE schemaname = 'public' ORDER BY relname
`;
const rowsFor = new Map(counts.map((c) => [c.table_name, Number(c.n)]));

const empty = models
  .filter((m) => (rowsFor.get(m.table) ?? 0) === 0)
  .map((m) => `${m.name}`);

if (empty.length === 0) ok("every table has rows on the demo");
else {
  // Not a fault by itself — plenty of tables are genuinely empty until the
  // feature is used. It is a fault when the table is empty *and* nothing
  // writes to it, which is the intersection reported below.
  console.log(`     ${empty.length} of ${models.length} tables are empty on this demo`);
  const writes = (name: string, table: string) =>
    new RegExp(`\\b(?:db|tx|prisma)\\.${client(name)}\\.(create|createMany|upsert)`).test(allCode) ||
    // Raw SQL, which is how document sequences are allocated: two people
    // saving at once must not be handed the same number, and no ORM call can
    // guarantee that the way an atomic upsert can.
    new RegExp(`INSERT INTO\\s+"?${table}"?`, "i").test(allCode) ||
    // Nested creates through the parent count: a purchase order line is never
    // written any other way.
    relationFieldsTo(name).some((field) =>
      new RegExp(`\\b${field}\\s*:\\s*\\{\\s*(create|createMany)`).test(allCode),
    );
  const neverWritten = empty.filter((n) => {
    const model = models.find((m) => m.name === n)!;
    return !writes(model.name, model.table);
  });
  if (neverWritten.length === 0) ok("every empty table has code that would fill it");
  else warn(`empty and nothing ever creates a row: ${neverWritten.join(", ")}`);
}

/* ─────────────────────── 3. no orphans behind a nullable FK ─────────────── */

console.log("\n── orphan rows");

const fks = await db.$queryRaw<
  { child: string; col: string; parent: string; parent_col: string; nullable: string }[]
>`
  SELECT tc.table_name AS child, kcu.column_name AS col,
         ccu.table_name AS parent, ccu.column_name AS parent_col,
         c.is_nullable AS nullable
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
  JOIN information_schema.columns c
    ON c.table_name = tc.table_name AND c.column_name = kcu.column_name
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
  ORDER BY tc.table_name, kcu.column_name
`;

let orphans = 0;
for (const fk of fks) {
  const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*)::bigint AS n FROM "${fk.child}" c
     LEFT JOIN "${fk.parent}" p ON p."${fk.parent_col}" = c."${fk.col}"
     WHERE c."${fk.col}" IS NOT NULL AND p."${fk.parent_col}" IS NULL`,
  );
  const n = Number(rows[0]?.n ?? 0);
  if (n > 0) {
    orphans += 1;
    bad(`${fk.child}.${fk.col} has ${n} row(s) pointing at a missing ${fk.parent}`);
  }
}
if (orphans === 0) ok(`no orphans across all ${fks.length} foreign keys`);

/* ─────────────────────── 4. settings the code depends on ────────────────── */

console.log("\n── settings");

// Only the accessors that actually fetch a setting. Matching every quoted
// dotted string instead swept in `startsWith: "factory.mark"` from a script
// and reported a key nobody had ever claimed existed — an audit that invents
// problems is one people stop reading.
const referenced = new Set<string>();
for (const m of allCode.matchAll(
  /\b(?:settingValue|settingNumber|settingFlag|setting)\s*\(\s*["'`]([\w.]+)["'`]/g,
)) {
  referenced.add(m[1]);
}

const stored = new Set((await db.setting.findMany({ select: { key: true } })).map((s) => s.key));

const missing = [...referenced].filter((k) => !stored.has(k));
if (missing.length === 0) ok(`all ${referenced.size} setting keys the code fetches exist in the database`);
else bad(`code fetches settings that are not in the database: ${missing.join(", ")}`);

// The other direction is looser on purpose: a key can legitimately be named
// in a map or a validation table rather than fetched by name, so the plain
// text of the code counts here.
const unread = [...stored].filter((k) => !allCode.includes(k));
if (unread.length === 0) ok(`every one of the ${stored.size} stored settings is named somewhere in the code`);
else warn(`stored but never mentioned in the code: ${unread.join(", ")}`);

/* ──────────────────────── 5. navigation points somewhere ────────────────── */

console.log("\n── navigation");

const items = navigation.flatMap((s) => s.items);
let brokenLinks = 0;

for (const item of items) {
  if (!item.shipped) continue;
  const path = item.href.split("?")[0];
  const dir = join(ROOT, "src", "app", "(app)", ...path.split("/").filter(Boolean));
  const isRoot = path === "/";
  const exists =
    isRoot
      ? existsSync(join(ROOT, "src", "app", "(app)", "page.tsx"))
      : existsSync(join(dir, "page.tsx"));
  if (!exists) {
    brokenLinks += 1;
    bad(`menu entry "${item.key}" → ${item.href} has no page`);
  }
}
if (brokenLinks === 0) ok(`all ${items.filter((i) => i.shipped).length} shipped menu entries resolve to a page`);

// Every menu key must have a translation, or the sidebar shows a raw key.
const untranslated = items.filter((i) => !(i.key in dictionary));
if (untranslated.length === 0) ok("every menu entry has a translation");
else bad(`menu entries with no translation: ${untranslated.map((i) => i.key).join(", ")}`);

// And the other direction: a page nobody can navigate to.
const appDir = join(ROOT, "src", "app", "(app)");
const pageDirs: string[] = [];
(function walk(dir: string, prefix: string) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (!statSync(path).isDirectory()) continue;
    if (entry.startsWith("(") || entry.startsWith("_") || entry.startsWith("[")) {
      walk(path, prefix);
      continue;
    }
    const route = `${prefix}/${entry}`;
    if (existsSync(join(path, "page.tsx"))) pageDirs.push(route);
    walk(path, route);
  }
})(appDir, "");

const linkedPaths = new Set(items.map((i) => i.href.split("?")[0]));
const unreachable = pageDirs.filter(
  (p) => !linkedPaths.has(p) && !allCode.includes(`href="${p}"`) && !allCode.includes(`href={\`${p}`),
);
if (unreachable.length === 0) ok(`all ${pageDirs.length} pages are linked from somewhere`);
else warn(`pages with no link to them: ${unreachable.join(", ")}`);

/* ───────────────────────────── 6. permissions ───────────────────────────── */

console.log("\n── permissions");

const unchecked = PERMISSIONS.filter(
  (p) => !new RegExp(`["'\`]${p.replace(":", "\\:")}["'\`]`).test(appOnly.replace(/permissions\.ts[\s\S]*?$/, "")),
);
const reallyUnchecked = PERMISSIONS.filter((p) => {
  // Counted only where it is enforced, not where the list itself is declared.
  const enforced = code.filter(
    (c) => !c.path.endsWith("permissions.ts") && c.text.includes(`"${p}"`),
  );
  return enforced.length === 0;
});

if (reallyUnchecked.length === 0) ok(`all ${PERMISSIONS.length} permissions are checked somewhere`);
else warn(`${reallyUnchecked.length} permission(s) declared but never enforced: ${reallyUnchecked.join(", ")}`);

// A role holding a permission that does not exist would silently grant nothing.
const bogus: string[] = [];
for (const role of ROLES) {
  for (const p of permissionsFor(role)) {
    if (!PERMISSIONS.includes(p)) bogus.push(`${role} → ${p}`);
  }
}
if (bogus.length === 0) ok("every role's permissions all exist");
else bad(`roles granted permissions that do not exist: ${bogus.join(", ")}`);

// A permission no role can ever hold is a rule nobody can satisfy.
const grantedToNobody = PERMISSIONS.filter(
  (p) => !ROLES.some((r) => permissionsFor(r).includes(p)),
);
if (grantedToNobody.length === 0) ok("every permission is held by at least one role");
else bad(`permissions no role can hold: ${grantedToNobody.join(", ")}`);

/* ──────────────────────── 7. money is never a float ─────────────────────── */

console.log("\n── money columns");

const floats = await db.$queryRaw<{ col: string }[]>`
  SELECT table_name || '.' || column_name AS col
  FROM information_schema.columns
  WHERE table_schema = 'public' AND data_type IN ('double precision', 'real', 'money')
`;
if (floats.length === 0) ok("no floating-point column anywhere in the schema");
else bad(`floating point used for numbers: ${floats.map((f) => f.col).join(", ")}`);

// Decimal(18,4) or better wherever a column really is money.
//
// A name containing "price" is not enough on its own: priceScore is a mark
// out of ten and priceVariancePct is a percentage, and both are correctly
// narrower than money. Percentages, scores and rates are excluded by suffix
// rather than by being listed, so a new one does not have to be remembered.
const thin = await db.$queryRaw<{ col: string; p: number; s: number }[]>`
  SELECT table_name || '.' || column_name AS col,
         numeric_precision AS p, numeric_scale AS s
  FROM information_schema.columns
  WHERE table_schema = 'public' AND data_type = 'numeric'
    AND (column_name ILIKE '%amount%' OR column_name ILIKE '%cost%' OR column_name ILIKE '%price%'
      OR column_name ILIKE '%total%' OR column_name ILIKE '%debit%' OR column_name ILIKE '%credit%'
      OR column_name ILIKE '%balance%' OR column_name ILIKE '%paid%')
    AND column_name NOT ILIKE '%pct%'
    AND column_name NOT ILIKE '%score%'
    AND column_name NOT ILIKE '%rate%'
    AND column_name NOT ILIKE '%variance%'
    AND column_name NOT ILIKE '%days%'
    AND (numeric_precision < 18 OR numeric_scale < 2)
`;
if (thin.length === 0) ok("every money column carries at least 18 digits and 2 decimals");
else bad(`money columns too small: ${thin.map((t) => `${t.col} (${t.p},${t.s})`).join(", ")}`);

/* ─────────────────────────────── the verdict ────────────────────────────── */

console.log(
  `\n${problems.length === 0 ? "nothing broken" : `${problems.length} problem(s)`}` +
    `${warnings.length ? `, ${warnings.length} thing(s) worth a look` : ""}`,
);
await db.$disconnect();
process.exit(problems.length === 0 ? 0 : 1);
