import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { can } from "@/core/permissions";
import { taxStatus, taxRates, vatPosition } from "@/lib/tax";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatPercent } from "@/lib/money";
import { RateForm, RegistrationForm } from "./tax-forms";

/**
 * الضريبة — VAT, and the reason it is switched off.
 *
 * The rates have been on file since the first migration and nothing read them,
 * which is not the same thing as nobody having thought about it: the setting
 * says the business is not registered, and a system charging VAT it does not
 * owe would be worse than one charging none.
 *
 * What was missing is everything around that decision — no way to see the
 * rates, no way to add one when the law moves, no way to see what would be
 * owed. A dormant feature with no switch and no dial is indistinguishable from
 * a forgotten one.
 */
export default async function TaxPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const session = await requirePermission("journal:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const query = await searchParams;

  const today = new Date();
  const defaultFrom = new Date(today.getFullYear(), today.getMonth() - 2, 1);
  const from = query.from ? new Date(query.from) : defaultFrom;
  const to = query.to ? new Date(query.to) : today;

  const [status, rates, position] = await Promise.all([
    taxStatus(),
    taxRates(),
    vatPosition(from, to),
  ]);

  const mayManage = can(session.role, "settings:manage");
  const codes = [...new Set(rates.map((r) => r.code))];

  const rateLabel = status.rate ? formatPercent(status.rate.rate.toString()) : "—";
  const day = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : "—");

  return (
    <>
      <PageHeader
        title={ar ? "الضريبة" : "VAT"}
        subtitle={
          ar
            ? "النسب مؤرّخة — القيد اللي اتسجل بنسبة قديمة بيفضل بنسبته، والنسبة الجديدة بتبدأ من تاريخها."
            : "Rates are effective-dated: a posting made at the old rate keeps it, and the new one starts from its date."
        }
      />

      {!status.registered && (
        <div className="mb-5 rounded-lg border border-line bg-surface p-3 text-sm">
          <strong>{ar ? "مفيش ضريبة بتتحسب دلوقتي." : "No VAT is being charged."}</strong>{" "}
          {ar
            ? "ده مقصود: النشاط مش مسجّل في ضريبة القيمة المضافة، والنظام مش بيحسب ضريبة مش مستحقة عليك. النسب تحت جاهزة، والحسابين ١٤٥٠ و٢٣٠٠ موجودين ومستنيين — أول ما تتسجل، فعّل السويتش."
            : "That is deliberate: the business is not VAT-registered, and the system does not charge tax it does not owe. The rates below are ready and accounts 1450 and 2300 are waiting — turn the switch on once you register."}
        </div>
      )}

      {status.misconfigured && (
        <div className="mb-5 rounded-lg border border-bad/30 bg-bad/5 p-3 text-sm">
          <strong className="text-bad">{ar ? "إعداد ناقص." : "Misconfigured."}</strong>{" "}
          {ar
            ? `الكود الافتراضي «${status.defaultCode}» مالوش نسبة سارية النهاردة. صحّحه قبل ما تفعّل التسجيل.`
            : `The default code "${status.defaultCode}" has no rate in force today. Fix that before switching registration on.`}
        </div>
      )}

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <StatTile
          label={ar ? "الحالة" : "Status"}
          value={status.registered ? (ar ? "مسجّل" : "Registered") : ar ? "مش مسجّل" : "Not registered"}
          hint={status.registered ? `${ar ? "بنسبة" : "at"} ${rateLabel}` : undefined}
          tone={status.registered ? "good" : "neutral"}
        />
        <StatTile
          label={ar ? "ضريبة على المبيعات" : "Output VAT"}
          value={formatMoney(position.outputVat.toString())}
          hint={ar ? "محصّلة من العملاء" : "charged to customers"}
        />
        <StatTile
          label={ar ? "ضريبة على المشتريات" : "Input VAT"}
          value={formatMoney(position.inputVat.toString())}
          hint={ar ? "مدفوعة للموردين وقابلة للخصم" : "paid to suppliers, reclaimable"}
        />
        <StatTile
          label={
            position.net.greaterThanOrEqualTo(0)
              ? ar ? "المستحق للمصلحة" : "Owed to the authority"
              : ar ? "المستردّ" : "Refund due"
          }
          value={formatMoney(position.net.abs().toString())}
          hint={`${day(from)} → ${day(to)}`}
          tone={position.net.greaterThan(0) ? "warn" : "neutral"}
        />
      </div>

      {mayManage && (
        <div className="mb-5">
          <Card
            title={ar ? "التسجيل الضريبي" : "VAT registration"}
            description={
              ar
                ? "اليوم اللي بيتغيّر فيه ده هو اليوم اللي التزاماتك بتتغيّر فيه، فبيتسجل في سجل التدقيق."
                : "The day this changes is the day the obligations change, so it goes into the audit trail."
            }
          >
            <RegistrationForm ar={ar} registered={status.registered} rateLabel={rateLabel} />
          </Card>
        </div>
      )}

      <div className="mb-5">
        <Card
          title={ar ? "النسب المسجّلة" : "Rates on file"}
          description={
            ar
              ? "النسبة ما بتتعدلش أبدًا — بتتقفل وتبدأ واحدة جديدة، عشان القيود القديمة تفضل صح."
              : "A rate is never edited: it is closed and a new one starts, so past postings stay true."
          }
          actions={mayManage ? <RateForm ar={ar} codes={codes} /> : undefined}
        >
          <DataTable
            headers={[
              ar ? "الكود" : "Code",
              ar ? "الاسم" : "Name",
              ar ? "النسبة" : "Rate",
              ar ? "من" : "From",
              ar ? "إلى" : "To",
              "",
            ]}
            empty={ar ? "مفيش نسب مسجّلة" : "No rates on file"}
            rows={rates.map((r) => [
              <span key="c" className="num text-xs" dir="ltr">{r.code}</span>,
              ar ? r.nameAr : r.nameEn,
              <span key="r" className="num font-medium">{formatPercent(r.rate.toString())}</span>,
              <span key="f" className="num text-xs" dir="ltr">{day(r.effectiveFrom)}</span>,
              <span key="t" className="num text-xs" dir="ltr">
                {r.effectiveTo ? day(r.effectiveTo) : ar ? "مفتوحة" : "open"}
              </span>,
              r.current ? (
                <Badge key="s" tone="good">{ar ? "سارية" : "in force"}</Badge>
              ) : (
                <span key="s" className="text-xs text-ink-400">
                  {ar ? "تاريخية" : "historical"}
                </span>
              ),
            ])}
          />
        </Card>
      </div>

      <Card
        title={ar ? "الإقرار عن الفترة" : "The period's position"}
        description={`${day(from)} → ${day(to)}`}
      >
        <form method="get" action="/tax" className="mb-4 flex flex-wrap items-end gap-2">
          <div>
            <label className="mb-1 block text-xs text-ink-500" htmlFor="from">
              {ar ? "من" : "From"}
            </label>
            <input
              id="from" name="from" type="date" dir="ltr" defaultValue={day(from)}
              className="rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-sm num"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-500" htmlFor="to">
              {ar ? "إلى" : "To"}
            </label>
            <input
              id="to" name="to" type="date" dir="ltr" defaultValue={day(to)}
              className="rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-sm num"
            />
          </div>
          <button type="submit" className="rounded-lg bg-ink-900 px-4 py-2 text-sm text-white">
            {ar ? "اعرض" : "Show"}
          </button>
        </form>

        <dl className="space-y-2 text-sm">
          {[
            [
              ar ? "ضريبة محصّلة على المبيعات (٢٣٠٠)" : "Output VAT charged (2300)",
              formatMoney(position.outputVat.toString()),
            ],
            [
              ar ? "ناقص ضريبة مدفوعة على المشتريات (١٤٥٠)" : "Less input VAT paid (1450)",
              formatMoney(position.inputVat.toString()),
            ],
            [
              position.net.greaterThanOrEqualTo(0)
                ? ar ? "المستحق للمصلحة" : "Owed to the authority"
                : ar ? "المستردّ منها" : "Refund due from them",
              formatMoney(position.net.abs().toString()),
            ],
          ].map(([k, v], i, all) => (
            <div
              key={k}
              className={
                "flex items-baseline justify-between gap-4 pb-1.5 " +
                (i === all.length - 1
                  ? "border-t border-ink-300 pt-2 font-semibold"
                  : "border-b border-ink-100")
              }
            >
              <dt className="text-ink-600">{k}</dt>
              <dd className="num text-ink-900">{v}</dd>
            </div>
          ))}
        </dl>

        {!status.registered && (
          <p className="mt-3 text-xs text-ink-400">
            {ar
              ? "الأرقام دي أصفار لأن مفيش ضريبة اتحسبت أصلًا — مش لأن الفترة فاضية."
              : "These are zero because no VAT has been charged at all, not because the period is empty."}
          </p>
        )}
      </Card>
    </>
  );
}
