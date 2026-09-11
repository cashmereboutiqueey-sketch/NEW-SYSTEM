import { testDatabaseUrl, confirmTestDatabase } from "./test-database";

/**
 * Runs once, before a single database test file is loaded: the server is asked
 * which database the connection reached, and the run stops unless it is a
 * `_test` one. See test-database.ts for why the URL alone is not enough.
 */
export default async function setup(): Promise<void> {
  const name = await confirmTestDatabase(testDatabaseUrl());
  console.log(`database tests: running against "${name}"`);
}
