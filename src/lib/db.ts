// The database client must never be reachable from a client component:
// importing it there would pull the connection string into the browser
// bundle. This import makes that a build failure rather than a leak.
import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import type { Prisma } from "@/generated/prisma/client";
import { AsyncLocalStorage } from "node:async_hooks";

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

const client = globalForPrisma.prisma ?? createClient();
const transactionScope = new AsyncLocalStorage<Prisma.TransactionClient>();

/**
 * Domain commands own the transaction. Services called by a command inherit
 * its client, including existing service-local $transaction callbacks. They
 * must not perform network or filesystem side effects in this scope: a
 * serialization failure retries the whole command.
 */
export const db = new Proxy(client, {
  get(target, property) {
    const active = transactionScope.getStore();
    if (active && property === "$transaction") {
      return (work: ((tx: Prisma.TransactionClient) => unknown) | Promise<unknown>[]) =>
        typeof work === "function" ? work(active) : Promise.all(work);
    }
    const receiver = active ?? target;
    const value = Reflect.get(receiver, property);
    return typeof value === "function" ? value.bind(receiver) : value;
  },
});

function isConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: string; cause?: unknown; meta?: unknown; originalCode?: string };
  if (["P2034", "40001", "40P01"].includes(e.code ?? e.originalCode ?? "")) return true;
  return isConflict(e.cause) || (e.meta != null && Object.values(e.meta).some(isConflict));
}

export async function inTransaction<T>(work: () => Promise<T>): Promise<T> {
  if (transactionScope.getStore()) return work();
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.$transaction(
        (tx) => transactionScope.run(tx, work),
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 60_000 },
      );
    } catch (error) {
      if (attempt >= 4 || !isConflict(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)));
    }
  }
}

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
  globalForPrisma.prisma = client;
}
