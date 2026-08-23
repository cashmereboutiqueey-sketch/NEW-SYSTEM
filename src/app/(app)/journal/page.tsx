import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { can } from "@/core/permissions";
import { journalEntries, journalFilterOptions } from "@/lib/journal";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber, dec } from "@/lib/money";
import { ReverseForm } from "./reverse-form";

/**
 * دفتر اليومية — every posting, and the only honest way to correct one.
 *
 * The ledger has been immutable from the first migration: the database refuses
 * to edit a posted line from application code and from raw SQL alike. That is
 * the right rule and it left a hole — nothing could put a mistake right, and
 * `reverseEntry` sat in the library with no screen and no caller.
 *
 * A reversal is not a deletion. The original stays exactly as posted, the
 * mirror is posted beside it, and the two are linked. The books then show both
 * the mistake and the correction, which is what anybody auditing them is
 * entitled to see. Quietly amending the original would leave a trial balance
 * that is right today and a history that has been rewritten.
 */
export default async function JournalPage({
  searchParams,
}: {
  searchParams: Promise<{
    entity?: string;
    account?: string;
    source?: string;
    q?: string;
    status?: string;
  }>;
}) {
  const session = await requirePermission("journal:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const query = await searchParams;

  const [entries, options] = await Promise.all([
    journalEntries({
      entityId: query.entity || null,
      accountCode: query.account || null,
      sourceType: query.source || null,
      search: query.q || null,
      status: (query.status as "DRAFT" | "POSTED" | "REVERSED" | undefined) || null,
      limit: 150,
    }),
    journalFilterOptions(),
  ]);

  const mayReverse = can(session.role, "journal:reverse");

  const posted = entries.filter((e) => e.status === "POSTED");
  const reversed = entries.filter((e) => e.reversedByNumber);
  const corrections = entries.filter((e) => e.reversesNumber);
  const total = posted.reduce((t, e) => t.plus(e.debit), dec(0));

  const day = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : "—");

  const field =
    "rounded-lg border border-ink-200 bg-panel px-2.5 py-1.5 text-sm outline-none focus:border-rose-deep";

  return (
    <>
      <PageHeader
        title={ar ? "دفتر اليومية" : "Journal"}
        subtitle={
          ar
            ? "كل قيد اتسجل. القيد المرحّل ما بيتعدلش ولا بيتمسح — بيتصحح بقيد عكسي جنبه."
            : "Every posting. A posted entry is never edited or deleted — it is corrected by a mirror entry beside it."
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <StatTile
          label={ar ? "قيود معروضة" : "Entries shown"}
          value={formatNumber(entries.length)}
          hint={`${formatNumber(posted.length)} ${ar ? "مرحّل" : "posted"}`}
        />
        <StatTile
          label={ar ? "إجمالي المدين" : "Total debits"}
          value={formatMoney(total.toString())}
          hint={ar ? "يساوي الدائن دائمًا" : "always equals the credits"}
        />
        <StatTile
          label={ar ? "قيود اتعكست" : "Reversed"}
          value={formatNumber(reversed.length)}
          hint={ar ? "الأصلي لسه في الدفاتر" : "the original is still in the books"}
          tone={reversed.length > 0 ? "warn" : "neutral"}
        />
        <StatTile
          label={ar ? "قيود تصحيح" : "Corrections"}
          value={formatNumber(corrections.length)}
          hint={ar ? "اتعملت لتصحيح غيرها" : "posted to put something right"}
        />
      </div>

      <div className="mb-5">
        <Card title={ar ? "تصفية" : "Filter"}>
          <form method="get" action="/journal" className="flex flex-wrap items-end gap-2">
            <div>
              <label className="mb-1 block text-xs text-ink-500" htmlFor="q">
                {ar ? "رقم القيد أو البيان" : "Entry number or memo"}
              </label>
              <input id="q" name="q" className={field} defaultValue={query.q ?? ""} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-500" htmlFor="entity">
                {ar ? "الكيان" : "Entity"}
              </label>
              <select id="entity" name="entity" className={field} defaultValue={query.entity ?? ""}>
                <option value="">{ar ? "الكل" : "All"}</option>
                {options.entities.map((e) => (
                  <option key={e.id} value={e.id}>
                    {ar ? e.nameAr : e.nameEn}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-500" htmlFor="account">
                {ar ? "الحساب" : "Account"}
              </label>
              <select id="account" name="account" className={field} defaultValue={query.account ?? ""}>
                <option value="">{ar ? "الكل" : "All"}</option>
                {options.accounts.map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.code} — {ar ? a.nameAr : a.nameEn}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-500" htmlFor="source">
                {ar ? "المصدر" : "Source"}
              </label>
              <select id="source" name="source" className={field} defaultValue={query.source ?? ""}>
                <option value="">{ar ? "الكل" : "All"}</option>
                {options.sourceTypes.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              className="rounded-lg bg-ink-900 px-4 py-2 text-sm text-white"
            >
              {ar ? "اعرض" : "Show"}
            </button>
            <a href="/journal" className="rounded-lg border border-ink-200 px-4 py-2 text-sm text-ink-600">
              {ar ? "امسح" : "Clear"}
            </a>
          </form>
        </Card>
      </div>

      {entries.length === 0 ? (
        <Card>
          <p className="py-8 text-center text-sm text-ink-400">
            {ar ? "مفيش قيود بالمواصفات دي." : "No entries match that."}
          </p>
        </Card>
      ) : (
        entries.map((e) => (
          <div key={e.id} className="mb-4">
            <Card
              title={
                <span className="flex flex-wrap items-center gap-2">
                  <span className="num" dir="ltr">{e.entryNumber}</span>
                  <Badge tone={e.status === "POSTED" ? "good" : "neutral"}>{e.status}</Badge>
                  {e.reversedByNumber && (
                    <Badge tone="bad">
                      {ar ? "اتعكس بـ" : "reversed by"}{" "}
                      <span className="num" dir="ltr">{e.reversedByNumber}</span>
                    </Badge>
                  )}
                  {e.reversesNumber && (
                    <Badge tone="warn">
                      {ar ? "بيصحح" : "corrects"}{" "}
                      <span className="num" dir="ltr">{e.reversesNumber}</span>
                    </Badge>
                  )}
                </span>
              }
              description={
                <span>
                  {day(e.postingDate)} · {ar ? e.entityAr : e.entityEn} · {e.sourceType} ·{" "}
                  {ar ? "فترة" : "period"} {e.period}
                  {e.postedBy && ` · ${ar ? "رحّله" : "posted by"} ${e.postedBy}`}
                  {e.memo && <span className="block text-ink-500">{e.memo}</span>}
                  {e.reversalReason && (
                    <span className="mt-1 block text-ink-700">
                      {ar ? "سبب العكس: " : "Reason: "}
                      {e.reversalReason}
                    </span>
                  )}
                </span>
              }
              actions={
                mayReverse && e.reversible ? (
                  <ReverseForm
                    ar={ar}
                    entryId={e.id}
                    entryNumber={e.entryNumber}
                    amount={formatMoney(e.debit.toString())}
                  />
                ) : undefined
              }
            >
              <DataTable
                headers={[
                  "#",
                  ar ? "الحساب" : "Account",
                  ar ? "البيان" : "Description",
                  ar ? "مدين" : "Debit",
                  ar ? "دائن" : "Credit",
                ]}
                rows={[
                  ...e.lines.map((l) => [
                    <span key="n" className="num text-xs text-ink-400">{l.lineNumber}</span>,
                    <span key="a">
                      <span className="num text-xs text-ink-500" dir="ltr">{l.accountCode}</span>
                      <span className="ms-2">{ar ? l.accountAr : l.accountEn}</span>
                    </span>,
                    <span key="d" className="text-xs text-ink-500">{l.description ?? "—"}</span>,
                    <span key="dr" className="num">
                      {Number(l.debit) > 0 ? formatMoney(l.debit) : ""}
                    </span>,
                    <span key="cr" className="num">
                      {Number(l.credit) > 0 ? formatMoney(l.credit) : ""}
                    </span>,
                  ]),
                  [
                    "",
                    <span key="t" className="text-xs font-medium">{ar ? "الإجمالي" : "Total"}</span>,
                    "",
                    <span key="dt" className="num font-semibold">{formatMoney(e.debit.toString())}</span>,
                    <span key="ct" className="num font-semibold">{formatMoney(e.credit.toString())}</span>,
                  ],
                ]}
              />
            </Card>
          </div>
        ))
      )}
    </>
  );
}
