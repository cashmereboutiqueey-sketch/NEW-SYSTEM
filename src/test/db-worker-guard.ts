/**
 * Runs inside every test worker, before each database test file.
 *
 * The config hands workers the test database as DATABASE_URL, and the files
 * themselves call `dotenv/config`, which does not overwrite a variable that is
 * already set. This checks that arrangement actually held in the process that
 * is about to delete things, rather than trusting that it did.
 */
const test = process.env.TEST_DATABASE_URL?.trim();
if (!test || process.env.DATABASE_URL !== test) {
  throw new Error(
    "Refusing to run: this database test worker is not pointed at TEST_DATABASE_URL.",
  );
}
