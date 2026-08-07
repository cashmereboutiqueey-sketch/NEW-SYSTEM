import { defineConfig } from "vitest/config";
import path from "node:path";

const rootDir = import.meta.dirname;

/**
 * Integration tests run against a real PostgreSQL database, because the
 * invariants they check (balanced journals, immutable postings, period locks)
 * are enforced by database triggers. A mocked database would prove nothing —
 * it would test the mock.
 *
 * Kept separate from `vitest.config.ts` so `npm test` stays fast and needs no
 * database.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.db.test.ts"],
    // Postgres serialises the conflicting writes these tests provoke, and
    // shared seed rows make parallel files flaky.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "./src"),
    },
  },
});
