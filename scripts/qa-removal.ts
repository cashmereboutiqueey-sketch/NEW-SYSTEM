/**
 * For everything the system creates: how do you undo it?
 *
 * There are four honest answers, and only the last is a gap:
 *
 *   deleted     removed outright. Right for things nothing refers to.
 *   retired     isActive false. Right for master data the history points at —
 *               a supplier with invoices must never actually disappear.
 *   cancelled   a status the workflow moves it to. Right for documents: an
 *               order is cancelled, not erased, because it happened.
 *   reversed    corrected by an opposing entry. Right for anything posted.
 *
 * A table with none of the four is something you can create and never take
 * back, which is how a system fills up with mistakes nobody can clear.
 *
 *   npx tsx --conditions=react-server scripts/qa-removal.ts
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

function files(dir: string, match: RegExp, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files(path, match, acc);
    else if (match.test(entry)) acc.push(path);
  }
  return acc;
}

const libText = files(join(ROOT, "src", "lib"), /\.ts$/)
  .filter((f) => !f.endsWith(".test.ts"))
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");

const models = [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)].map((m) => ({
  name: m[1],
  body: m[2],
}));

const client = (n: string) => n.charAt(0).toLowerCase() + n.slice(1);

/** Posted to the ledger, so the correction is a reversal rather than a removal. */
const REVERSED = new Set([
  "journalEntry", "journalLine", "inventoryMovement", "auditLog", "costSnapshot",
  "scrapRecord", "reworkRecord", "consignmentSale", "salesPayment", "return",
  "expensePayment", "consignorSettlement", "materialIssue", "payrollLine",
  "materialPriceHistory", "salaryHistory", "biometricPunch", "syncLog",
  "operatorProductivity", "productionStageLog", "qCRecord", "supplierScorecard",
  "minuteRatePeriod", "taxRate", "campaignSpend", "goodsReceipt", "settlement",
  "bankStatement", "attendanceDay", "garmentUnit", "inventoryLot",
  // A record of cloth that was physically cut. It happened; the correction for
  // a wrong one is the scrap and issue records around it, not an edit.
  "cuttingTicket",
  // Machine-written idempotency: which Shopify id is which local row, so the
  // same order cannot import twice. Nobody types one and nobody should edit
  // one — a wrong mapping is fixed by reimporting, not by hand.
  "externalMapping",
]);

const created = [
  ...new Set(
    [...libText.matchAll(/\b(?:db|tx)\.(\w+)\.(?:create|createMany|upsert)\b/g)].map((m) => m[1]),
  ),
];

/** Does the model have a status that includes a cancelled-like state? */
function cancellableStatus(model: string): string | null {
  const name = model.charAt(0).toUpperCase() + model.slice(1);
  const block = new RegExp(`^model ${name}\\s*\\{[\\s\\S]*?^\\}`, "m").exec(schema);
  if (!block) return null;

  const statusField = /^\s*status\s+(\w+)/m.exec(block[0]);
  if (!statusField) return null;

  const enumBlock = new RegExp(`^enum ${statusField[1]}\\s*\\{([\\s\\S]*?)^\\}`, "m").exec(schema);
  if (!enumBlock) return null;

  const values = enumBlock[1].split("\n").map((l) => l.trim()).filter(Boolean);
  // The words a workflow uses for "this one is over". Guessing at a short list
  // was wrong twice: TERMINATED was missing, so an employee who can be marked
  // as having left was reported as permanent, and the same for a rejected
  // quote. Anything that is plainly not an in-progress state counts.
  const off = values.find((v) =>
    /CANCELL?ED|VOID|REJECTED|CLOSED|SETTLED|REVERSED|TERMINATED|FINISHED|COMPLETED|RESOLVED|EXPIRED|ARCHIVED|INACTIVE/.test(
      v,
    ),
  );
  return off ?? null;
}

/**
 * And does anything actually move it there?
 *
 * Any write to the status field counts, not only a literal assignment of that
 * one value — a workflow that takes the status as an argument is still a way
 * out, and insisting on the literal reported two working paths as missing.
 */
function movesToStatus(model: string, status: string): boolean {
  if (new RegExp(`status:\\s*["'\`]${status}["'\`]`).test(libText)) return true;
  const writes = new RegExp(
    `\\b(?:db|tx)\\.${model}\\.update[\\s\\S]{0,400}?status:`,
    "m",
  );
  return writes.test(libText);
}

const rows: {
  model: string;
  how: "deleted" | "retired" | "cancelled" | "reversed" | "changed" | "none";
  detail: string;
}[] = [];

for (const model of created) {
  const name = model.charAt(0).toUpperCase() + model.slice(1);
  const block = new RegExp(`^model ${name}\\s*\\{[\\s\\S]*?^\\}`, "m").exec(schema);

  const deletable = new RegExp(`\\b(?:db|tx)\\.${model}\\.(delete|deleteMany)\\b`).test(libText);
  const hasIsActive = block ? /\bisActive\s+Boolean/.test(block[0]) : false;
  const updatable = new RegExp(`\\b(?:db|tx)\\.${model}\\.(update|updateMany)\\b`).test(libText);
  const status = cancellableStatus(model);

  if (deletable) rows.push({ model, how: "deleted", detail: "removed outright" });
  else if (hasIsActive && updatable) rows.push({ model, how: "retired", detail: "isActive false" });
  else if (status && movesToStatus(model, status)) {
    rows.push({ model, how: "cancelled", detail: `status → ${status}` });
  } else if (REVERSED.has(model)) {
    rows.push({ model, how: "reversed", detail: "corrected by an opposing entry" });
  } else if (updatable) {
    // Neither retired nor cancelled, but it can be corrected. A till session is
    // closed by a timestamp, a capacity config is superseded by the next one,
    // a unit is renamed. None of those needs an off switch, and reporting them
    // as permanent — which this did — buries the two that genuinely are.
    rows.push({ model, how: "changed", detail: "corrected in place, not switched off" });
  } else if (status) {
    rows.push({ model, how: "none", detail: `has a ${status} status that nothing sets` });
  } else {
    rows.push({ model, how: "none", detail: "created and never touched again" });
  }
}

const order = { none: 0, cancelled: 1, retired: 2, deleted: 3, changed: 4, reversed: 5 } as const;
rows.sort((a, b) => order[a.how] - order[b.how] || a.model.localeCompare(b.model));

const label: Record<string, string> = {
  deleted: "✓ deleted ",
  retired: "✓ retired ",
  cancelled: "✓ cancelled",
  reversed: "✓ reversed",
  changed: "✓ editable ",
  none: "✗ NO WAY BACK",
};

console.log(`── ${rows.length} models the application creates\n`);
for (const r of rows) {
  console.log(`   ${label[r.how].padEnd(13)} ${r.model.padEnd(26)} ${r.detail}`);
}

const gaps = rows.filter((r) => r.how === "none");
const counts = rows.reduce<Record<string, number>>((acc, r) => {
  acc[r.how] = (acc[r.how] ?? 0) + 1;
  return acc;
}, {});

console.log(
  `\n   deleted ${counts.deleted ?? 0} · retired ${counts.retired ?? 0} · ` +
    `cancelled ${counts.cancelled ?? 0} · reversed ${counts.reversed ?? 0} · ` +
    `no way back ${gaps.length}`,
);

if (gaps.length === 0) {
  console.log("\neverything the system creates can be taken back somehow");
} else {
  console.log(`\n${gaps.length} to decide about:`);
  for (const g of gaps) console.log(`   ${g.model} — ${g.detail}`);
}
