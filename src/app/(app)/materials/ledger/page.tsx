import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { fabricLedger, fabricTotals } from "@/lib/fabric-ledger";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber, formatPercent, formatQty } from "@/lib/money";

/**
 * كشف القماش — bought, drawn, left.
 *
 * The inventory screen answers "what do I have". It does not answer the
 * question somebody standing in the store actually asks about a particular
 * cloth: how much did I buy, how much have I pulled, and what is on the shelf
 * now.
 *
 * All three are already recorded — a lot keeps the quantity it arrived with
 * alongside the quantity left — and what was drawn is split by where it went,
 * because cloth issued to a run and cloth thrown away are the same subtraction
 * and completely different problems.
 */
export default async function MaterialLedgerPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; all?: string }>;
}) {
  await requirePermission("inventory:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const query = await searchParams;

  const type =
    query.type === "ALL" || query.type === "TRIM" ? query.type : ("FABRIC" as const);
  const includeFinished = query.all === "1";

  const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });
  const rows = await fabricLedger(factory.id, { materialType: type, includeFinished });
  const totals = fabricTotals(rows);

  const link = (next: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ type: query.type, all: query.all, ...next })) {
      if (v) p.set(k, v);
    }
    const q = p.toString();
    return q ? `/materials/ledger?${q}` : "/materials/ledger";
  };

  const tab = (active: boolean) =>
    active
      ? "rounded-md bg-ink-900 px-3 py-1.5 text-white"
      : "rounded-md border border-line px-3 py-1.5 text-ink-600 hover:border-ink-300";

  const day = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : "—");

  return (
    <>
      <PageHeader
        title={ar ? "كشف الخامات" : "Material ledger"}
        subtitle={
          ar
            ? `${factory.nameAr} — كل خامة: اشتريت كام، سحبت كام، وفاضل كام دلوقتي`
            : `${factory.nameEn} — for each material: bought, drawn, and what is left`
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <a href={link({ type: undefined })} className={tab(type === "FABRIC")}>
          {ar ? "قماش" : "Fabric"}
        </a>
        <a href={link({ type: "TRIM" })} className={tab(type === "TRIM")}>
          {ar ? "إكسسوارات" : "Trims"}
        </a>
        <a href={link({ type: "ALL" })} className={tab(type === "ALL")}>
          {ar ? "الكل" : "Everything"}
        </a>
        <span className="mx-1 text-ink-300">|</span>
        <a href={link({ all: includeFinished ? undefined : "1" })} className={tab(includeFinished)}>
          {ar ? "اعرض اللي خلص كمان" : "Include what ran out"}
        </a>
      </div>

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <StatTile
          label={ar ? "اتشترى" : "Bought"}
          value={formatQty(totals.purchased.toString())}
          hint={`${formatNumber(totals.materials)} ${ar ? "خامة" : "materials"}`}
        />
        <StatTile
          label={ar ? "اتسحب" : "Drawn"}
          value={formatQty(totals.drawn.toString())}
          hint={
            totals.scrapped.greaterThan(0)
              ? `${ar ? "منها هالك" : "of which scrapped"} ${formatQty(totals.scrapped.toString())}`
              : ar ? "مفيش هالك" : "none scrapped"
          }
        />
        <StatTile
          label={ar ? "فاضل على الرف" : "Left on the shelf"}
          value={formatQty(totals.remaining.toString())}
          hint={
            totals.stillOnShelf
              ? `${formatPercent(totals.stillOnShelf.toString())} ${ar ? "من اللي اتشترى" : "of what was bought"}`
              : undefined
          }
          tone="info"
        />
        <StatTile
          label={ar ? "قيمة اللي فاضل" : "Value on the shelf"}
          value={formatMoney(totals.value.toString())}
          hint={ar ? "بالتكلفة الفعلية" : "at what it actually cost"}
          tone={totals.standing > 0 ? "warn" : "neutral"}
        />
      </div>

      {rows.length === 0 ? (
        <Card>
          <p className="py-8 text-center text-sm text-ink-400">
            {ar
              ? "مفيش خامات في مخزن المصنع دلوقتي."
              : "There is nothing in the factory store right now."}
          </p>
        </Card>
      ) : (
        <>
          <div className="mb-5">
            <Card
              title={ar ? "كل خامة" : "By material"}
              description={
                ar
                  ? "«اتسحب» مقسوم على وشّه: اللي راح للتصنيع، واللي اترمى، واللي اتنقل. الطرح واحد بس المشكلة مختلفة."
                  : "\"Drawn\" is split by where it went: into production, thrown away, or moved. Same subtraction, different problems."
              }
            >
              <DataTable
                headers={[
                  ar ? "الكود" : "Code",
                  ar ? "الخامة" : "Material",
                  ar ? "اتشترى" : "Bought",
                  ar ? "اتسحب" : "Drawn",
                  ar ? "فاضل" : "Left",
                  ar ? "للتصنيع" : "To production",
                  ar ? "هالك" : "Scrapped",
                  ar ? "نسبة الاستهلاك" : "Used",
                  ar ? "متوسط التكلفة" : "Avg cost",
                  ar ? "القيمة" : "Value",
                  ar ? "أقدم رصيد" : "Oldest",
                ]}
                rows={rows.map((r) => [
                  <span key="c" className="num text-xs" dir="ltr">{r.code}</span>,
                  <span key="n" className="font-medium text-ink-900">
                    {ar ? r.nameAr : r.nameEn}
                    <span className="ms-2 text-xs text-ink-400">{r.uom}</span>
                  </span>,
                  <span key="b" className="num">{formatQty(r.purchased.toString())}</span>,
                  <span key="d" className="num text-ink-500">{formatQty(r.drawn.toString())}</span>,
                  <span key="l" className="num font-medium">{formatQty(r.remaining.toString())}</span>,
                  <span key="p" className="num text-xs">
                    {formatQty(r.movements.toProduction.toString())}
                  </span>,
                  r.movements.scrapped.greaterThan(0) ? (
                    <Badge key="s" tone="bad">{formatQty(r.movements.scrapped.toString())}</Badge>
                  ) : (
                    <span key="s" className="text-ink-300">—</span>
                  ),
                  r.usedPct ? (
                    <Badge
                      key="u"
                      tone={
                        Number(r.usedPct) >= 0.9 ? "warn" : Number(r.usedPct) >= 0.5 ? "info" : "neutral"
                      }
                    >
                      {formatPercent(r.usedPct.toString())}
                    </Badge>
                  ) : (
                    <span key="u" className="text-ink-300">—</span>
                  ),
                  <span key="a" className="num text-xs text-ink-500">
                    {r.averageCost ? formatMoney(r.averageCost.toString()) : "—"}
                  </span>,
                  <span key="v" className="num font-medium">{formatMoney(r.value.toString())}</span>,
                  r.oldestAgeDays != null ? (
                    <span
                      key="o"
                      className={r.oldestAgeDays > 90 ? "num text-xs text-bad" : "num text-xs text-ink-500"}
                    >
                      {formatNumber(r.oldestAgeDays)} {ar ? "يوم" : "d"}
                    </span>
                  ) : (
                    <span key="o" className="text-ink-300">—</span>
                  ),
                ])}
              />
            </Card>
          </div>

          {rows.map((r) => (
            <div key={r.materialId} className="mb-4">
              <Card
                title={`${r.code} — ${ar ? r.nameAr : r.nameEn}`}
                description={
                  ar
                    ? `${r.deliveries} توريد · أول واحد ${day(r.firstReceived)} · آخر واحد ${day(r.lastReceived)}`
                    : `${r.deliveries} delivery/ies · first ${day(r.firstReceived)} · latest ${day(r.lastReceived)}`
                }
              >
                <DataTable
                  headers={[
                    ar ? "التاريخ" : "Received",
                    ar ? "رقم اللوط" : "Lot",
                    ar ? "المورد" : "Supplier",
                    ar ? "المخزن" : "Store",
                    ar ? "جه كام" : "Arrived",
                    ar ? "فاضل منه" : "Left of it",
                    ar ? "سعر الوحدة" : "Unit cost",
                    ar ? "القيمة" : "Value",
                    ar ? "واقف من" : "Standing",
                  ]}
                  rows={r.lots.map((lot) => [
                    <span key="d" className="num text-xs" dir="ltr">{day(lot.receivedDate)}</span>,
                    <span key="n" className="num text-xs" dir="ltr">{lot.lotNumber}</span>,
                    <span key="s" className="text-xs text-ink-500">
                      {lot.supplierAr ? (ar ? lot.supplierAr : lot.supplierEn) : "—"}
                    </span>,
                    <span key="l" className="text-xs text-ink-500">
                      {lot.locationAr ? (ar ? lot.locationAr : lot.locationEn) : "—"}
                    </span>,
                    <span key="o" className="num">{formatQty(lot.originalQty)}</span>,
                    Number(lot.remainingQty) > 0 ? (
                      <span key="r" className="num font-medium">{formatQty(lot.remainingQty)}</span>
                    ) : (
                      <span key="r" className="text-xs text-ink-400">
                        {ar ? "خلص" : "used up"}
                      </span>
                    ),
                    <span key="u" className="num text-xs">{formatMoney(lot.unitCost)}</span>,
                    <span key="v" className="num">{formatMoney(lot.value)}</span>,
                    <span
                      key="a"
                      className={lot.ageDays > 90 ? "num text-xs text-bad" : "num text-xs text-ink-500"}
                    >
                      {formatNumber(lot.ageDays)} {ar ? "يوم" : "d"}
                    </span>,
                  ])}
                />
              </Card>
            </div>
          ))}

          <p className="text-xs text-ink-400">
            {ar
              ? "الأسعار مختلفة بين التوريدات لأن كل شحنة بتتسجل بتكلفتها هي — والصرف بياخد من الأقدم الأول، فالقيمة اللي فاضلة هي تكلفة القماش اللي على الرف فعلًا، مش متوسط."
              : "Unit costs differ between deliveries because each is recorded at what it actually cost, and issues draw from the oldest first — so the value here is what the cloth on the shelf cost, not an average."}
          </p>
        </>
      )}
    </>
  );
}
