import pg from "pg";

/**
 * Which database the integration tests are allowed to touch.
 *
 * The `*.db.test.ts` suites switch the accounting triggers off and delete
 * sales, stock, journals and the audit trail between tests. That is right for
 * a database that exists to be thrown away, and a catastrophe for any other.
 * They used to read DATABASE_URL, the same variable the application uses, so
 * the only thing between `npm run test:db` and the business's books was
 * whoever typed it remembering what .env pointed at that day.
 *
 * Now they run only against TEST_DATABASE_URL, and only when:
 *
 *   - it is set at all. There is no fallback to DATABASE_URL.
 *   - the database it names ends in `_test`.
 *   - it is not the database DATABASE_URL names.
 *   - the server, asked what database the connection actually landed in,
 *     answers with a `_test` name too. A URL can be routed by a proxy or
 *     pooler to somewhere other than what it says, and the server's answer is
 *     the only one that cannot be mistaken.
 *
 * The first three are checked before any connection is opened; the last one
 * before any test file runs.
 */

export class TestDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestDatabaseError";
  }
}

const SUFFIX = "_test";

const HOW_TO =
  "\n\nCreate a database that exists only to be wiped, for example:\n" +
  "  docker compose exec db createdb -U cashmere_os cashmere_os_test\n" +
  "then set in .env:\n" +
  '  TEST_DATABASE_URL="postgresql://cashmere_os:<password>@127.0.0.1:5435/cashmere_os_test?schema=public"\n' +
  "and load it once with:  npm run test:db:prepare";

function parse(url: string, label: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new TestDatabaseError(`${label} is not a valid connection URL.`);
  }
}

function databaseName(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\//, ""));
}

/** Host, port and database: what makes two URLs the same database. */
function identity(url: URL): string {
  return `${url.hostname.toLowerCase()}:${url.port || "5432"}/${databaseName(url)}`;
}

/**
 * The connection string the tests may use, or an error saying why not.
 * Opens no connection.
 */
export function testDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env.TEST_DATABASE_URL?.trim();
  if (!raw) {
    throw new TestDatabaseError(
      "TEST_DATABASE_URL is not set. The database tests delete data, so they never " +
        "fall back to DATABASE_URL." +
        HOW_TO,
    );
  }

  const test = parse(raw, "TEST_DATABASE_URL");
  const name = databaseName(test);
  if (!name.endsWith(SUFFIX)) {
    throw new TestDatabaseError(
      `TEST_DATABASE_URL names the database "${name}". The database tests only run ` +
        `against one whose name ends in "${SUFFIX}", so a real one cannot be pointed ` +
        `at by accident.` +
        HOW_TO,
    );
  }

  const appRaw = env.DATABASE_URL?.trim();
  if (appRaw) {
    const app = parse(appRaw, "DATABASE_URL");
    if (identity(app) === identity(test)) {
      throw new TestDatabaseError(
        "TEST_DATABASE_URL and DATABASE_URL name the same database. The tests would " +
          "wipe whatever the application is using." +
          HOW_TO,
      );
    }
  }

  return raw;
}

/**
 * Asks the server which database the connection really reached, and refuses
 * unless it is a `_test` one.
 */
export async function confirmTestDatabase(url: string): Promise<string> {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
  } catch (error) {
    throw new TestDatabaseError(
      `Could not connect to the test database: ${(error as Error).message}` + HOW_TO,
    );
  }
  try {
    const { rows } = await client.query<{ name: string }>("SELECT current_database() AS name");
    const name = rows[0]?.name ?? "";
    if (!name.endsWith(SUFFIX)) {
      throw new TestDatabaseError(
        `TEST_DATABASE_URL connected to "${name}", not a "${SUFFIX}" database. ` +
          `Refusing to run anything that deletes data there.`,
      );
    }
    return name;
  } finally {
    await client.end();
  }
}
