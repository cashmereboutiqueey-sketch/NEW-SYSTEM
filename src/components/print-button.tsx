"use client";

/**
 * Opens the browser's print dialogue.
 *
 * A plain button rather than anything cleverer: the browser's own dialogue is
 * what lets someone pick the right printer and paper, which matters when a
 * till roll and an A4 laser are both attached to the same machine.
 */
export function PrintButton({ label }: { label: string }) {
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
