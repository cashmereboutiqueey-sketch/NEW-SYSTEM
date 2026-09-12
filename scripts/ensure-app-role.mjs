/**
 * The database login the running application uses, and what it may do.
 *
 * The application used to connect as the database's owner — in the official
 * Postgres image a superuser. Anything that ever tricked it into running a
 * statement could drop tables, create logins, or switch off the triggers that
 * keep posted journals immutable and the books balanced.
 *
 * It now connects as `cashmere_app`: it can read and write rows and use
 * sequences, and nothing else. It does not own the tables, so it cannot alter
 * them or disable their triggers; it is not a superuser, so it cannot create
 * roles or bypass anything. Migrations and backups keep using the owner.
 *
 * Run by the migrate service after every migration, so tables a migration
 * adds are granted too. Idempotent: it creates the role once, then keeps its
 * password and grants in step with the environment.
 *
 *   DATABASE_URL=<owner connection> APP_DB_PASSWORD=<secret> node scripts/ensure-app-role.mjs
 */
import pg from "pg";

const ROLE = "cashmere_app";
const password = process.env.APP_DB_PASSWORD;
if (!password || password.length < 16) {
  console.error("APP_DB_PASSWORD must be set, and at least 16 characters.");
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  const quoted = client.escapeLiteral(password);
  const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [ROLE]);
  if (exists.rowCount === 0) {
    await client.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD ${quoted}`);
    console.log(`created ${ROLE}`);
  } else {
    await client.query(`ALTER ROLE ${ROLE} WITH LOGIN PASSWORD ${quoted}`);
  }
  // Whatever it may have been granted by hand, it is none of these.
  await client.query(
    `ALTER ROLE ${ROLE} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
  );

  const database = (await client.query("SELECT current_database() AS name")).rows[0].name;
  await client.query(`GRANT CONNECT ON DATABASE "${database}" TO ${ROLE}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
  // Rows, not structure: no TRUNCATE, no REFERENCES, no TRIGGER.
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`,
  );
  await client.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`);
  // The migration history is the owner's business alone.
  await client.query(`REVOKE ALL ON TABLE "_prisma_migrations" FROM ${ROLE}`).catch(() => {});

  console.log(`${ROLE}: rows and sequences in ${database}, nothing more`);
} finally {
  await client.end();
}
