import type { NextConfig } from "next";


const nextConfig: NextConfig = {
  /**
   * Production builds get their own directory.
   *
   * `next build` and `next dev` both write to `.next` by default, so building
   * while a dev server is running replaces the chunks that server has already
   * handed to the browser. The page then dies with a bare
   * `__webpack_modules__[moduleId] is not a function`, which names neither the
   * build nor the dev server. Keeping them apart means the two can run at
   * once, which they will: checking a production build compiles is a normal
   * thing to do without closing the window you are looking at.
   *
   * `scripts/next-production.mjs` sets the variable for `build` and `start`;
   * `next dev` leaves it unset and keeps `.next`.
   */
  distDir: process.env.NEXT_DIST_DIR ?? ".next",

  /**
   * Standalone output, for the container image only.
   *
   * Next traces which files the server actually needs and copies them into
   * `standalone`, so the runtime image carries those rather than node_modules
   * whole — a few hundred megabytes against a couple of gigabytes.
   *
   * Behind a variable rather than always on: it is pure cost on a laptop,
   * where the build runs many times a day and nothing ever reads the output.
   * The Dockerfile sets it.
   */
  output: process.env.NEXT_STANDALONE === "1" ? "standalone" : undefined,

  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
};

export default nextConfig;
