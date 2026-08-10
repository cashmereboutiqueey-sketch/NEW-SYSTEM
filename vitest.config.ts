import { defineConfig } from "vitest/config";
import path from "node:path";

const rootDir = import.meta.dirname;

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // `*.db.test.ts` needs a live PostgreSQL instance and runs under
    // vitest.integration.config.ts via `npm run test:db`. Keeping it out here
    // means `npm test` stays fast and works with no database at all.
    exclude: ["**/node_modules/**", "**/*.db.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "./src"),
      // `server-only` throws on import outside a React Server Component. It
      // exists to keep server code out of the browser bundle, which is not a
      // risk in a Node test runner, so it is stubbed out here as it is for
      // the integration run.
      "server-only": path.resolve(rootDir, "./src/test/server-only-stub.ts"),
    },
  },
});
