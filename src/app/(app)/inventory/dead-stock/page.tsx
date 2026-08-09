import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { deadStock } from "@/lib/analytics";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber, formatPercent } from "@/lib/money";

/**
 * المخزون الراكد — stock by how long it has been standing still.
 *
 * Reported at what it cost, because that is the cash actually tied up in it,
 * whatever anyone hopes it might still sell for. A pile of fabric valued at
 * its optimistic resale price is a way of not noticing the problem.
 */
export default async function DeadStockPage({
  searchParams,
}: {
  searchParams: Promise<{ entity?: string }>;
}) {
  await requirePermission("inventory:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const query = await searchParams;

  const kind = query.entity === "FACTORY" ? "FACTORY" : "BRAND";
  const entity = await db.entity.findFirstOrThrow({ where: { kind } });
  const report = await deadStock(entity.id);

  const stateLabel: Record<string, string> = ar
    ? { RAW_MATERIAL: "خامات", WIP: "تحت التشغيل", FINISHED_GOODS: "تام" }
    : { RAW_MATERIAL: "Raw", WIP: "WIP", FINISHED_GOODS: "Finished" };

  const bucketLabel = (bucket: string) =>
    ar
      ? { "0-30": "أقل من شهر", "31-60": "شهر لشهرين", "61-90": "شهرين لتلاتة", "90+": "أكتر من ٣ شهور" }[bucket]
      : { "0-30": "Under 30 days", "31-60": "31–60 days", "61-90": "61–90 days", "90+": "Over 90 days" }[bucket];

  return (
    <>
      <PageHeader
        title={ar ? "المخزون الراكد" : "Dead stock"}
        subtitle={
          ar
            ? `${ar ? entity.nameAr : entity.nameEn} — البضاعة بالتكلفة اللي دُفعت فيها فعلًا، مش باللي ممكن تتباع بيه`
            : `${entity.nameEn} — stock at what it actually cost, not at what it might fetch`
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatTile
          label={ar ? "إجمالي المخزون" : "Total stock"}
          value={formatMoney(report.total, locale)}
          hint={`${report.rows.length} ${ar ? "دفعة" : "lots"}`}
        />
        <StatTile
          label={ar ? "واقف أكتر من ٣ شهور" : "Standing over 90 days"}
          value={formatMoney(report.stale, locale)}
          tone={report.stale.greaterThan(0) ? "bad" : "good"}
        />
        <StatTile
          label={ar ? "نسبته من المخزون" : "Share of stock"}
          value={report.staleShare ? formatPercent(report.staleShare, locale) : "—"}
          tone={
            report.staleShare && report.staleShare.greaterThan(0.2) ? "bad" : "neutral"
          }
          hint={ar ? "كاش نايم" : "Cash standing still"}
        />
      </div>

      <Card className="mb-4" title={ar ? "بالعمر" : "By age"}>
        <DataTable
          headers={[
            ar ? "العمر" : "Age",
            ar ? "الكمية" : "Quantity",
            ar ? "القيمة بالتكلفة" : "Value at cost",
          ]}
          rows={report.buckets.map((b) => [
            <span key={`${b.bucket}-l`}>{bucketLabel(b.bucket)}</span>,
            <span key={`${b.bucket}-q`} className="num">
              {formatNumber(b.quantity, locale)}
            </span>,
            <span
              key={`${b.bucket}-v`}
              className={b.bucket === "90+" && b.value.greaterThan(0) ? "num text-bad" : "num"}
            >
              {formatMoney(b.value, locale)}
            </span>,
          ])}
        />
      </Card>

      <Card
        title={ar ? "الدفعات، الأقدم الأول" : "Lots, oldest first"}
        description={
          ar
            ? "اللي فوق هو اللي محتاج قرار — تخفيض، تحويل لفرع تاني، أو إعادة استخدام"
            : "The top of this list is what needs a decision — mark down, move branch, or repurpose"
        }
      >
        {report.rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-400">
            {ar ? "مفيش مخزون." : "No stock on hand."}
          </p>
        ) : (
          <DataTable
            headers={[
              ar ? "الدفعة" : "Lot",
              ar ? "الصنف" : "Item",
              ar ? "الحالة" : "State",
              ar ? "المكان" : "Where",
              ar ? "الكمية" : "Qty",
              ar ? "القيمة" : "Value",
              ar ? "واقف من" : "Standing",
            ]}
            rows={report.rows.slice(0, 100).map((r) => [
              <code key={`${r.id}-l`} dir="ltr" className="text-xs text-ink-500">
                {r.lotNumber}
              </code>,
              <span key={`${r.id}-n`}>
                <code dir="ltr" className="text-xs text-ink-400">{r.code}</code>
                <span className="ms-2">{ar ? r.nameAr : r.nameEn}</span>
              </span>,
              <Badge key={`${r.id}-s`} tone="neutral">{stateLabel[r.state] ?? r.state}</Badge>,
              <span key={`${r.id}-w`} className="text-ink-500">
                {ar ? r.locationAr : r.locationEn}
              </span>,
              <span key={`${r.id}-q`} className="num">{formatNumber(r.quantity, locale)}</span>,
              <span key={`${r.id}-v`} className="num">{formatMoney(r.value, locale)}</span>,
              <span
                key={`${r.id}-d`}
                className={r.days > 90 ? "num text-bad" : r.days > 60 ? "num text-warn" : "num"}
              >
                {r.days} {ar ? "يوم" : "d"}
              </span>,
            ])}
          />
        )}
      </Card>
    </>
  );
}
