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
 *
 * One case is not a failure at all and is treated separately. A tab left open
 * across a deployment holds the previous build's JavaScript, which asks for
 * server actions by an id the new build does not have. Nothing is broken and
 * nothing was lost — the page is simply out of date. Saying "something went
 * wrong" there frightens somebody whose only problem is that they were logged
 * in while we shipped.
 *
 * It also cannot be fixed by the button that fixes everything else: reset()
 * re-renders using the same stale bundle and fails again the same way. Only
 * fetching the page afresh helps, so that is what this does.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // A stale bundle asking for an action this build no longer has.
  const outOfDate = /Failed to find Server Action|older or newer deployment/i.test(
    error.message ?? "",
  );

  useEffect(() => {
    // The server logs the detail; this records that somebody actually met it.
    console.error("Page error:", error.digest ?? error.message);

    if (!outOfDate) return;
    // Reload once and once only. A reload that fails the same way would
    // otherwise loop, and a loop is worse than the message it replaced.
    try {
      if (sessionStorage.getItem("reloaded-for-deploy") === "1") return;
      sessionStorage.setItem("reloaded-for-deploy", "1");
    } catch {
      // Private windows and blocked storage throw. Without somewhere to record
      // that we already tried, reloading could loop, so leave it to the button.
      return;
    }
    window.location.reload();
  }, [error, outOfDate]);

  if (outOfDate) {
    return (
      <div className="mx-auto max-w-lg py-16 text-center" dir="rtl">
        <h1 className="mb-3 text-lg font-semibold text-ink-900">النسخة اتحدّثت</h1>
        <p className="mb-2 text-sm text-ink-600">
          الصفحة كانت مفتوحة وقت ما النظام اتحدّث. مفيش أي حاجة ضاعت ولا
          اتسجّلت غلط — الصفحة بس قديمة. بنحمّلها من الأول دلوقتي.
        </p>
        <p className="mb-6 text-sm text-ink-500" dir="ltr">
          This tab was open while the system was updated. Nothing was lost and
          nothing was saved wrongly — the page is simply out of date. Reloading
          it now.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white"
        >
          حمّل الصفحة من الأول
        </button>
      </div>
    );
  }

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
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-lg border border-ink-300 px-4 py-2 text-sm text-ink-700"
        >
          حمّل من الأول
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
