import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { can } from "@/core/permissions";
import { cashForecast } from "@/lib/cash-flow";
import { ScheduledItemForm, StopItemForm } from "./scheduled-form";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney } from "@/lib/money";

/**
 * توقعات التدفق النقدي — thirteen weeks of obligations already on the books.
 *
 * Deliberately not a sales forecast. Every line is either money owed on a date
 * or money already earned and waiting to arrive. A forecast that includes
 * orders nobody has placed makes next month look survivable, which is the one
 * thing this screen must never do.
 */
export default async function CashFlowPage({
  searchParams,
}: {
  searchParams: Promise<{ entity?: string }>;
}) {
  const session = await requirePermission("journal:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const query = await searchParams;

  const mayManage = can(session.role, "expense:create");

  const entity =
    query.entity === "FACTORY" || query.entity === "BRAND"
      ? await db.entity.findFirst({ where: { kind: query.entity } })
      : null;

  const [forecast, entities, scheduled] = await Promise.all([
    cashForecast(entity?.id ?? null),
    db.entity.findMany({ where: { kind: { in: ["FACTORY", "BRAND"] } }, orderBy: { nameEn: "asc" } }),
    db.scheduledCashItem.findMany({
      where: { isActive: true, ...(entity ? { entityId: entity.id } : {}) },
      include: { entity: true },
      orderBy: [{ direction: "asc" }, { dayOfMonth: "asc" }],
    }),
  ]);

  const kindLabel: Record<string, string> = ar
    ? {
        EXPENSE: "مصروف مستحق",
        PURCHASE_COMMITMENT: "أمر شراء",
        RECEIVABLE: "تحصيل متوقع",
        SCHEDULED: "بند دوري",
      }
    : {
        EXPENSE: "Bill due",
        PURCHASE_COMMITMENT: "Purchase order",
        RECEIVABLE: "Collection due",
        SCHEDULED: "Scheduled",
      };

  const shortfall = forecast.firstShortfall;

  return (
    <>
      <PageHeader
        title={ar ? "توقعات التدفق النقدي" : "Cash flow forecast"}
        subtitle={
          ar
            ? "١٣ أسبوع من الالتزامات المسجّلة فعلًا — مفيش توقّع مبيعات هنا"
            : "Thirteen weeks of obligations already on the books — no sales projection here"
        }
        actions={
          <Badge tone="neutral">
            {entity ? (ar ? entity.nameAr : entity.nameEn) : ar ? "المجموعة" : "Group"}
          </Badge>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <StatTile
          label={ar ? "النقدية دلوقتي" : "Cash today"}
          value={formatMoney(forecast.opening, locale)}
          tone={forecast.opening.lessThan(0) ? "bad" : "neutral"}
        />
        <StatTile
          label={ar ? "داخل" : "Coming in"}
          value={formatMoney(forecast.totalIn, locale)}
          tone="good"
        />
        <StatTile
          label={ar ? "خارج" : "Going out"}
          value={formatMoney(forecast.totalOut, locale)}
          tone="warn"
        />
        <StatTile
          label={ar ? "أقل رصيد متوقع" : "Lowest point"}
          value={forecast.lowest ? formatMoney(forecast.lowest.closingBalance, locale) : "—"}
          tone={
            forecast.lowest && forecast.lowest.closingBalance.lessThan(0) ? "bad" : "good"
          }
          hint={
            forecast.lowest
              ? forecast.lowest.weekStart.toISOString().slice(0, 10)
              : undefined
          }
        />
      </div>

      {shortfall && (
        <Card
          className="mb-4"
          title={ar ? "فيه أسبوع الرصيد بيقع فيه تحت الصفر" : "The balance goes under"}
        >
          <p className="text-sm text-bad">
            {ar ? (
              <>
                أسبوع{" "}
                <span className="num" dir="ltr">
                  {shortfall.weekStart.toISOString().slice(0, 10)}
                </span>{" "}
                الرصيد المتوقع{" "}
                <span className="num">{formatMoney(shortfall.closingBalance, locale)}</span>.
                ده مش توقّع مبيعات — دي التزامات موجودة فعلًا، فالفرق لازم يتغطى بتأجيل دفعة
                أو تحصيل أسرع أو تمويل.
              </>
            ) : (
              <>
                In the week of{" "}
                <span className="num" dir="ltr">
                  {shortfall.weekStart.toISOString().slice(0, 10)}
                </span>{" "}
                the balance is{" "}
                <span className="num">{formatMoney(shortfall.closingBalance, locale)}</span>.
                These are obligations that already exist, not projected sales, so
                the gap has to be covered by deferring a payment, collecting
                sooner, or funding.
              </>
            )}
          </p>
        </Card>
      )}

      {mayManage && (
        <Card
          className="mb-4"
          title={ar ? "بنود دورية" : "Scheduled payments"}
          description={
            ar
              ? "الإيجار والرواتب والأقساط — مالهاش فاتورة لسه، بس أكيد هتتدفع"
              : "Rent, payroll, instalments — no invoice yet, but they will certainly need paying"
          }
        >
          <ScheduledItemForm
            locale={locale}
            today={new Date().toISOString().slice(0, 10)}
            entities={entities.map((e) => ({ id: e.id, label: ar ? e.nameAr : e.nameEn }))}
          />

          {scheduled.length > 0 && (
            <ul className="mt-4 divide-y divide-ink-100 text-sm">
              {scheduled.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center gap-3 py-2">
                  <Badge tone={item.direction === "INFLOW" ? "good" : "neutral"}>
                    {item.direction === "INFLOW" ? (ar ? "داخل" : "In") : ar ? "خارج" : "Out"}
                  </Badge>
                  <span className="flex-1">
                    {ar ? item.nameAr : item.nameEn}
                    <span className="ms-2 text-xs text-ink-400">
                      {ar ? item.entity.nameAr : item.entity.nameEn}
                    </span>
                  </span>
                  <span className="num">{formatMoney(item.amount, locale)}</span>
                  <span className="text-xs text-ink-500">
                    {item.frequency === "MONTHLY"
                      ? ar ? `كل شهر يوم ${item.dayOfMonth}` : `monthly on the ${item.dayOfMonth}`
                      : item.frequency === "QUARTERLY"
                        ? ar ? "ربع سنوي" : "quarterly"
                        : item.frequency === "ANNUAL"
                          ? ar ? "سنوي" : "annual"
                          : ar ? "مرة واحدة" : "one-off"}
                  </span>
                  <StopItemForm locale={locale} itemId={item.id} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card className="mb-4" title={ar ? "أسبوع بأسبوع" : "Week by week"}>
        <DataTable
          headers={[
            ar ? "الأسبوع" : "Week",
            ar ? "داخل" : "In",
            ar ? "خارج" : "Out",
            ar ? "الصافي" : "Net",
            ar ? "الرصيد" : "Balance",
          ]}
          rows={forecast.weeks.map((w, i) => [
            <span key={`${i}-w`} className="num" dir="ltr">
              {w.weekStart.toISOString().slice(0, 10)}
            </span>,
            <span key={`${i}-i`} className="num text-good">
              {w.inflow.isZero() ? "—" : formatMoney(w.inflow, locale)}
            </span>,
            <span key={`${i}-o`} className="num text-warn">
              {w.outflow.isZero() ? "—" : formatMoney(w.outflow, locale)}
            </span>,
            <span
              key={`${i}-n`}
              className={w.net.lessThan(0) ? "num text-bad" : "num text-good"}
            >
              {formatMoney(w.net, locale)}
            </span>,
            <span
              key={`${i}-b`}
              className={
                w.closingBalance.lessThan(0) ? "num font-semibold text-bad" : "num font-medium"
              }
            >
              {formatMoney(w.closingBalance, locale)}
            </span>,
          ])}
        />
      </Card>

      <Card
        title={ar ? "البنود" : "The lines behind it"}
        description={
          ar
            ? "كل بند إما فاتورة عليها تاريخ أو فلوس اتكسبت ولسه ماوصلتش"
            : "Each line is either a bill with a date or money earned and not yet arrived"
        }
      >
        {forecast.weeks.every((w) => w.lines.length === 0) ? (
          <p className="py-8 text-center text-sm text-ink-400">
            {ar ? "مفيش التزامات في الأفق." : "Nothing on the horizon."}
          </p>
        ) : (
          <DataTable
            headers={[
              ar ? "التاريخ" : "Date",
              ar ? "النوع" : "Kind",
              ar ? "البند" : "Item",
              ar ? "المبلغ" : "Amount",
            ]}
            rows={forecast.weeks
              .flatMap((w) => w.lines)
              .slice(0, 120)
              .map((l, i) => [
                <span key={`${i}-d`} className="num" dir="ltr">
                  {l.date.toISOString().slice(0, 10)}
                </span>,
                <Badge key={`${i}-k`} tone={l.direction === "IN" ? "good" : "neutral"}>
                  {kindLabel[l.kind] ?? l.kind}
                </Badge>,
                <span key={`${i}-l`}>{ar ? l.labelAr : l.labelEn}</span>,
                <span
                  key={`${i}-a`}
                  className={l.direction === "IN" ? "num text-good" : "num"}
                >
                  {l.direction === "IN" ? "+" : "−"}
                  {formatMoney(l.amount, locale)}
                </span>,
              ])}
          />
        )}
      </Card>
    </>
  );
}
