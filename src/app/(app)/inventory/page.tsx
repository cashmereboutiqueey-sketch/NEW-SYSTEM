import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requireUser } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber } from "@/lib/money";
import { agingProfile, AGE_BUCKETS, type Lot } from "@/core/fifo";
import { dec } from "@/lib/money";

/**
 * Where the money is sitting.
 *
 * This screen answers the question the specification puts most bluntly:
 * fabric bought for 10 pieces, 4 produced, 2 sold — where is the rest of the
 * capital? Raw material, work in progress and finished goods are shown
 * separately, at what they cost, because that is the cash actually tied up.
 */
export default async function InventoryPage() {
  await requireUser();
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const asOf = new Date();

  const [lots, locations, deadStockDays] = await Promise.all([
    db.inventoryLot.findMany({
      where: { remainingQty: { gt: 0 } },
      include: { material: true, variant: { include: { style: true } }, location: true },
      orderBy: [{ receivedDate: "asc" }, { sequence: "asc" }],
    }),
    db.location.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }),
    db.setting.findUnique({ where: { key: "inventory.deadStockDays" } }),
  ]);

  const value = (l: { remainingQty: unknown; unitCost: unknown }) =>
    dec(l.remainingQty as string).times(dec(l.unitCost as string));

  const byState = (state: string) => lots.filter((l) => l.state === state);
  const totalOf = (rows: typeof lots) =>
    rows.reduce((s, l) => s.plus(value(l)), dec(0));

  const raw = byState("RAW_MATERIAL");
  const wip = byState("WIP");
  const fg = byState("FINISHED_GOODS");
  const capitalLocked = totalOf(lots);

  // Finished goods age into buckets; raw material is reported separately
  // because fabric ageing means something different from unsold garments.
  const fgLots: Lot[] = fg.map((l) => ({
    id: l.id,
    receivedDate: l.receivedDate,
    sequence: l.sequence,
    remainingQty: l.remainingQty.toString(),
    unitCost: l.unitCost.toString(),
  }));
  const aging = agingProfile(fgLots, asOf);

  const deadStockThreshold = Number(deadStockDays?.value ?? 90);
  const deadValue = aging["90+"].value;

  const name = (e: { nameAr: string; nameEn: string } | null | undefined) =>
    e ? (ar ? e.nameAr : e.nameEn) : "—";

  const stateLabel: Record<string, string> = ar
    ? { RAW_MATERIAL: "خامات", WIP: "تحت التشغيل", FINISHED_GOODS: "إنتاج تام" }
    : { RAW_MATERIAL: "Raw material", WIP: "Work in progress", FINISHED_GOODS: "Finished goods" };

  return (
    <>
      <PageHeader
        title={t("inventory", locale)}
        subtitle={
          ar
            ? "رأس المال المحبوس في المخزون، مقسّمًا حسب حالته وموقعه"
            : "Capital locked in stock, split by what state it is in and where it sits"
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={ar ? "خامات" : "Raw material"}
          value={formatMoney(totalOf(raw), locale)}
          hint={`${raw.length} ${ar ? "دفعة" : "lots"}`}
        />
        <StatTile
          label={ar ? "تحت التشغيل" : "Work in progress"}
          value={formatMoney(totalOf(wip), locale)}
          hint={`${wip.length} ${ar ? "دفعة" : "lots"}`}
        />
        <StatTile
          label={ar ? "إنتاج تام" : "Finished goods"}
          value={formatMoney(totalOf(fg), locale)}
          hint={`${fg.length} ${ar ? "دفعة" : "lots"}`}
        />
        <StatTile
          label={ar ? "إجمالي المحبوس" : "Total capital locked"}
          value={formatMoney(capitalLocked, locale)}
          tone={capitalLocked.greaterThan(0) ? "warn" : "neutral"}
        />
      </div>

      {lots.length === 0 ? (
        <Card>
          <p className="py-8 text-center text-sm text-ink-400">
            {ar
              ? "لا يوجد مخزون بعد. سيظهر هنا بمجرد استلام خامات أو إنتاج."
              : "No stock yet. It appears here as soon as material is received or garments are produced."}
          </p>
        </Card>
      ) : (
        <>
          <div className="mb-4 grid gap-4 lg:grid-cols-2">
            <Card
              title={ar ? "أعمار الإنتاج التام" : "Finished goods ageing"}
              description={
                ar
                  ? `المخزون الراكد يبدأ بعد ${deadStockThreshold} يومًا`
                  : `Dead stock starts after ${deadStockThreshold} days`
              }
            >
              {fg.length === 0 ? (
                <p className="py-4 text-center text-sm text-ink-400">
                  {ar ? "لا يوجد إنتاج تام." : "No finished goods on hand."}
                </p>
              ) : (
                <DataTable
                  headers={[
                    ar ? "العمر" : "Age",
                    ar ? "الكمية" : "Quantity",
                    ar ? "رأس المال" : "Capital locked",
                  ]}
                  rows={AGE_BUCKETS.map((b) => [
                    <span key={`${b}-l`} className={b === "90+" ? "text-bad" : undefined}>
                      {b === "90+" ? (ar ? "أكثر من ٩٠ يوم" : "90+ days") : `${b} ${ar ? "يوم" : "days"}`}
                    </span>,
                    <span key={`${b}-q`} className="num">{formatNumber(aging[b].quantity, locale)}</span>,
                    <span key={`${b}-v`} className={aging[b].value.greaterThan(0) && b === "90+" ? "num text-bad" : "num"}>
                      {formatMoney(aging[b].value, locale)}
                    </span>,
                  ])}
                />
              )}
              {deadValue.greaterThan(0) && (
                <p className="mt-3 rounded-lg bg-bad/10 px-3 py-2 text-xs text-bad">
                  {ar
                    ? `المخزون الراكد: ${formatMoney(deadValue, locale)} محبوسة في بضاعة تجاوزت ٩٠ يومًا.`
                    : `Dead stock: ${formatMoney(deadValue, locale)} locked in goods older than 90 days.`}
                </p>
              )}
            </Card>

            <Card title={ar ? "حسب الموقع" : "By location"}>
              <DataTable
                headers={[
                  ar ? "الموقع" : "Location",
                  ar ? "دفعات" : "Lots",
                  ar ? "القيمة" : "Value",
                ]}
                rows={locations.map((loc) => {
                  const here = lots.filter((l) => l.locationId === loc.id);
                  return [
                    <span key={`${loc.id}-n`}>
                      {name(loc)}
                      {loc.city && <span className="ms-2 text-xs text-ink-400">{loc.city}</span>}
                    </span>,
                    <span key={`${loc.id}-c`} className="num">{here.length}</span>,
                    <span key={`${loc.id}-v`} className="num">{formatMoney(totalOf(here), locale)}</span>,
                  ];
                })}
              />
            </Card>
          </div>

          <Card
            title={ar ? "الدفعات المفتوحة" : "Open lots"}
            description={
              ar
                ? "الصرف يتم بالوارد أولًا صادر أولًا — الأقدم أولًا دائمًا"
                : "Consumption is FIFO — the oldest lot always goes first"
            }
          >
            <DataTable
              headers={[
                ar ? "الدفعة" : "Lot",
                ar ? "الحالة" : "State",
                ar ? "الصنف" : "Item",
                ar ? "الموقع" : "Location",
                ar ? "المتبقي" : "Remaining",
                ar ? "تكلفة الوحدة" : "Unit cost",
                ar ? "القيمة" : "Value",
                ar ? "تاريخ الاستلام" : "Received",
              ]}
              rows={lots.map((l) => [
                <code key={`${l.id}-n`} dir="ltr" className="text-xs text-ink-500">{l.lotNumber}</code>,
                <Badge
                  key={`${l.id}-s`}
                  tone={l.state === "FINISHED_GOODS" ? "info" : "neutral"}
                >
                  {stateLabel[l.state]}
                </Badge>,
                <span key={`${l.id}-i`}>
                  {l.material
                    ? name(l.material)
                    : l.variant
                      ? `${name(l.variant.style)} — ${l.variant.sku}`
                      : "—"}
                </span>,
                <span key={`${l.id}-l`}>{name(l.location)}</span>,
                <span key={`${l.id}-r`} className="num">{formatNumber(l.remainingQty, locale)}</span>,
                <span key={`${l.id}-u`} className="num">{formatMoney(l.unitCost, locale)}</span>,
                <span key={`${l.id}-v`} className="num font-medium">{formatMoney(value(l), locale)}</span>,
                <span key={`${l.id}-d`} className="num" dir="ltr">
                  {l.receivedDate.toISOString().slice(0, 10)}
                </span>,
              ])}
            />
          </Card>
        </>
      )}
    </>
  );
}
