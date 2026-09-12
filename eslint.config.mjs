import { FlatCompat } from "@eslint/eslintrc";

/**
 * The static checks, said out loud.
 *
 * `tsc` proves the types line up and the build proves it compiles; neither
 * notices an unused import, a React hook with the wrong dependencies, or an
 * `<img>` where the framework wanted its own. This is that gate, and it runs
 * as `npm run lint`.
 *
 * eslint-config-next is still written for the old config format, so it comes
 * through the compatibility layer rather than being rewritten here — a fork of
 * somebody else's rule list is a fork that drifts.
 */
const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const config = [
  {
    ignores: [
      "next-env.d.ts",
      ".next/**",
      ".next-build/**",
      "node_modules/**",
      "src/generated/**",
      "coverage/**",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // Underscore says "deliberately unused"; anything else is a leftover.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
];

export default config;
