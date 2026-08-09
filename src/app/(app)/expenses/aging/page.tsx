import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { apAging } from "@/lib/reports";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, dec } from "@/lib/money";

/**
 * أعمار الذمم الدائنة — what is owed, and how late it is.
 *
 * The whole reason this system records costs when they are incurred rather
 * than when they are paid is so this screen can exist. Cash-based books show
 * an unpaid bill as nothing at all, which makes every reported figure better
 * than reality until the supplier rings.
 */
export default async function ApAgingPage() {
  await requirePermission("expense:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const aging = await apAging();

  const bucketLabels: Record<string, string> = ar
    ? {
        current: "لسه ماستحقتش",
        d1_30: "متأخر ١–٣٠ يوم",
        d31_60: "متأخر ٣١–٦٠ يوم",
        d61_90: "متأخر ٦١–٩٠ يوم",
        d90plus: "متأخر أكتر من ٩٠ يوم",
      }
    : {
        current: "Not yet due",
        d1_30: "1–30 days late",
        d31_60: "31–60 days late",
        d61_90: "61–90 days late",
        d90plus: "Over 90 days late",
      };

  const overdue = dec(aging.buckets.d1_30)
    .plus(dec(aging.buckets.d31_60))
    .plus(dec(aging.buckets.d61_90))
    .plus(dec(aging.buckets.d90plus));

  const worst = dec(aging.buckets.d61_90).plus(dec(aging.buckets.d90plus));

  return (
    <>
      <PageHeader
        title={ar ? "أعمار الذمم الدائنة" : "Accounts payable aging"}
        subtitle={
          ar
            ? "المستحق للموردين مرتّب بتاريخ السداد — المصروف بيتسجّل وقت ما يستحق مش وقت ما يتدفع"
            : "What is owed, ordered by when it fell due — costs are recorded when incurred, not when paid"
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatTile
          label={ar ? "إجمالي المستحق" : "Total owed"}
          value={formatMoney(aging.total, locale)}
          hint={`${aging.rows.length} ${ar ? "بند" : "items"}`}
        />
        <StatTile
          label={ar ? "متأخر عن السداد" : "Past due"}
          value={formatMoney(overdue, locale)}
          tone={overdue.greaterThan(0) ? "warn" : "good"}
        />
        <StatTile
          label={ar ? "متأخر أكتر من ٦٠ يوم" : "Over 60 days late"}
          value={formatMoney(worst, locale)}
          tone={worst.greaterThan(0) ? "bad" : "good"}
          hint={ar ? "دي اللي بتخسّرك المورد" : "This is what costs you a supplier"}
        />
      </div>

      <Card className="mb-4" title={ar ? "التوزيع" : "The spread"}>
        <DataTable
          headers={[ar ? "الفترة" : "Bucket", ar ? "المبلغ" : "Amount"]}
          rows={Object.entries(aging.buckets).map(([key, value]) => [
            <span key={`${key}-l`}>{bucketLabels[key]}</span>,
            <span
              key={`${key}-v`}
              className={
                key === "current"
                  ? "num"
                  : key === "d90plus" || key === "d61_90"
                    ? "num text-bad"
                    : "num text-warn"
              }
            >
              {formatMoney(value, locale)}
            </span>,
          ])}
        />
      </Card>

      <Card title={ar ? "البنود" : "Open items"}>
        {aging.rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-400">
            {ar ? "مفيش مستحقات مفتوحة." : "Nothing is outstanding."}
          </p>
        ) : (
          <DataTable
            headers={[
              ar ? "البند" : "Item",
              ar ? "المورد" : "Supplier",
              ar ? "الكيان" : "Entity",
              ar ? "تاريخ السداد" : "Due",
              ar ? "التأخير" : "Late by",
              ar ? "المتبقي" : "Outstanding",
            ]}
            rows={aging.rows.map((r) => [
              <span key={`${r.id}-d`}>{r.description}</span>,
              <span key={`${r.id}-s`}>
                {(ar ? r.supplierAr : r.supplierEn) ?? "—"}
              </span>,
              <span key={`${r.id}-e`} className="text-ink-500">
                {ar ? r.entityAr : r.entityEn}
              </span>,
              <span key={`${r.id}-dd`} className="num" dir="ltr">
                {r.dueDate.toISOString().slice(0, 10)}
              </span>,
              r.daysOverdue <= 0 ? (
                <Badge key={`${r.id}-b`} tone="good">
                  {ar ? `باقي ${-r.daysOverdue} يوم` : `${-r.daysOverdue}d to go`}
                </Badge>
              ) : (
                <Badge key={`${r.id}-b`} tone={r.daysOverdue > 60 ? "bad" : "warn"}>
                  {ar ? `${r.daysOverdue} يوم` : `${r.daysOverdue} days`}
                </Badge>
              ),
              <span key={`${r.id}-o`} className="num font-medium">
                {formatMoney(r.outstanding, locale)}
              </span>,
            ])}
          />
        )}
      </Card>
    </>
  );
}
