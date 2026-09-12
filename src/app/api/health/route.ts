import { db } from "@/lib/db";

/**
 * Whether the application can actually serve anybody.
 *
 * The container's health check used to fetch the login page, which renders
 * without touching the database — so a server whose every other screen was
 * failing reported itself healthy. This asks the database the smallest
 * question there is and says so if it cannot answer.
 *
 * Deliberately public and deliberately uninformative: it says up or down,
 * never why, and never anything about the data.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Health check: database unreachable:", error);
    return Response.json({ ok: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
