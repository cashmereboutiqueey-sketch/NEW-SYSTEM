"use client";

import { useEffect } from "react";

/**
 * Opens the browser's print dialogue.
 *
 * A plain button rather than anything cleverer: the browser's own dialogue is
 * what lets someone pick the right printer and paper, which matters when a
 * till roll and an A4 laser are both attached to the same machine.
 */
export function PrintButton({ label, auto }: { label: string; auto?: boolean }) {
  /*
   * `auto` opens the dialogue as soon as the page is ready.
   *
   * For the till, where the cashier clicked "print the receipt" on the sale
   * and this tab exists for no other reason: making them press print again on
   * a page they asked to print is a second click with a customer waiting. The
   * button stays for a second copy, and for every page reached another way.
   */
  useEffect(() => {
    if (!auto) return;
    // After paint, so the receipt is laid out before the dialogue measures it.
    const id = window.setTimeout(() => window.print(), 300);
    return () => window.clearTimeout(id);
  }, [auto]);

  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="no-print rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white"
    >
      {label}
    </button>
  );
}
