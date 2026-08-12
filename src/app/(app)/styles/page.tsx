import Link from "next/link";
import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { can } from "@/core/permissions";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { EntityForm } from "@/components/entity-form";
import { formatMoney, formatNumber, formatPercent } from "@/lib/money";
import { styleDetail } from "@/lib/products";
import { dec } from "@/lib/money";
import {
  createStyleAction, createCollectionAction,
  addBomLineAction, removeBomLineAction,
  addOperationAction, removeOperationAction,
} from "./actions";
import { VariantForm } from "./variant-form";
import { PhotoForm } from "./photo-form";
import { AddInline } from "@/components/add-inline";
import { addColourAction, addSizeAction } from "../master-data-actions";
import { imageUrl } from "@/lib/images";

/**
 * الموديلات — styles.
 *
 * A style is the costing level, so this is where a garment is specified: what
 * it is made of, how long it takes, and which SKUs it exists as. SMV is never
 * typed in as one number — it is the sum of the operations, so the minute
 * count can be argued with line by line.
 */
export default async function StylesPage({
  searchParams,
}: {
  searchParams: Promise<{ style?: string }>;
}) {
  const session = await requirePermission("production:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const params = await searchParams;

  const mayDesign = can(session.role, "retail_price:manage");
  const mayEngineer = can(session.role, "production:create");

  const [styles, collections, materials, colours, sizes, lines] = await Promise.all([
    db.style.findMany({
      include: {
        collection: true,
        _count: { select: { bomLines: true, operations: true, variants: true } },
      },
      orderBy: [{ isActive: "desc" }, { code: "asc" }],
    }),
    db.collection.findMany({ where: { isActive: true }, orderBy: { code: "asc" } }),
    db.material.findMany({
      where: { isActive: true },
      include: { uom: true },
      orderBy: [{ type: "asc" }, { code: "asc" }],
    }),
    db.colorCode.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }),
    db.sizeCode.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }),
    db.productionLine.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }),
  ]);

  const selected = params.style ? await styleDetail(params.style) : null;
  const name = (e: { nameAr: string; nameEn: string }) => (ar ? e.nameAr : e.nameEn);

  const ready = styles.filter((s) => s._count.bomLines > 0 && s._count.operations > 0);
  const incomplete = styles.filter((s) => s._count.bomLines === 0 || s._count.operations === 0);

  return (
    <>
      <PageHeader
        title={ar ? "الموديلات" : "Styles"}
        subtitle={
          ar
            ? "الموديل هو مستوى التسعير — مكوناته وعملياته هما اللي بيحددوا تكلفته"
            : "A style is the costing level — its materials and operations are what decide its cost"
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatTile
          label={ar ? "جاهزة للتسعير" : "Ready to cost"}
          value={formatNumber(ready.length, locale)}
          tone={ready.length > 0 ? "good" : "neutral"}
          hint={ar ? "لها مكونات وعمليات" : "Has both materials and operations"}
        />
        <StatTile
          label={ar ? "ناقصة بيانات" : "Incomplete"}
          value={formatNumber(incomplete.length, locale)}
          tone={incomplete.length > 0 ? "warn" : "good"}
        />
        <StatTile
          label={ar ? "أكواد المنتجات" : "SKUs"}
          value={formatNumber(
            styles.reduce((s, x) => s + x._count.variants, 0),
            locale,
          )}
        />
      </div>

      {/* ------------------------------------------------------ style detail */}
      {selected && (
        <>
          <Card
            className="mb-4"
            title={`${selected.code} — ${name(selected)}`}
            description={`${name(selected.collection)} · ${ar ? "هدر مخطط" : "planned waste"} ${formatPercent(selected.plannedWasteRate, locale)}`}
          >
            {mayDesign && (
              <div className="mb-4 border-b border-ink-200 pb-4">
                <PhotoForm
                  ar={ar}
                  styleId={selected.id}
                  current={imageUrl(selected.imageName)}
                  label={
                    ar
                      ? "الصورة اللي هتظهر للبياع على الكاشير."
                      : "The photo the till shows the salesperson."
                  }
                />
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-4">
              <div>
                <div className="text-xs text-ink-500">{ar ? "الدقائق المعيارية" : "Standard minutes"}</div>
                <div className="num text-lg font-semibold">
                  {formatNumber(selected.totalSmvMinutes, locale)}
                </div>
              </div>
              <div>
                <div className="text-xs text-ink-500">{ar ? "مكونات" : "BOM lines"}</div>
                <div className="num text-lg font-semibold">{selected.bomLines.length}</div>
              </div>
              <div>
                <div className="text-xs text-ink-500">{ar ? "أكواد" : "SKUs"}</div>
                <div className="num text-lg font-semibold">{selected.variants.length}</div>
              </div>
              <div>
                <div className="text-xs text-ink-500">{ar ? "لقطات تكلفة" : "Cost snapshots"}</div>
                <div className="num text-lg font-semibold">{selected._count.costSnapshots}</div>
              </div>
            </div>
            {selected._count.productionOrders > 0 && (
              <p className="mt-3 rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">
                {ar
                  ? "الموديل ده له أوامر إنتاج — المكونات والعمليات مقفولة طالما فيه أمر شغّال، عشان مايتصنّعش بمواصفة غير اللي اتسعّر بيها."
                  : "This style has production orders — its materials and operations are locked while an order is live, so nothing is made to a different specification than it was costed for."}
              </p>
            )}
          </Card>

          <div className="mb-4 grid gap-4 lg:grid-cols-2">
            {/* --- bill of materials --- */}
            <Card
              title={ar ? "المكونات" : "Bill of materials"}
              description={
                ar
                  ? "الاستهلاك للقطعة الواحدة بالمقاس الأساسي، قبل الهدر"
                  : "Consumption per garment at the base size, before waste"
              }
            >
              {selected.bomLines.length === 0 ? (
                <p className="py-4 text-center text-sm text-ink-400">
                  {ar ? "لا توجد مكونات بعد." : "No materials yet."}
                </p>
              ) : (
                <DataTable
                  headers={[
                    ar ? "الخامة" : "Material",
                    ar ? "الاستهلاك" : "Consumption",
                    ar ? "هدر خاص" : "Waste override",
                    ...(mayEngineer ? [""] : []),
                  ]}
                  rows={selected.bomLines.map((l) => [
                    <span key={`${l.id}-m`}>
                      <code dir="ltr" className="text-xs text-ink-500">{l.material.code}</code>
                      <span className="ms-2">{name(l.material)}</span>
                    </span>,
                    <span key={`${l.id}-q`} className="num">
                      {formatNumber(l.standardConsumption, locale)} {l.material.uom.code}
                    </span>,
                    <span key={`${l.id}-w`} className="num text-ink-500">
                      {l.wasteRateOverride ? formatPercent(l.wasteRateOverride, locale) : "—"}
                    </span>,
                    ...(mayEngineer
                      ? [
                          <form key={`${l.id}-x`} action={removeBomLineAction}>
                            <input type="hidden" name="id" value={l.id} />
                            <input type="hidden" name="styleId" value={selected.id} />
                            <button type="submit" className="text-xs text-ink-400 hover:text-bad">
                              {ar ? "حذف" : "Remove"}
                            </button>
                          </form>,
                        ]
                      : []),
                  ])}
                />
              )}

              {mayEngineer && (
                <div className="mt-4 border-t border-ink-100 pt-4">
                  <EntityForm
                    locale={locale}
                    action={addBomLineAction}
                    hidden={{ styleId: selected.id }}
                    columns={2}
                    submitEn="Add material"
                    submitAr="أضف خامة"
                    fields={[
                      {
                        kind: "select", name: "materialId", labelEn: "Material", labelAr: "الخامة",
                        required: true, span: 2,
                        options: materials.map((m) => ({
                          value: m.id,
                          label: `${m.code} — ${name(m)} (${m.uom.code})`,
                        })),
                      },
                      {
                        kind: "number", name: "standardConsumption",
                        labelEn: "Consumption per garment", labelAr: "الاستهلاك للقطعة",
                        required: true, step: "0.0001", min: "0.0001", ltr: true,
                      },
                      {
                        kind: "number", name: "wasteRateOverride",
                        labelEn: "Waste override %", labelAr: "هدر خاص %",
                        step: "0.1", min: "0", max: "100", ltr: true,
                        hintEn: "Leave blank to use the style's planned waste.",
                        hintAr: "سيبها فاضية عشان تستخدم هدر الموديل.",
                      },
                    ]}
                  />
                </div>
              )}
            </Card>

            {/* --- operations --- */}
            <Card
              title={ar ? "العمليات" : "Operations"}
              description={
                ar
                  ? "مجموع الدقائق هو الـ SMV — مابيتكتبش رقم واحد"
                  : "The sum of these minutes is the SMV — it is never typed in as one number"
              }
            >
              {selected.operations.length === 0 ? (
                <p className="py-4 text-center text-sm text-ink-400">
                  {ar ? "لا توجد عمليات بعد." : "No operations yet."}
                </p>
              ) : (
                <DataTable
                  headers={[
                    "#",
                    ar ? "العملية" : "Operation",
                    ar ? "الخط" : "Line",
                    ar ? "دقائق" : "Minutes",
                    ...(mayEngineer ? [""] : []),
                  ]}
                  rows={selected.operations.map((o) => [
                    <span key={`${o.id}-s`} className="num text-xs text-ink-400">{o.sequence}</span>,
                    <span key={`${o.id}-n`}>{name(o)}</span>,
                    <span key={`${o.id}-l`} className="text-xs text-ink-500">
                      {o.line ? name(o.line) : "—"}
                    </span>,
                    <span key={`${o.id}-m`} className="num">
                      {formatNumber(o.smvMinutes, locale)}
                    </span>,
                    ...(mayEngineer
                      ? [
                          <form key={`${o.id}-x`} action={removeOperationAction}>
                            <input type="hidden" name="id" value={o.id} />
                            <input type="hidden" name="styleId" value={selected.id} />
                            <button type="submit" className="text-xs text-ink-400 hover:text-bad">
                              {ar ? "حذف" : "Remove"}
                            </button>
                          </form>,
                        ]
                      : []),
                  ])}
                />
              )}

              {mayEngineer && (
                <div className="mt-4 border-t border-ink-100 pt-4">
                  <EntityForm
                    locale={locale}
                    action={addOperationAction}
                    hidden={{ styleId: selected.id }}
                    columns={2}
                    submitEn="Add operation"
                    submitAr="أضف عملية"
                    fields={[
                      { kind: "text", name: "nameEn", labelEn: "Operation (English)", labelAr: "العملية بالإنجليزية", required: true },
                      { kind: "text", name: "nameAr", labelEn: "Operation (Arabic)", labelAr: "العملية بالعربية", required: true },
                      {
                        kind: "number", name: "smvMinutes", labelEn: "Standard minutes", labelAr: "الدقائق المعيارية",
                        required: true, step: "0.01", min: "0.01", ltr: true,
                      },
                      {
                        kind: "select", name: "lineId", labelEn: "Line", labelAr: "الخط",
                        options: lines.map((l) => ({ value: l.id, label: name(l) })),
                        emptyLabel: ar ? "— أي خط —" : "— any line —",
                      },
                    ]}
                  />
                </div>
              )}
            </Card>
          </div>

          {/* --- SKUs --- */}
          <Card
            className="mb-4"
            title={ar ? "الأكواد" : "SKUs"}
            description={`${ar ? "الصيغة" : "Format"}: ${selected.code}-${ar ? "لون" : "COLOUR"}-${ar ? "مقاس" : "SIZE"}`}
          >
            {mayDesign && (
              <div className="mb-4 border-b border-ink-100 pb-4">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <span className="text-xs text-ink-500">
                    {ar ? "اللون أو المقاس مش في القايمة؟" : "Colour or size not listed?"}
                  </span>
                  <AddInline
                    ar={ar}
                    title={ar ? "لون جديد" : "New colour"}
                    action={addColourAction}
                    label={ar ? "+ لون" : "+ Colour"}
                    fields={[
                      { name: "nameAr", label: ar ? "الاسم" : "Name", required: true, half: true },
                      { name: "code", label: ar ? "كود" : "Code", required: true, half: true, placeholder: "NVY" },
                      {
                        name: "hex",
                        label: ar ? "درجة اللون" : "Swatch",
                        placeholder: "#1b2a4a",
                        hint: ar ? "اختياري — بيظهر للبياع على الكاشير" : "Optional — shown at the till",
                      },
                    ]}
                  />
                  <AddInline
                    ar={ar}
                    title={ar ? "مقاس جديد" : "New size"}
                    action={addSizeAction}
                    label={ar ? "+ مقاس" : "+ Size"}
                    fields={[
                      { name: "code", label: ar ? "المقاس" : "Size", required: true, half: true, placeholder: "XXL" },
                      {
                        name: "consumptionFactor",
                        label: ar ? "معامل القماش" : "Cloth factor",
                        type: "number",
                        step: "0.01",
                        min: "0.01",
                        defaultValue: "1",
                        half: true,
                        hint: ar
                          ? "١ = المقاس الأساسي. XL بياخد قماش أكتر فعلاً."
                          : "1 is the base size. An XL genuinely uses more.",
                      },
                    ]}
                  />
                </div>

                <VariantForm
                  locale={locale}
                  styleId={selected.id}
                  styleCode={selected.code}
                  colours={colours}
                  sizes={sizes}
                  existing={new Set(selected.variants.map((v) => v.sku))}
                />
              </div>
            )}

            {selected.variants.length === 0 ? (
              <p className="py-4 text-center text-sm text-ink-400">
                {ar ? "لا توجد أكواد بعد." : "No SKUs yet."}
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {selected.variants.map((v) => (
                  <span
                    key={v.id}
                    className="flex items-center gap-1.5 rounded-lg border border-ink-200 px-2 py-1"
                  >
                    {v.colorCode.hex && (
                      <span
                        aria-hidden
                        className="h-2.5 w-2.5 rounded-full border border-ink-300"
                        style={{ backgroundColor: v.colorCode.hex }}
                      />
                    )}
                    <code dir="ltr" className="text-xs">{v.sku}</code>
                  </span>
                ))}
              </div>
            )}
          </Card>
        </>
      )}

      {/* ------------------------------------------------------- style list */}
      <Card
        className="mb-4"
        title={ar ? "كل الموديلات" : "All styles"}
        description={ar ? "اضغط على موديل عشان تفتح مكوناته" : "Open a style to edit its specification"}
      >
        {styles.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-400">
            {ar ? "لا توجد موديلات بعد." : "No styles yet."}
          </p>
        ) : (
          <DataTable
            headers={[
              ar ? "الكود" : "Code",
              ar ? "الموديل" : "Style",
              ar ? "التشكيلة" : "Collection",
              ar ? "مكونات" : "BOM",
              ar ? "دقائق" : "Minutes",
              ar ? "أكواد" : "SKUs",
              ar ? "سعر البيع" : "Retail",
              ar ? "الحالة" : "Status",
            ]}
            rows={styles.map((s) => {
              const complete = s._count.bomLines > 0 && s._count.operations > 0;
              return [
                <Link key={`${s.id}-c`} href={`/styles?style=${s.id}`} className="underline">
                  <code dir="ltr" className="text-xs">{s.code}</code>
                </Link>,
                <span key={`${s.id}-n`}>{name(s)}</span>,
                <span key={`${s.id}-col`} className="text-sm text-ink-600">
                  {name(s.collection)}
                </span>,
                <span key={`${s.id}-b`} className="num">{s._count.bomLines}</span>,
                <span key={`${s.id}-m`} className="num">
                  {dec(s.totalSmvMinutes).isZero() ? "—" : formatNumber(s.totalSmvMinutes, locale)}
                </span>,
                <span key={`${s.id}-v`} className="num">{s._count.variants}</span>,
                <span key={`${s.id}-r`} className="num">
                  {s.retailPrice ? formatMoney(s.retailPrice, locale) : "—"}
                </span>,
                <Badge key={`${s.id}-s`} tone={complete ? "good" : "warn"}>
                  {complete
                    ? ar ? "جاهز" : "Ready"
                    : ar ? "ناقص" : "Incomplete"}
                </Badge>,
              ];
            })}
          />
        )}
      </Card>

      {mayDesign && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title={ar ? "موديل جديد" : "New style"}>
            <EntityForm
              locale={locale}
              action={createStyleAction}
              columns={2}
              submitEn="Create style"
              submitAr="أنشئ الموديل"
              fields={[
                {
                  kind: "text", name: "code", labelEn: "Style code", labelAr: "كود الموديل",
                  required: true, placeholder: "DALIA", ltr: true,
                  hintEn: "Letters and digits only. Becomes the first part of every SKU.",
                  hintAr: "حروف وأرقام بس. بيبقى أول جزء في كل كود منتج.",
                },
                {
                  kind: "select", name: "collectionId", labelEn: "Collection", labelAr: "التشكيلة",
                  required: true,
                  options: collections.map((c) => ({ value: c.id, label: `${c.code} — ${name(c)}` })),
                },
                { kind: "text", name: "nameEn", labelEn: "Name (English)", labelAr: "الاسم بالإنجليزية", required: true },
                { kind: "text", name: "nameAr", labelEn: "Name (Arabic)", labelAr: "الاسم بالعربية", required: true },
                {
                  kind: "number", name: "plannedWasteRate", labelEn: "Planned waste %", labelAr: "الهدر المخطط %",
                  defaultValue: 8, step: "0.1", min: "0", max: "100", ltr: true,
                  hintEn: "Used for costing. Actual waste is measured separately from real cutting.",
                  hintAr: "بيُستخدم في التسعير. الهدر الفعلي بيتقاس من القص الحقيقي.",
                },
                {
                  kind: "number", name: "retailPrice", labelEn: "Retail price", labelAr: "سعر البيع",
                  step: "0.01", min: "0", ltr: true,
                },
              ]}
            />
          </Card>

          <Card title={ar ? "تشكيلة جديدة" : "New collection"}>
            <EntityForm
              locale={locale}
              action={createCollectionAction}
              columns={2}
              submitEn="Create collection"
              submitAr="أنشئ التشكيلة"
              fields={[
                { kind: "text", name: "code", labelEn: "Code", labelAr: "الكود", required: true, ltr: true, placeholder: "AW26" },
                { kind: "text", name: "season", labelEn: "Season", labelAr: "الموسم", required: true, placeholder: ar ? "خريف/شتاء" : "Autumn/Winter" },
                { kind: "text", name: "nameEn", labelEn: "Name (English)", labelAr: "الاسم بالإنجليزية", required: true },
                { kind: "text", name: "nameAr", labelEn: "Name (Arabic)", labelAr: "الاسم بالعربية", required: true },
                {
                  kind: "number", name: "year", labelEn: "Year", labelAr: "السنة",
                  required: true, defaultValue: new Date().getFullYear(), min: "2020", max: "2100", ltr: true,
                },
              ]}
            />
          </Card>
        </div>
      )}
    </>
  );
}
