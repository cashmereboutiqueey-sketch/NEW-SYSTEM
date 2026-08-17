/**
 * Is there a button behind every action, and an action behind every button?
 *
 * Two failures that no test suite catches, because nothing is broken in
 * either:
 *
 *   An orphan action. Written, guarded, tested, and reachable from no screen.
 *   The feature exists and nobody can use it — which is exactly how the scrap
 *   screen sat for months reading a table nothing wrote.
 *
 *   A dead form. A form on a page whose action does not exist, or whose
 *   handler was renamed. It looks like a working button until somebody
 *   presses it.
 *
 * Also reports what can be created but never changed or removed, because a
 * system you can only add to is one that fills up with mistakes. Where a
 * refusal is deliberate — a posted journal is corrected by reversal, never
 * edited — it is listed as intended rather than missing.
 *
 *   npx tsx --conditions=react-server scripts/qa-actions.ts
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const APP = join(ROOT, "src", "app", "(app)");
const LIB = join(ROOT, "src", "lib");

const problems: string[] = [];
const notes: string[] = [];

function files(dir: string, match: RegExp, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files(path, match, acc);
    } else if (match.test(entry)) {
      acc.push(path);
    }
  }
  return acc;
}

const appFiles = files(APP, /\.tsx?$/);
const libFiles = files(LIB, /\.ts$/).filter((f) => !f.endsWith(".test.ts"));
const appText = appFiles.map((f) => readFileSync(f, "utf8")).join("\n");

/* ───────────────────────── 1. every action has a caller ─────────────────── */

console.log("── server actions");

type Action = { name: string; file: string; guard: string | null; dynamicGuard: boolean };
const actions: Action[] = [];

