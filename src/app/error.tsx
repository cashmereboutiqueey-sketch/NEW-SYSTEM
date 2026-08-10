"use client";

import { useEffect } from "react";

/**
 * What a person sees when something breaks.
 *
 * Deliberately says nothing about what went wrong internally: a stack trace on
 * screen tells an attacker about the shape of the system and tells everyone
 * else nothing they can act on. The digest is shown because it is the one
 * thing that connects what they saw to what the server logged.
 *
 * The reassurance about unsaved work is not decoration. In an accounting
 * system the first question after an error is always whether it went through,
 * and the answer here is genuinely no: every operation is a single
 * transaction, so a failure leaves nothing behind.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The server logs the detail; this records that somebody actually met it.
    console.error("Page error:", error.digest ?? error.message);
  }, [error]);

  return (
    <div className="mx-auto max-w-lg py-16 text-center" dir="rtl">
      <h1 className="mb-3 text-lg font-semibold text-ink-900">حصل خطأ</h1>

      <p className="mb-2 text-sm text-ink-600">
        الصفحة دي وقفت. مفيش حاجة اتسجّلت ناقصة — أي عملية بتتم كاملة أو
        مابتتمش خالص.
      </p>
      <p className="mb-6 text-sm text-ink-500" dir="ltr">
        Something went wrong on this page. Nothing was half-saved: every
        operation either completes or leaves no trace.
      </p>

      {error.digest && (
        <p className="mb-6 text-xs text-ink-400">
          رقم الخطأ للدعم الفني: <code dir="ltr">{error.digest}</code>
        </p>
      )}

      <div className="flex justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white"
        >
          جرّب تاني
        </button>
        <a
          href="/"
          className="rounded-lg border border-ink-300 px-4 py-2 text-sm text-ink-700"
        >
          الرئيسية
        </a>
      </div>
    </div>
  );
}
