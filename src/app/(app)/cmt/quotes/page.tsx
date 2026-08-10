import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { can } from "@/core/permissions";
import { quotingBasis, recentQuotes } from "@/lib/cmt";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber, formatPercent, dec } from "@/lib/money";
import { QuoteForm, QuoteStatusForm } from "../cmt-forms";

/**
 * عروض أسعار التصنيع — pricing somebody else's garments.
 *
 * Two rates matter and they are not the same. The full-capacity rate is the
 * floor: below it the Brand is subsidising a stranger. The actual rate is what
 * the Brand pays, and asking an outside client to cover the factory's idleness
 * is how you lose the work. Anywhere between the two is a real decision, and
 * both figures are frozen onto the quote so it can be defended later.
 */
export default async function CmtQuotesPage() {
  const session = await requirePermission("cmt_quote:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const mayQuote = can(session.role, "cmt_quote:create");

  const [basis, quotes, clients] = await Promise.all([
    quotingBasis(),
    recentQuotes(),
    db.cMTClient.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }),
  ]);

  const accepted = quotes.filter((q) => q.status === "ACCEPTED");
  const wonValue = accepted.reduce((s, q) => s.plus(q.quotedTotal), dec(0));
  const wonMinutes = accepted.reduce((s, q) => s.plus(q.totalMinutes), dec(0));

  const statusTone: Record<string, "neutral" | "info" | "good" | "bad" | "warn"> = {
    DRAFT: "neutral", SENT: "info", ACCEPTED: "good", REJECTED: "bad", EXPIRED: "warn",
  };
  const statusLabel: Record<string, string> = ar
    ? { DRAFT: "مسودة", SENT: "اتبعت", ACCEPTED: "اتقبل", REJECTED: "اترفض", EXPIRED: "انتهى" }
    : { DRAFT: "Draft", SENT: "Sent", ACCEPTED: "Accepted", REJECTED: "Rejected", EXPIRED: "Expired" };

  return (
    <>
      <PageHeader
        title={ar ? "عروض أسعار التصنيع" : "CMT quotes"}
        subtitle={
          ar
            ? "الحد الأدنى هو سعر كامل الطاقة — تحته البراند بيدعم عميل غريب"
            : "The floor is the full-capacity rate — below it the Brand subsidises a stranger"
        }
      />

      {!basis ? (
        <Card>
          <p className="py-8 text-center text-sm text-ink-400">
            {ar
              ? "محتاج تكلفة دقيقة محسوبة الأول عشان يبقى فيه حد أدنى تسعّر فوقه."
              : "A minute rate has to be calculated first, so there is a floor to price above."}
          </p>
        </Card>
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label={ar ? "الحد الأدنى للدقيقة" : "Floor rate"}
              value={formatNumber(basis.floorMinuteRate.toDecimalPlaces(4), locale)}
              tone="good"
              hint={ar ? "عند كامل الطاقة" : "At full capacity"}
            />
            <StatTile
              label={ar ? "اللي البراند بيدفعه" : "What the Brand pays"}
              value={formatNumber(basis.actualMinuteRate.toDecimalPlaces(4), locale)}
              hint={ar ? "تكلفة الدقيقة الفعلية" : "The actual minute rate"}
            />
            <StatTile
              label={ar ? "دقائق فاضية" : "Free minutes"}
              value={formatNumber(basis.freeMinutes, locale)}
              tone={basis.freeMinutes.greaterThan(0) ? "warn" : "good"}
              hint={basis.label}
            />
            <StatTile
              label={ar ? "عروض مقبولة" : "Won"}
              value={formatMoney(wonValue, locale)}
              tone={accepted.length > 0 ? "good" : "neutral"}
              hint={`${formatNumber(wonMinutes, locale)} ${ar ? "دقيقة" : "minutes"}`}
            />
          </div>

          {mayQuote && (
            <Card className="mb-4" title={ar ? "عرض سعر جديد" : "New quote"}>
              {clients.length === 0 ? (
                <p className="py-4 text-sm text-ink-500">
                  {ar
                    ? "ضيف عميل تصنيع الأول من صفحة العملاء."
                    : "Add a CMT client first, from the clients screen."}
                </p>
              ) : (
                <QuoteForm
                  locale={locale}
                  today={new Date().toISOString().slice(0, 10)}
                  clients={clients.map((c) => ({ id: c.id, label: `${c.code} — ${c.name}` }))}
                  basis={{
                    floorMinuteRate: basis.floorMinuteRate.toString(),
                    actualMinuteRate: basis.actualMinuteRate.toString(),
                    freeMinutes: basis.freeMinutes.toString(),
                    label: basis.label,
                  }}
                />
              )}
            </Card>
          )}
        </>
      )}

      <Card title={ar ? "العروض" : "Quotes"}>
        {quotes.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-400">
            {ar ? "لسه مفيش عروض." : "No quotes yet."}
          </p>
        ) : (
          <DataTable
            headers={[
              ar ? "العرض" : "Quote",
              ar ? "العميل" : "Client",
              ar ? "الموديل" : "What",
              ar ? "الكمية" : "Qty",
              ar ? "دقائق" : "Minutes",
              ar ? "الحد الأدنى" : "Floor",
              ar ? "المعروض" : "Quoted",
              ar ? "فوق الحد" : "Over floor",
              ar ? "الإجمالي" : "Total",
              ar ? "الحالة" : "Status",
            ]}
            rows={quotes.map((q) => [
              <code key={`${q.id}-n`} dir="ltr" className="text-xs text-ink-500">
                {q.quoteNumber}
              </code>,
              <span key={`${q.id}-c`}>{q.clientName}</span>,
              <span key={`${q.id}-d`} className="text-ink-600">{q.styleDescription}</span>,
              <span key={`${q.id}-q`} className="num">{formatNumber(q.quantity, locale)}</span>,
              <span key={`${q.id}-m`} className="num text-ink-500">
                {formatNumber(q.totalMinutes, locale)}
              </span>,
              <span key={`${q.id}-f`} className="num text-ink-500">
                {formatNumber(q.floorMinuteRate.toDecimalPlaces(4), locale)}
              </span>,
              <span key={`${q.id}-r`} className="num font-medium">
                {formatNumber(q.quotedMinuteRate.toDecimalPlaces(4), locale)}
              </span>,
              <span
                key={`${q.id}-o`}
                className={
                  q.marginOverFloorPct.greaterThan(0.15) ? "num text-good" : "num text-warn"
                }
              >
                {formatPercent(q.marginOverFloorPct, locale)}
              </span>,
              <span key={`${q.id}-t`} className="num">{formatMoney(q.quotedTotal, locale)}</span>,
              mayQuote && q.status !== "ACCEPTED" ? (
                <QuoteStatusForm key={`${q.id}-s`} locale={locale} quoteId={q.id} status={q.status} />
              ) : (
                <Badge key={`${q.id}-s`} tone={statusTone[q.status]}>
                  {statusLabel[q.status]}
                </Badge>
              ),
            ])}
          />
        )}
      </Card>
    </>
  );
}
