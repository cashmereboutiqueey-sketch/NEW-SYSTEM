/**
 * A page that is not there.
 *
 * Also what a request for a record that does not exist lands on, which is why
 * it says "or is not yours to see" — telling somebody a record exists but is
 * forbidden is itself a small leak, so the two cases look the same.
 */
export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg py-16 text-center" dir="rtl">
      <h1 className="mb-3 text-lg font-semibold text-ink-900">الصفحة مش موجودة</h1>

      <p className="mb-2 text-sm text-ink-600">
        اللي بتدوّر عليه إما اتشال، أو مش من صلاحياتك تشوفه.
      </p>
      <p className="mb-6 text-sm text-ink-500" dir="ltr">
        What you are looking for has either gone, or is not yours to see.
      </p>

      <a
        href="/"
        className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white"
      >
        الرئيسية
      </a>
    </div>
  );
}
