import "dotenv/config";
import { defineConfig } from "vitest/config";
import path from "node:path";
import { testDatabaseUrl } from "./src/test/test-database";

const rootDir = import.meta.dirname;

/**
 * Integration tests run against a real PostgreSQL database, because the
 * invariants they check (balanced journals, immutable postings, period locks)
 * are enforced by database triggers. A mocked database would prove nothing —
 * it would test the mock.
 *
 * Kept separate from `vitest.config.ts` so `npm test` stays fast and needs no
 * database.
 *
 * They also delete data wholesale, so they run only against TEST_DATABASE_URL,
 * which must name a `_test` database other than the application's. Checked
 * here as the config loads, again against the server before any file runs,
 * and once more inside each worker. See src/test/test-database.ts.
 */
const databaseUrl = testDatabaseUrl();

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.db.test.ts"],
    // Every file, and every service it calls, reads DATABASE_URL. Workers are
    // given the test database under that name, and the files' own
    // `dotenv/config` does not overwrite a variable already set.
    env: { DATABASE_URL: databaseUrl },
    globalSetup: ["./src/test/db-global-setup.ts"],
    setupFiles: ["./src/test/db-worker-guard.ts"],
    // Postgres serialises the conflicting writes these tests provoke, and
    // shared seed rows make parallel files flaky.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "./src"),
      // `server-only` throws on import outside a React Server Component. It is
      // there to stop server code reaching the browser bundle, which is not a
      // risk in a Node test runner, so it is stubbed out here.
      "server-only": path.resolve(rootDir, "./src/test/server-only-stub.ts"),
    },
  },
});
