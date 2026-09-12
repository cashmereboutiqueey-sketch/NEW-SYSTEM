import "server-only";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { db, inTransaction } from "./db";
import type { AuditContext } from "./audit";
import type { Prisma } from "@/generated/prisma/client";

/**
 * One business command: one transaction, and at most one effect per request.
 *
 * Everything a command does — the services it calls, and the services they
 * call — runs in a single serializable transaction (see `inTransaction` in
 * db.ts). A sale either relieves its stock, posts its journals and records its
 * payment together, or does none of it; two cashiers reaching for the last
 * garment cannot both have it, because the loser's transaction is retried
 * against what the winner committed.
 *
 * With a request identity, the command also leaves a receipt in the same
 * transaction. Seeing that identity again returns the recorded result rather
 * than doing the work twice. A command called inside another runs as part of
 * it and leaves no receipt of its own; the outermost one speaks for the whole.
 */
const commandScope = new AsyncLocalStorage<boolean>();

export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandError";
  }
}

const REQUEST_ID = /^[a-zA-Z0-9:_-]{8,160}$/;

/** Key order and Dates made stable, so equal input always hashes equally. */
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

export async function command<T>(
  operation: string,
  input: unknown,
  ctx: AuditContext,
  work: () => Promise<T>,
): Promise<T> {
  // Already inside a command: part of its transaction, covered by its receipt.
  if (commandScope.getStore()) return work();

  const requestId = ctx.requestId;
  if (requestId && !REQUEST_ID.test(requestId)) {
    throw new CommandError("This form's submission identity is not valid. Reload the page and try again.");
  }
  // Per person and per operation, so one identity cannot collide across them.
  const key = requestId ? `${ctx.userId ?? "system"}:${operation}:${requestId}` : null;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(canonical(input)))
    .digest("hex");

  const replay = (prior: { fingerprint: string; result: Prisma.JsonValue }): T => {
    if (prior.fingerprint !== fingerprint) {
      // The same identity with other values is not a retry. Doing either the
      // old or the new thing would be a guess.
      throw new CommandError(
        "This form was already submitted with different values. Reload the page and enter it again.",
      );
    }
    return (prior.result as { value: T }).value;
  };

  try {
    return await inTransaction(async () => {
      if (key) {
        const prior = await db.commandReceipt.findUnique({ where: { key } });
        if (prior) return replay(prior);
      }
      const result = await commandScope.run(true, work);
      if (key) {
        await db.commandReceipt.create({
          data: {
            key,
            operation,
            fingerprint,
            // Stored as JSON, so a replay returns plain values: Decimals come
            // back as strings, Dates as ISO text. Commands return those anyway.
            result: JSON.parse(JSON.stringify({ value: result ?? null })) as Prisma.InputJsonValue,
          },
        });
      }
      return result;
    });
  } catch (error) {
    // Two presses of the same request raced, and the other one committed its
    // receipt first. This attempt rolled back whole, so answer with that one.
    if (key && (error as { code?: string })?.code === "P2002") {
      const prior = await db.commandReceipt.findUnique({ where: { key } });
      if (prior) return replay(prior);
    }
    throw error;
  }
}

/** The submission identity a form carries, from `RequestIdField`. */
export function requestIdOf(formData: FormData): string | undefined {
  const value = formData.get("requestId");
  return typeof value === "string" && value ? value : undefined;
}

/**
 * What a form submitted, as the fingerprint of a replay.
 *
 * The form's own fields rather than the service input built from them: an
 * action stamps things like "now" onto that input, and a retry a second later
 * would then look like a different request and be refused instead of replayed.
 * Next's own bookkeeping fields are left out, and files are described rather
 * than read.
 */
function submitted(formData: FormData): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const [name, value] of formData.entries()) {
    if (name === "requestId" || name.startsWith("$ACTION")) continue;
    const text = typeof value === "string" ? value : `file:${value.name}:${value.size}`;
    (fields[name] ??= []).push(text);
  }
  return fields;
}

/**
 * A form submission as one command, keyed by the identity the form sent.
 *
 * Wrap the whole of an action's work in this, not just the service call: the
 * services inside join its transaction, and the receipt is keyed and
 * fingerprinted on what the person submitted.
 */
export function formCommand<T>(
  operation: string,
  formData: FormData,
  ctx: AuditContext,
  work: () => Promise<T>,
): Promise<T> {
  return command(operation, submitted(formData), { ...ctx, requestId: requestIdOf(formData) }, work);
}
