/**
 * What the server does on its own, once it is up.
 *
 * Next calls this once per server process. Only the Node runtime gets here —
 * the edge runtime has no database — and a build does not, because building is
 * not running.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  // Shopify deliveries that failed are retried here rather than waiting for
  // somebody to open the integrations screen. Set to 0 to switch it off.
  const minutes = Number(process.env.WEBHOOK_RETRY_MINUTES ?? 10);
  if (!Number.isFinite(minutes) || minutes <= 0) return;

  const { retryFailedWebhooks } = await import("@/lib/shopify");
  const timer = setInterval(
    async () => {
      try {
        const { tried, recovered } = await retryFailedWebhooks();
        if (tried > 0) {
          console.log(`Shopify inbox: retried ${tried}, ${recovered} went through`);
        }
      } catch (error) {
        console.error("Shopify inbox: the retry pass itself failed:", error);
      }
    },
    minutes * 60_000,
  );
  // Never a reason to hold the process open.
  timer.unref();
}
