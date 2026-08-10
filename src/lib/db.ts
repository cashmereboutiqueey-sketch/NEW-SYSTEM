// The database client must never be reachable from a client component:
// importing it there would pull the connection string into the browser
// bundle. This import makes that a build failure rather than a leak.
import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and configure it.",
    );
  }
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

export const db = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  // Held on the global so hot reload reuses one client instead of opening a
  // new pool on every edit, which exhausts the connections within a minute.
  //
  // The cost of that, and it has already caught us once: this instance
  // outlives every recompile. After `prisma generate` — which is to say after
  // any schema change — the running dev server keeps the client it built at
  // startup and rejects the new columns with "Unknown argument", even though
  // the schema, the migration, the generated client on disk and the
  // typechecker all agree. Restart the dev server. Nothing short of that
  // replaces it.
  globalForPrisma.prisma = db;
}
