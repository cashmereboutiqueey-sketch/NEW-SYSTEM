/**
 * No-op stand-in for the `server-only` package under the test runner.
 *
 * The real package throws on import to keep server code out of the client
 * bundle. Vitest runs in Node, where that boundary does not exist, so importing
 * the real thing would fail every test of a server module.
 */
export {};