for (const file of appFiles) {
  const source = readFileSync(file, "utf8");
  if (!/^["']use server["']/m.test(source)) continue;

  for (const m of source.matchAll(/export async function (\w+)\s*\(/g)) {
    const name = m[1];
    // The guard inside this function, if it declares one.
    const body = source.slice(m.index ?? 0);
    const head = body.slice(0, 900);
    const guard = /authorize\(\s*["'`]([\w:_]+)["'`]/.exec(head)?.[1] ?? null;
    // An authorize() whose permission is worked out rather than written out.
    const dynamicGuard = guard === null && head.includes("authorize(");
    actions.push({ name, file: relative(ROOT, file), guard, dynamicGuard });
  }
}

const orphans = actions.filter((a) => {
  // Referenced anywhere outside the file that defines it: imported by a form,
  // passed to useActionState, or used as a form action.
  const uses = appFiles.filter((f) => {
    if (relative(ROOT, f) === a.file) return false;
    return new RegExp(`\\b${a.name}\\b`).test(readFileSync(f, "utf8"));
  });
  return uses.length === 0;
});

console.log(`   ${actions.length} actions across ${new Set(actions.map((a) => a.file)).size} files`);
if (orphans.length === 0) {
  console.log("   ✓ every action is reachable from a screen");
} else {
  for (const o of orphans) {
    console.log(`   ✗ ${o.name} (${o.file}) — no screen calls it`);
    problems.push(`orphan action: ${o.name} in ${o.file}`);
  }
}

// Guards are not always a literal. Freezing a costing asks for a higher
// permission when the markup is being overridden than when it is not, which is
// a better guard than a static one and would be reported as none by a check
// that only reads strings.
const unguarded = actions.filter((a) => a.guard === null && !a.dynamicGuard);
const dynamic = actions.filter((a) => a.dynamicGuard);

if (dynamic.length > 0) {
  console.log(`   ${dynamic.length} action(s) choose their permission at runtime, which is fine`);
}

if (unguarded.length > 0) {
  console.log(`   • ${unguarded.length} action(s) with no authorize() at all:`);
  for (const u of unguarded) console.log(`       ${u.name} (${u.file})`);
  notes.push(`${unguarded.length} actions to confirm are open by design`);
} else {
  console.log("   ✓ every action authorises before it acts");
}

/* ────────────────────────── 2. every form has an action ─────────────────── */

console.log("\n── forms");

let forms = 0;
let broken = 0;

for (const file of appFiles) {
  const source = readFileSync(file, "utf8");

  // The names useActionState binds in this file. A form pointing at one of
  // these is wired correctly — the binding is the action, renamed locally.
  const bound = new Set(
    [...source.matchAll(/const\s*\[[^\]]*?,\s*(\w+)[^\]]*\]\s*=\s*useActionState/g)].map(
      (m) => m[1],
    ),
  );

  // A client form wired to a server action via useActionState.
  for (const m of source.matchAll(/useActionState\(\s*(\w+)/g)) {
    forms += 1;
    const handler = m[1];
    const known = actions.some((a) => a.name === handler);
    const imported = new RegExp(`import[^;]*\\b${handler}\\b`).test(source);
    // Or chosen locally: the approvals screen picks between approving an
    // expense and approving a purchase order before binding either.
    const local = new RegExp(`const\\s+${handler}\\s*[=:]`).test(source);
    if (!known && !imported && !local) {
      broken += 1;
      console.log(`   ✗ ${relative(ROOT, file)} posts to ${handler}, which does not exist`);
      problems.push(`dead form: ${handler} in ${relative(ROOT, file)}`);
    }
  }

  // A plain <form action={...}> pointing at a server action.
  for (const m of source.matchAll(/<form[^>]*action=\{(\w+)\}/g)) {
    const handler = m[1];
    if (bound.has(handler)) continue; // the useActionState binding, already counted
    forms += 1;
    if (!actions.some((a) => a.name === handler) && !new RegExp(`import[^;]*\\b${handler}\\b`).test(source)) {
      broken += 1;
      console.log(`   ✗ ${relative(ROOT, file)} posts to ${handler}, which does not exist`);
      problems.push(`dead form: ${handler} in ${relative(ROOT, file)}`);
    }
  }
}

console.log(`   ${forms} form(s) wired to an action`);
if (broken === 0) console.log("   ✓ every form posts to something that exists");

/* ──────────────────── 3. what can be created but never changed ──────────── */

console.log("\n── can you undo what you did?");

/**
 * Things the system deliberately refuses to change, and why. Listed here so
 * the report says "intended" rather than "missing" — an audit that cannot
 * tell a rule from a gap trains people to skip its output.
 */
const IMMUTABLE_BY_DESIGN: Record<string, string> = {
  journalEntry: "corrected by posting a reversal; the original never changes",
  journalLine: "part of a posted entry",
  costSnapshot: "frozen so historical costings stay true",
  inventoryMovement: "the record of what physically happened",
  auditLog: "the point of it is that it cannot be edited",
  scrapRecord: "posted to the ledger; correct by reversing the journal",
  reworkRecord: "posted to the ledger; correct by reversing the journal",
  consignmentSale: "posted to the ledger",
  salesPayment: "posted to the ledger",
  return: "posted to the ledger",
  minuteRatePeriod: "versioned; a new period supersedes rather than edits",
  taxRate: "effective-dated; a new row supersedes rather than edits",
  operatorProductivity: "one row per operator per day, replaced by re-recording",
};

const libText = libFiles.map((f) => readFileSync(f, "utf8")).join("\n");

const createdModels = [
  ...new Set(
    [...libText.matchAll(/\b(?:db|tx)\.(\w+)\.(?:create|createMany|upsert)\b/g)].map((m) => m[1]),
  ),
];

const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");

/**
 * Whether a model is retired rather than deleted.
 *
 * Anything the history refers to must never actually be removed — a supplier
 * with invoices against them, a style with sales behind it. Setting isActive
 * false is the delete path for those, and calling that a missing feature would
 * push somebody towards adding a destructive one.
 */
function softDeleted(model: string): boolean {
  const name = model.charAt(0).toUpperCase() + model.slice(1);
  const block = new RegExp(`^model ${name}\\s*\\{[\\s\\S]*?^\\}`, "m").exec(schema);
  if (!block || !/\bisActive\s+Boolean/.test(block[0])) return false;
  return new RegExp(`\\b(?:db|tx)\\.${model}\\.(update|updateMany)\\b`).test(libText);
}

const noEdit: string[] = [];
const noDelete: string[] = [];
const retired: string[] = [];

for (const model of createdModels) {
  if (IMMUTABLE_BY_DESIGN[model]) continue;
  const editable = new RegExp(`\\b(?:db|tx)\\.${model}\\.(update|updateMany|upsert)\\b`).test(libText);
  const deletable = new RegExp(`\\b(?:db|tx)\\.${model}\\.(delete|deleteMany)\\b`).test(libText);
  if (!editable) noEdit.push(model);
  if (!deletable) {
    if (softDeleted(model)) retired.push(model);
    else noDelete.push(model);
  }
}

console.log(`   ${createdModels.length} models are created by the application`);
console.log(
  `   ${Object.keys(IMMUTABLE_BY_DESIGN).length} are deliberately immutable (reversal or supersession instead)`,
);

if (noEdit.length === 0) {
  console.log("   ✓ everything else can be edited");
} else {
  console.log(`   • created but never updated anywhere: ${noEdit.join(", ")}`);
  notes.push(`${noEdit.length} model(s) with no edit path`);
}

if (retired.length > 0) {
  console.log(`   ${retired.length} are retired rather than deleted, which is right: ${retired.join(", ")}`);
}

if (noDelete.length === 0) {
  console.log("   ✓ everything else can be removed");
} else {
  console.log(`   • no way to remove or retire: ${noDelete.join(", ")}`);
  notes.push(`${noDelete.length} model(s) with no delete path`);
}

/* ─────────────────────────────── the verdict ────────────────────────────── */

console.log(
  `\n${problems.length === 0 ? "no dead buttons and no unreachable actions" : `${problems.length} problem(s)`}` +
    `${notes.length ? `, ${notes.length} thing(s) to look at` : ""}`,
);

process.exit(problems.length === 0 ? 0 : 1);
