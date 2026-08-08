import Link from "next/link";
import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requireUser } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { can } from "@/core/permissions";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatRate, formatNumber, formatPercent } from "@/lib/money";
import { previewStyleCost } from "@/lib/costing";
import { SnapshotForm } from "./snapshot-form";

/**
 * سعر التحويل — style costing and the transfer price.
 *
 * The whole chain is on screen: each BOM line with its waste and landed cost,
 * the SMV at the minute rate, the margin, and the resulting price. The idle
 * capacity already inside that price is called out separately, because it is
 * the part the owner can actually do something about.
 */
export default async function CostingPage({
  searchParams,
}: {
  searchParams: Promise<{ style?: string }>;
}) {
  const session = await requireUser();
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const params = await searchParams;

  const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });

  const [styles, ratePeriod, marginSetting, snapshots] = await Promise.all([
    db.style.findMany({
      where: { isActive: true },
      include: { collection: true, _count: { select: { bomLines: true, operations: true } } },
      orderBy: { code: "asc" },
    }),
    db.minuteRatePeriod.findFirst({
      where: { entityId: factory.id },
      include: { fiscalPeriod: true },
      orderBy: [{ fiscalPeriod: { year: "desc" } }, { fiscalPeriod: { month: "desc" } }],
    }),
    db.setting.findUnique({ where: { key: "factory.margin.default" } }),
    db.costSnapshot.findMany({
      include: { style: true, minuteRatePeriod: { include: { fiscalPeriod: true } } },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  const costable = styles.filter((s) => s._count.bomLines > 0 && s._count.operations > 0);
  const selected =
    costable.find((s) => s.id === params.style) ?? costable[0] ?? null;

  // A missing rate is a real state, not an error — say so plainly instead of
  // rendering a price built on nothing.
  let preview = null;
  let previewError: string | null = null;
  if (selected && ratePeriod && Number(ratePeriod.actualMinuteRate) > 0) {
    try {
      preview = await previewStyleCost({
        styleId: selected.id,
        minuteRatePeriodId: ratePeriod.id,
      });
    } catch (e) {
      previewError = e instanceof Error ? e.message : String(e);
    }
  }

  const name = (e: { nameAr: string; nameEn: string }) => (ar ? e.nameAr : e.nameEn);

  return (
    <>
      <PageHeader
        title={t("transferPrice", locale)}
        subtitle={
          ar
            ? "كل رقم قابل للفتح: الخامة والهدر والدقائق والهامش"
            : "Every figure opens up: materials, waste, minutes and margin"
        }
      />

      {!ratePeriod || Number(ratePeriod.actualMinuteRate) === 0 ? (
        <Card>
          <p className="py-6 text-center text-sm text-ink-500">
            {ar
              ? "لا توجد تكلفة دقيقة محسوبة بعد — لا يمكن تسعير أي موديل قبلها."
              : "No minute rate has been calculated yet — nothing can be costed until it is."}
            <Link href="/minute-rate" className="ms-2 underline">
              {ar ? "احسب تكلفة الدقيقة" : "Calculate the minute rate"}
            </Link>
          </p>
        </Card>
      ) : (
        <>
          <Card className="mb-4" title={ar ? "اختر الموديل" : "Choose a style"}>
            <div className="flex flex-wrap gap-2">
              {costable.map((s) => (
                <Link
                  key={s.id}
                  href={`/costing?style=${s.id}`}
                  className={
                    "rounded-lg border px-3 py-1.5 text-sm " +
                    (selected?.id === s.id
                      ? "border-ink-900 bg-ink-900 text-white"
                      : "border-ink-200 text-ink-700 hover:border-ink-400")
                  }
                >
                  <span className="num" dir="ltr">{s.code}</span>
                  <span className="ms-2">{name(s)}</span>
                </Link>
              ))}
            </div>
          </Card>

          {previewError && (
            <Card className="mb-4">
              <p className="py-4 text-center text-sm text-bad">{previewError}</p>
            </Card>
          )}

          {preview && selected && (
            <>
              <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatTile
                  label={ar ? "تكلفة الخامات" : "Material cost"}
                  value={formatMoney(preview.materialCost, locale)}
                />
                <StatTile
                  label={ar ? "تكلفة التصنيع" : "Manufacturing (CMT)"}
                  value={formatMoney(preview.cmtCost, locale)}
                  hint={`${formatNumber(preview.smvMinutes, locale)} ${ar ? "دقيقة" : "min"} × ${formatRate(preview.ratePeriod.actualMinuteRate, locale)}`}
                />
                <StatTile
                  label={ar ? "سعر التحويل" : "Transfer price"}
                  value={formatMoney(preview.transferPrice, locale)}
                  tone={preview.marginBelowArmsLength ? "bad" : "good"}
                  hint={`${ar ? "هامش" : "margin"} ${formatPercent(preview.factoryMarginPct, locale)}`}
                />
                <StatTile
                  label={ar ? "منها طاقة عاطلة" : "Of which idle capacity"}
                  value={formatMoney(preview.idlePenalty, locale)}
                  tone="warn"
                  hint={ar ? "مدفون داخل تكلفة التصنيع" : "Buried inside the CMT cost"}
                />
              </div>

              <div className="mb-4 grid gap-4 lg:grid-cols-2">
                <Card
                  title={ar ? "مكونات الخامات" : "Bill of materials"}
                  description={
                    ar
                      ? "التكلفة النهائية تشمل الشحن والجمارك، لا سعر الفاتورة وحده"
                      : "Landed cost including freight and duty, not the invoice price alone"
                  }
                >
                  <DataTable
                    headers={[
                      ar ? "الخامة" : "Material",
                      ar ? "المعياري" : "Standard",
                      ar ? "الهدر" : "Waste",
                      ar ? "الفعلي" : "Effective",
                      ar ? "سعر الوحدة" : "Unit cost",
                      ar ? "التكلفة" : "Cost",
                    ]}
                    rows={preview.lines.map((l) => [
                      <span key={`${l.materialId}-n`}>
                        <code dir="ltr" className="text-xs text-ink-500">{l.materialCode}</code>
                        <span className="ms-2">{ar ? l.materialNameAr : l.materialNameEn}</span>
                      </span>,
                      <span key={`${l.materialId}-s`} className="num">{formatNumber(l.standardConsumption, locale)}</span>,
                      <span key={`${l.materialId}-w`} className="num">{formatPercent(l.wasteRate, locale)}</span>,
                      <span key={`${l.materialId}-e`} className="num">{formatNumber(l.effectiveConsumption, locale)}</span>,
                      <span key={`${l.materialId}-u`} className="num">{formatMoney(l.unitCost, locale)}</span>,
                      <span key={`${l.materialId}-c`} className="num font-medium">{formatMoney(l.lineCost, locale)}</span>,
                    ])}
                  />
                </Card>

                <Card title={ar ? "من التكلفة إلى السعر" : "From cost to price"}>
                  <dl className="space-y-2 text-sm">
                    {[
                      [ar ? "قماش" : "Fabric", formatMoney(preview.fabricCost, locale)],
                      [ar ? "إكسسوارات" : "Trims", formatMoney(preview.trimCost, locale)],
                      [ar ? "إجمالي الخامات" : "Material cost", formatMoney(preview.materialCost, locale)],
                      [ar ? "الدقائق المعيارية" : "SMV minutes", formatNumber(preview.smvMinutes, locale)],
                      [ar ? "تكلفة الدقيقة" : "Minute rate", formatRate(preview.ratePeriod.actualMinuteRate, locale)],
                      [ar ? "تكلفة التصنيع" : "CMT cost", formatMoney(preview.cmtCost, locale)],
                      [ar ? "إجمالي تكلفة المصنع" : "Factory total cost", formatMoney(preview.factoryTotalCost, locale)],
                      [ar ? "هامش المصنع" : "Factory margin", formatPercent(preview.factoryMarginPct, locale)],
                      [ar ? "قيمة الهامش" : "Margin value", formatMoney(preview.factoryMarginValue, locale)],
                      [ar ? "سعر التحويل" : "Transfer price", formatMoney(preview.transferPrice, locale)],
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
                  <p className="mt-3 text-xs text-ink-500">
                    {ar
                      ? "الهامش يُطبَّق على التكلفة الكاملة شاملة الخامات (قرار D-002)."
                      : "The margin applies to full cost including materials (decision D-002)."}
                  </p>
                </Card>
              </div>

              {can(session.role, "production:confirm_cost") && (
                <Card
                  className="mb-4"
                  title={ar ? "تجميد التكلفة" : "Freeze this costing"}
                  description={
                    ar
                      ? `مبنية على تكلفة دقيقة ${preview.ratePeriod.fiscalPeriod.year}-${String(preview.ratePeriod.fiscalPeriod.month).padStart(2, "0")}`
                      : `Built on the ${preview.ratePeriod.fiscalPeriod.year}-${String(preview.ratePeriod.fiscalPeriod.month).padStart(2, "0")} minute rate`
                  }
                >
                  <SnapshotForm
                    locale={locale}
                    styleId={selected.id}
                    minuteRatePeriodId={preview.ratePeriod.id}
                    defaultMarginPct={marginSetting?.value ?? "0.18"}
                    canOverrideMargin={can(session.role, "transfer_price:override")}
                  />
                </Card>
              )}
            </>
          )}
        </>
      )}

      <Card title={ar ? "اللقطات المجمّدة" : "Frozen snapshots"}>
        {snapshots.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-400">
            {ar ? "لا توجد لقطات تكلفة بعد." : "No cost snapshots yet."}
          </p>
        ) : (
          <DataTable
            headers={[
              ar ? "الموديل" : "Style",
              ar ? "تاريخ التجميد" : "Frozen at",
              ar ? "شهر التكلفة" : "Rate period",
              ar ? "تكلفة المصنع" : "Factory cost",
              ar ? "الهامش" : "Margin",
              ar ? "سعر التحويل" : "Transfer price",
              "",
            ]}
            rows={snapshots.map((s) => [
              <span key={`${s.id}-s`}>
                <code dir="ltr" className="text-xs text-ink-500">{s.style.code}</code>
                <span className="ms-2">{name(s.style)}</span>
              </span>,
              <span key={`${s.id}-d`} className="num" dir="ltr">
                {s.createdAt.toISOString().slice(0, 10)}
              </span>,
              <span key={`${s.id}-p`} className="num" dir="ltr">
                {s.minuteRatePeriod.fiscalPeriod.year}-
                {String(s.minuteRatePeriod.fiscalPeriod.month).padStart(2, "0")}
              </span>,
              <span key={`${s.id}-c`} className="num">{formatMoney(s.factoryTotalCost, locale)}</span>,
              <span key={`${s.id}-m`} className="num">{formatPercent(s.factoryMarginPct, locale)}</span>,
              <span key={`${s.id}-t`} className="num font-medium">{formatMoney(s.transferPrice, locale)}</span>,
              s.marginBelowArmsLength ? (
                <Badge key={`${s.id}-f`} tone="bad">
                  {ar ? "تحت الحد الأدنى" : "Below floor"}
                </Badge>
              ) : (
                <span key={`${s.id}-f`} />
              ),
            ])}
          />
        )}
      </Card>
    </>
  );
}
