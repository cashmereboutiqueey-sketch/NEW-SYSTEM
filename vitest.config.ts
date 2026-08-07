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
    },
  },
});
