import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { can } from "@/core/permissions";
import { cuttingReport } from "@/lib/cutting";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatNumber, formatPercent, formatQty, dec } from "@/lib/money";
import { TicketForm } from "./ticket-form";

/**
 * تذاكر القص — what was laid on the table and what came off it.
 *
 * The cutting table is the only place fabric utilisation can actually be
 * measured. A bill of materials says a garment should take 2.3 metres; a lay
 * of fifty plies at 9.4 metres says what it really took. The gap between the
 * two is the marker, and it is usually the largest single saving available in
 * a garment factory — but it is invisible unless somebody writes the lay down
 * beside the pieces.
 */
export default async function CuttingPage() {
  const session = await requirePermission("production:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const report = await cuttingReport();
  const mayRecord = can(session.role, "production:create");

  const runs = await db.productionOrder.findMany({
    where: { status: { in: ["CONFIRMED", "IN_PRODUCTION"] } },
    include: {
      style: {
        select: {
          nameAr: true, nameEn: true, plannedWasteRate: true,
          bomLines: {
            where: { material: { type: "FABRIC" } },
            select: { standardConsumption: true },
          },
        },
      },
    },
    orderBy: { orderDate: "desc" },
    take: 50,
  });

  const cuttable = runs.map((r) => {
    const standard = r.style.bomLines
      .reduce((s, b) => s.plus(dec(b.standardConsumption)), dec(0))
      .times(dec(r.style.plannedWasteRate).plus(1));
    return {
      id: r.id,
      orderNumber: r.orderNumber,
      styleAr: r.style.nameAr,
      styleEn: r.style.nameEn,
      plannedQty: r.plannedQty,
      standardPerPiece: standard.greaterThan(0) ? standard.toString() : null,
    };
  });

  const tone = (u: { toString(): string } | null) => {
    if (!u) return "neutral" as const;
    const v = Number(u);
    return v <= 1 ? ("good" as const) : v <= 1.05 ? ("warn" as const) : ("bad" as const);
  };

  const day = (d: Date) => new Date(d).toISOString().slice(0, 10);

  return (
    <>
      <PageHeader
        title={ar ? "تذاكر القص" : "Cutting tickets"}
        subtitle={
          ar
            ? "اللي اتحط على الترابيزة واللي طلع منه — واستغلال القماش الحقيقي"
            : "What went on the table, what came off it, and what the cloth really yielded"
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <StatTile
          label={ar ? "تذاكر" : "Tickets"}
          value={formatNumber(report.totals.tickets)}
          hint={`${formatNumber(report.totals.piecesCut)} ${ar ? "قطعة" : "pieces"}`}
        />
        <StatTile
          label={ar ? "متوسط الاستغلال" : "Average utilisation"}
          value={
            report.totals.averageUtilisation
              ? formatPercent(report.totals.averageUtilisation.toString())
              : "—"
          }
          hint={ar ? "١٠٠٪ = مطابق للتكلفة" : "100% is exactly the costing"}
          tone={tone(report.totals.averageUtilisation)}
        />
        <StatTile
          label={ar ? "فوق المعياري" : "Over standard"}
          value={formatNumber(report.totals.overStandard)}
          hint={ar ? "قماش زيادة عن التسعير" : "cloth beyond what was priced in"}
          tone={report.totals.overStandard > 0 ? "bad" : "good"}
        />
        <StatTile
          label={ar ? "اتقاس فعلًا" : "Actually measured"}
          value={`${formatNumber(report.totals.measured)} / ${formatNumber(report.totals.tickets)}`}
          hint={ar ? "اللي اتسجل لها فرش كامل" : "tickets with a full lay recorded"}
        />
      </div>

      {mayRecord && (
        <div className="mb-5">
          <Card
            title={ar ? "سجّل فرشة" : "Record a lay"}
            description={
              ar
                ? "الماركر والطبقات مع بعض: المتر المفروش = الطول × عدد الطبقات، وواحد لوحده مش بيقيس حاجة."
                : "The marker and the plies together: metres laid is one times the other, and either alone measures nothing."
            }
          >
            <TicketForm ar={ar} runs={cuttable} />
          </Card>
        </div>
      )}

      {report.rows.length === 0 ? (
        <Card>
          <p className="py-8 text-center text-sm text-ink-400">
            {ar ? "لسه مفيش تذاكر قص." : "No cutting tickets yet."}
          </p>
        </Card>
      ) : (
        <Card
          title={ar ? "التذاكر" : "Tickets"}
          description={
            ar
              ? "«المتر الفعلي» بيتاخد من اللي خرج من المخزن فعلًا لو موجود، وإلا من الفرشة."
              : "\"Actual\" comes from what really left the store where that is known, and from the lay otherwise."
          }
        >
          <DataTable
            headers={[
              ar ? "التذكرة" : "Ticket",
              ar ? "التاريخ" : "Date",
              ar ? "الأمر" : "Run",
              ar ? "الموديل" : "Style",
              ar ? "ماركر × طبقات" : "Marker × plies",
              ar ? "مفروش" : "Laid",
              ar ? "صرف فعلي" : "Issued",
              ar ? "قطع" : "Pieces",
              ar ? "متر/قطعة" : "m a piece",
              ar ? "المعياري" : "Standard",
              ar ? "الاستغلال" : "Utilisation",
            ]}
            rows={report.rows.map((r) => [
              <span key="t" className="num text-xs" dir="ltr">{r.ticketNumber}</span>,
              <span key="d" className="num text-xs" dir="ltr">{day(r.cutDate)}</span>,
              <span key="o" className="num text-xs" dir="ltr">{r.orderNumber}</span>,
              <span key="s" className="font-medium text-ink-900">
                {ar ? r.styleAr : r.styleEn}
                <span className="ms-2 num text-xs text-ink-400" dir="ltr">{r.styleCode}</span>
              </span>,
              <span key="m" className="num text-xs">
                {r.markerLengthM ? `${formatQty(r.markerLengthM)} × ${r.plies ?? "—"}` : "—"}
              </span>,
              <span key="l" className="num">{r.fabricLaid ? formatQty(r.fabricLaid) : "—"}</span>,
              <span key="i" className="num text-ink-500">
                {r.fabricIssued ? formatQty(r.fabricIssued) : "—"}
              </span>,
              <span key="p" className="num">{formatNumber(r.piecesCut)}</span>,
              <span key="pp" className="num font-medium">
                {r.actualPerPiece ? formatQty(r.actualPerPiece) : "—"}
              </span>,
              <span key="st" className="num text-xs text-ink-500">
                {r.standardPerPiece ? formatQty(r.standardPerPiece) : "—"}
              </span>,
              r.utilisation ? (
                <Badge key="u" tone={tone(r.utilisation)}>
                  {formatPercent(r.utilisation.toString())}
                </Badge>
              ) : (
                <span key="u" className="text-ink-300">—</span>
              ),
            ])}
          />

          <p className="mt-3 text-xs text-ink-400">
            {ar
              ? "فوق ١٠٠٪ معناه القص استهلك قماش أكتر من اللي التسعير حسبه — ده ربح بيخرج من الباب متر ورا متر."
              : "Above 100% means the cut used more cloth than the costing allowed for, which is margin leaving the building a metre at a time."}
          </p>
        </Card>
      )}
    </>
  );
}
