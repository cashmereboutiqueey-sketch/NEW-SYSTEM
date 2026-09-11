import { describe, it, expect } from "vitest";
import { testDatabaseUrl, TestDatabaseError } from "./test-database";

/**
 * The guard in front of the database tests, which delete data.
 *
 * No database here: every refusal below happens before a connection opens.
 * The last check, asking the server which database it really reached, needs a
 * server and runs as the database suite's global setup.
 */

const APP = "postgresql://cashmere_os:pw@127.0.0.1:5435/cashmere_os?schema=public";
const TEST = "postgresql://cashmere_os:pw@127.0.0.1:5435/cashmere_os_test?schema=public";

describe("which database the tests may touch", () => {
  it("allows a separate _test database", () => {
    expect(testDatabaseUrl({ DATABASE_URL: APP, TEST_DATABASE_URL: TEST })).toBe(TEST);
  });

  it("never falls back to the application's database", () => {
    // The old behaviour, and the whole reason for the guard.
    expect(() => testDatabaseUrl({ DATABASE_URL: APP })).toThrow(TestDatabaseError);
    expect(() => testDatabaseUrl({ DATABASE_URL: APP, TEST_DATABASE_URL: "  " })).toThrow(
      /not set/,
    );
  });

  it("refuses a database whose name does not say it is disposable", () => {
    expect(() =>
      testDatabaseUrl({ TEST_DATABASE_URL: APP.replace("5435", "5436") }),
    ).toThrow(/_test/);
    expect(() =>
      testDatabaseUrl({ TEST_DATABASE_URL: TEST.replace("cashmere_os_test", "cashmere_test_os") }),
    ).toThrow(/_test/);
  });

  it("refuses the application's own database, even when it is called _test", () => {
    expect(() => testDatabaseUrl({ DATABASE_URL: TEST, TEST_DATABASE_URL: TEST })).toThrow(
      /same database/,
    );
    // Different credentials and parameters, same place.
    expect(() =>
      testDatabaseUrl({
        DATABASE_URL: "postgresql://other:x@LOCALHOST:5435/cashmere_os_test",
        TEST_DATABASE_URL: "postgresql://cashmere_os:pw@localhost:5435/cashmere_os_test?schema=public",
      }),
    ).toThrow(/same database/);
  });

  it("treats a missing port as the default one", () => {
    expect(() =>
      testDatabaseUrl({
        DATABASE_URL: "postgresql://u:p@db/cashmere_os_test",
        TEST_DATABASE_URL: "postgresql://u:p@db:5432/cashmere_os_test",
      }),
    ).toThrow(/same database/);
  });

  it("refuses something that is not a URL at all", () => {
    expect(() => testDatabaseUrl({ TEST_DATABASE_URL: "cashmere_os_test" })).toThrow(
      /not a valid/,
    );
  });
});
