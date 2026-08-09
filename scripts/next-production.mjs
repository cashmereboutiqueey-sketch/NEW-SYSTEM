/**
 * Runs `next build` / `next start` against a separate output directory.
 *
 * `next build` and `next dev` both write to `.next` by default, so building
 * while a dev server is running replaces the chunks that server has already
 * handed to the browser, and the page dies with a bare
 * `__webpack_modules__[moduleId] is not a function` that names neither cause.
 *
 * The directory has to come from the environment rather than be sniffed from
 * `process.argv` inside `next.config.ts`: Next evaluates that config again in
 * its build workers, where the arguments are different, and the output ends up
 * split across two directories. An environment variable is inherited by every
 * worker, so all of them agree.
 *
 * Usage:  node scripts/next-production.mjs build|start [...args]
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const [command = "build", ...rest] = process.argv.slice(2);

if (command !== "build" && command !== "start") {
  console.error(`Expected "build" or "start", got "${command}".`);
  process.exit(1);
}

// Next's own entry point, run under this Node. Going through `npx` would mean
// spawning a `.cmd` shim on Windows, which needs a shell and brings its own
// quoting rules for no benefit.
const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");

const child = spawn(process.execPath, [nextBin, command, ...rest], {
  stdio: "inherit",
  env: { ...process.env, NEXT_DIST_DIR: ".next-build" },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
