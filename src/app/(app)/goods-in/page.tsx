import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requireUser } from "@/lib/auth";
import { can } from "@/core/permissions";
import { awaitingIntake } from "@/lib/intercompany";
import { PageHeader, Card, DataTable, StatTile } from "@/components/ui";
import { formatMoney, formatNumber, dec } from "@/lib/money";
import { IntakeForm } from "./intake-form";

/**
 * الوارد من المصنع — the Brand's receiving bay.
 *
 * Goods sent by the factory land here, not on the shop floor. Someone counts
 * them, tags them, and only then do they become stock the till can sell. Two
 * things fall out of that, and both matter:
 *
 *   - what the shop counted is what gets invoiced, so a box that arrives two
 *     garments light does not quietly become two garments the brand paid for
 *     and can never find;
 *   - nothing reaches a shelf without a barcode on it.
 */
export default async function GoodsInPage() {
  const session = await requireUser();
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const mayReceive = can(session.role, "inventory:transfer");
  const maySeePrice = can(session.role, "transfer_price:view");

  const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });

  const [arriving, destinations, recentShortfalls] = await Promise.all([
    awaitingIntake(),
    db.location.findMany({
      where: { isActive: true, entityId: brand.id },
      orderBy: { sortOrder: "asc" },
    }),
    db.auditLog.findMany({
      where: { action: "RECEIVED_FROM_FACTORY" },
      orderBy: { createdAt: "desc" },
      take: 40,
      include: { user: true },
    }),
  ]);

  const name = (e: { nameAr: string; nameEn: string }) => (ar ? e.nameAr : e.nameEn);
  const today = new Date().toISOString().slice(0, 10);

  const expectedUnits = arriving.reduce((s, r) => s.plus(dec(r.expectedQty)), dec(0));
  const expectedValue = arriving.reduce(
    (s, r) => s.plus(dec(r.transferPrice ?? 0).times(dec(r.expectedQty))),
    dec(0),
  );

  // Deliveries that came up short, so a pattern is visible rather than buried.
  const shortfalls = recentShortfalls
    .map((log) => {
      const after = (log.after ?? {}) as Record<string, unknown>;
      return {
        at: log.createdAt,
        by: log.user?.name ?? "—",
        despatchNumber: String(after.despatchNumber ?? "—"),
        transferNumber: String(after.transferNumber ?? "—"),
        despatchedQty: String(after.despatchedQty ?? "0"),
        countedQty: String(after.countedQty ?? "0"),
        shortfallQty: String(after.shortfallQty ?? "0"),
        shortfallCost: after.shortfallCost == null ? null : String(after.shortfallCost),
        note: after.shortfallNote == null ? null : String(after.shortfallNote),
      };
    })
    .filter((s) => Number(s.shortfallQty) > 0);

  const shortfallCost = shortfalls.reduce((s, r) => s.plus(dec(r.shortfallCost ?? 0)), dec(0));

  return (
    <>
      <PageHeader
        title={ar ? "الوارد من المصنع" : "Goods in from the factory"}
        subtitle={
          ar
            ? "عُدّ اللي وصل، كوّده، وبعدين يدخل المعرض — الفاتورة بتتعمل على العدد اللي إنت عدّيته"
            : "Count what arrived, tag it, then it goes onto the floor — the invoice is raised for the number you counted"
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatTile
          label={ar ? "مستنية استلام" : "Waiting to be counted"}
          value={formatNumber(expectedUnits, locale)}
          tone={expectedUnits.greaterThan(0) ? "warn" : "neutral"}
          hint={ar ? "مش قابلة للبيع لحد ما تتستلم" : "Not sellable until received"}
        />
        {maySeePrice && (
          <StatTile
            label={ar ? "قيمتها عند الاستلام" : "Value on arrival"}
            value={formatMoney(expectedValue, locale)}
            hint={ar ? "لو وصلت كاملة" : "If it all arrives"}
          />
        )}
        <StatTile
          label={ar ? "فاقد في الطريق" : "Lost on the road"}
          value={formatMoney(shortfallCost, locale)}
          tone={shortfallCost.greaterThan(0) ? "bad" : "good"}
          hint={
            shortfalls.length === 0
              ? ar ? "مفيش عجز" : "No shortfalls"
              : `${shortfalls.length} ${ar ? "توريدة ناقصة" : "short deliveries"}`
          }
        />
      </div>

      {/* ---------------------------------------------------- waiting to count */}
      <Card
        className="mb-4"
        title={ar ? "في انتظار العد والتكويد" : "Waiting to be counted and tagged"}
        description={
          ar
            ? "لحد دلوقتي البضاعة دي ملك المصنع ومفيش فاتورة اتعملت عليها"
            : "Until this is done the goods are the Factory's and nothing has been invoiced"
        }
      >
        {arriving.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-400">
            {ar
              ? "مفيش حاجة في الطريق. لو مستني توريدة، اتأكد إن المصنع شحنها من صفحة الشحن للبراند."
              : "Nothing on the road. If you are expecting a delivery, check the factory has sent it from the despatch screen."}
          </p>
        ) : (
          <ul className="divide-y divide-ink-100">
            {arriving.map((r) => (
              <li key={`${r.despatchNumber}-${r.variantId}`} className="py-4">
                <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <code dir="ltr" className="text-xs text-ink-500">{r.despatchNumber}</code>
                  <code dir="ltr" className="text-xs text-ink-500">{r.sku}</code>
                  <span className="font-medium">
                    {ar ? r.styleAr : r.styleEn} · {ar ? r.colourAr : r.colourEn} · {r.size}
                  </span>
                  <span className="text-xs text-ink-400" dir="ltr">
                    {r.despatchedOn.toISOString().slice(0, 10)}
                  </span>
                  {maySeePrice && r.transferPrice && (
                    <span className="text-xs text-ink-500">
                      {ar ? "سعر التحويل" : "Transfer price"}{" "}
                      <span className="num">{Number(r.transferPrice).toFixed(2)}</span>
                    </span>
                  )}
                </div>

                {r.blockedReason === "NO_SNAPSHOT" ? (
                  <p className="text-sm text-bad">
                    {ar
                      ? "البضاعة دي مالهاش تكلفة مجمّدة، فمينفعش تتفوتر. راجع المصنع."
                      : "These carry no frozen cost, so they cannot be invoiced. Refer back to the factory."}
                  </p>
                ) : !mayReceive ? (
                  <p className="text-sm text-ink-400">
                    <span className="num">{r.expectedQty}</span>{" "}
                    {ar ? "قطعة — مش من صلاحياتك تستلمها." : "units — receiving is not yours to do."}
                  </p>
                ) : (
                  <IntakeForm
                    locale={locale}
                    today={today}
                    destinations={destinations.map((d) => ({ id: d.id, label: name(d) }))}
                    row={{
                      despatchNumber: r.despatchNumber,
                      variantId: r.variantId,
                      sku: r.sku,
                      styleId: r.styleId,
                      expectedQty: r.expectedQty,
                      transferPrice: maySeePrice ? r.transferPrice : null,
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ------------------------------------------------------- what was short */}
      {shortfalls.length > 0 && (
        <Card
          title={ar ? "توريدات وصلت ناقصة" : "Deliveries that came up short"}
          description={
            ar
              ? "محمّلة على المصنع كفاقد غير طبيعي. تكرارها من نفس الخط معناه مشكلة في النقل مش في العد."
              : "Charged to the factory as abnormal loss. A pattern here is a transport problem, not a counting one."
          }
        >
          <DataTable
            headers={[
              ar ? "إذن الشحن" : "Note",
              ar ? "الفاتورة" : "Invoice",
              ar ? "اتبعت" : "Sent",
              ar ? "وصل" : "Arrived",
              ar ? "ناقص" : "Short",
              ar ? "التكلفة" : "Cost",
              ar ? "السبب" : "Reason",
              ar ? "استلمها" : "Received by",
            ]}
            rows={shortfalls.map((s, i) => [
              <code key={`${i}-d`} dir="ltr" className="text-xs text-ink-500">{s.despatchNumber}</code>,
              <code key={`${i}-t`} dir="ltr" className="text-xs text-ink-500">{s.transferNumber}</code>,
              <span key={`${i}-e`} className="num">{s.despatchedQty}</span>,
              <span key={`${i}-c`} className="num">{s.countedQty}</span>,
              <span key={`${i}-s`} className="num text-bad">{s.shortfallQty}</span>,
              <span key={`${i}-v`} className="num">
                {s.shortfallCost ? formatMoney(dec(s.shortfallCost), locale) : "—"}
              </span>,
              <span key={`${i}-n`} className="text-ink-600">{s.note ?? "—"}</span>,
              <span key={`${i}-u`} className="text-ink-500">{s.by}</span>,
            ])}
          />
        </Card>
      )}
    </>
  );
}
