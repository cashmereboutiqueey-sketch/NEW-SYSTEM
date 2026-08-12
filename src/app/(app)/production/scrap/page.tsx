import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { can } from "@/core/permissions";
import { scrapReport } from "@/lib/factory-floor";
import { scrappableMaterials, openRuns } from "@/lib/scrap";
import { ScrapForm } from "./scrap-form";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber, formatPercent } from "@/lib/money";

/**
 * القصاصات — offcuts, and what became of them.
 *
 * Recovery rate is the figure to watch. Fabric sold on is a cost partly
 * recouped; fabric in the skip is the whole thing lost. Both are recorded at
 * FIFO book value, so the loss is what the cloth actually cost rather than
 * what it might have been worth.
 */
export default async function ScrapPage() {
  const session = await requirePermission("production:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });
  const [report, sources, runs] = await Promise.all([
    scrapReport(),
    scrappableMaterials(factory.id),
    openRuns(),
  ]);
  const mayRecord = can(session.role, "production:create");

  const dispositionLabel: Record<string, string> = ar
    ? {
        SOLD: "اتباعت",
        RETURNED_TO_STOCK: "رجعت للمخزن",
        USED_FOR_SAMPLING: "اتستخدمت في عينات",
        DISCARDED: "اترمت",
      }
    : {
        SOLD: "Sold on",
        RETURNED_TO_STOCK: "Back to stock",
        USED_FOR_SAMPLING: "Used for samples",
        DISCARDED: "Discarded",
      };

  // Sold, returned and sampled all recoup something; only the skip is a total
  // loss.
  const recovered = (disposition: string) => disposition !== "DISCARDED";

  return (
    <>
      <PageHeader
        title={ar ? "القصاصات" : "Scrap"}
        subtitle={
          ar
            ? "الفاقد بقيمته الدفترية، وإيه اللي رجع منه — آخر ٦ شهور"
            : "Offcuts at book value and what came back from them — the last six months"
        }
      />

      {mayRecord && (
        <div className="mb-5">
          <Card
            title={ar ? "سجّل قصاصات" : "Record scrap"}
            description={
              ar
                ? "القيمة مش بتتكتب — بتتحسب من تكلفة القماش الفعلية بالـ FIFO، عشان المخزون في الدفاتر يفضل مطابق للمخزون على الأرض."
                : "The value is never typed: it is the cloth's actual FIFO cost, so the inventory account keeps agreeing with the inventory."
            }
          >
            <ScrapForm
              ar={ar}
              entityId={factory.id}
              sources={sources.map((s) => ({
                materialId: s.materialId,
                locationId: s.locationId,
                code: s.code,
                nameAr: s.nameAr,
                nameEn: s.nameEn,
                uom: s.uom,
                onHand: s.onHand.toString(),
                locationAr: s.locationAr,
                locationEn: s.locationEn,
              }))}
              runs={runs}
            />
          </Card>
        </div>
      )}

      {report.rows.length === 0 ? (
        <Card>
          <p className="py-8 text-center text-sm text-ink-400">
            {ar
              ? "لسه مفيش قصاصات مسجّلة."
              : "No scrap has been recorded yet."}
          </p>
        </Card>
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-4">
            <StatTile
              label={ar ? "القيمة الدفترية" : "Book value"}
              value={formatMoney(report.bookValue, locale)}
              hint={ar ? "تكلفة القماش الفعلية" : "What the cloth actually cost"}
            />
            <StatTile
              label={ar ? "اللي اترجع" : "Recovered"}
              value={formatMoney(report.salvage, locale)}
              tone={report.salvage.greaterThan(0) ? "good" : "neutral"}
            />
            <StatTile
              label={ar ? "نسبة الاسترداد" : "Recovery rate"}
              value={report.recoveryRate ? formatPercent(report.recoveryRate, locale) : "—"}
              tone={
                report.recoveryRate && report.recoveryRate.greaterThan(0.3) ? "good" : "warn"
              }
            />
            <StatTile
              label={ar ? "صافي الخسارة" : "Net loss"}
              value={formatMoney(report.netLoss, locale)}
              tone={report.netLoss.greaterThan(0) ? "bad" : "good"}
            />
          </div>

          <Card className="mb-4" title={ar ? "حسب المصير" : "By disposition"}>
            <DataTable
              headers={[
                ar ? "المصير" : "Disposition",
                ar ? "الكمية" : "Quantity",
                ar ? "القيمة الدفترية" : "Book value",
                ar ? "اللي اترجع" : "Recovered",
                ar ? "صافي الخسارة" : "Net loss",
              ]}
              rows={report.byDisposition.map((d) => [
                <Badge
                  key={`${d.disposition}-b`}
                  tone={recovered(d.disposition) ? "good" : "warn"}
                >
                  {dispositionLabel[d.disposition] ?? d.disposition}
                </Badge>,
                <span key={`${d.disposition}-q`} className="num">
                  {formatNumber(d.quantity, locale)}
                </span>,
                <span key={`${d.disposition}-v`} className="num">
                  {formatMoney(d.bookValue, locale)}
                </span>,
                <span key={`${d.disposition}-s`} className="num text-good">
                  {d.salvage.isZero() ? "—" : formatMoney(d.salvage, locale)}
                </span>,
                <span key={`${d.disposition}-l`} className="num text-bad">
                  {formatMoney(d.netLoss, locale)}
                </span>,
              ])}
            />
          </Card>

          <Card title={ar ? "التسجيلات" : "Records"}>
            <DataTable
              headers={[
                ar ? "التاريخ" : "Date",
                ar ? "الخامة" : "Material",
                ar ? "الأمر" : "Order",
                ar ? "الكمية" : "Quantity",
                ar ? "المصير" : "Disposition",
                ar ? "دفتري" : "Book",
                ar ? "اترجع" : "Recovered",
                ar ? "خسارة" : "Loss",
              ]}
              rows={report.rows.map((r) => [
                <span key={`${r.id}-d`} className="num" dir="ltr">
                  {r.date.toISOString().slice(0, 10)}
                </span>,
                <span key={`${r.id}-m`}>
                  <code dir="ltr" className="text-xs text-ink-500">{r.materialCode}</code>
                  <span className="ms-2">{ar ? r.materialAr : r.materialEn}</span>
                </span>,
                <span key={`${r.id}-o`} className="text-ink-500">
                  {r.orderNumber ? (
                    <>
                      <code dir="ltr" className="text-xs">{r.orderNumber}</code>
                      <span className="ms-2">{ar ? r.styleAr : r.styleEn}</span>
                    </>
                  ) : (
                    "—"
                  )}
                </span>,
                <span key={`${r.id}-q`} className="num">
                  {formatNumber(r.quantity, locale)} {r.uom}
                </span>,
                <Badge
                  key={`${r.id}-t`}
                  tone={recovered(r.disposition) ? "good" : "warn"}
                >
                  {dispositionLabel[r.disposition] ?? r.disposition}
                </Badge>,
                <span key={`${r.id}-b`} className="num">{formatMoney(r.bookValue, locale)}</span>,
                <span key={`${r.id}-s`} className="num text-good">
                  {r.salvageValue.isZero() ? "—" : formatMoney(r.salvageValue, locale)}
                </span>,
                <span key={`${r.id}-l`} className="num text-bad">
                  {formatMoney(r.netLoss, locale)}
                </span>,
              ])}
            />
          </Card>
        </>
      )}
    </>
  );
}
