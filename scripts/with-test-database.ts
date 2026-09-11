/**
 * Run a command against the test database instead of the application's.
 *
 *   npx tsx scripts/with-test-database.ts prisma migrate deploy
 *
 * The same checks as the database test suite (src/test/test-database.ts): a
 * TEST_DATABASE_URL naming a `_test` database that is not the application's,
 * confirmed by asking the server. The command then runs with DATABASE_URL
 * replaced by it, which every script and Prisma command here already reads.
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { testDatabaseUrl, confirmTestDatabase } from "../src/test/test-database";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("Give the command to run, e.g. prisma migrate deploy");
  process.exit(1);
}

let url: string;
try {
  url = testDatabaseUrl();
  const name = await confirmTestDatabase(url);
  console.log(`── against "${name}"`);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const result = spawnSync(`npx ${[command, ...args].join(" ")}`, {
  stdio: "inherit",
  // `npx` is a .cmd shim on Windows, which only runs through a shell.
  shell: true,
  env: { ...process.env, DATABASE_URL: url },
});
process.exit(result.status ?? 1);
