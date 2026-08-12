import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { can } from "@/core/permissions";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { EntityForm } from "@/components/entity-form";
import { AddInline } from "@/components/add-inline";
import { addUnitAction } from "../master-data-actions";
import { formatMoney, formatNumber, formatPercent } from "@/lib/money";
import { dec } from "@/lib/money";
import { createMaterialAction, toggleMaterialAction } from "./actions";

/**
 * الخامات — materials.
 *
 * The price shown is the landed cost: purchase price plus freight and duty,
 * because that is what the metre actually costs to have on the cutting table.
 * Costing uses this figure, so entering the invoice price alone understates
 * every garment.
 */
export default async function MaterialsPage() {
  const session = await requirePermission("inventory:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const mayEdit = can(session.role, "purchase_order:create");

  const [materials, suppliers, uoms] = await Promise.all([
    db.material.findMany({
      include: {
        supplier: true,
        uom: true,
        _count: { select: { bomLines: true, inventoryLots: true } },
      },
      orderBy: [{ isActive: "desc" }, { type: "asc" }, { code: "asc" }],
    }),
    db.supplier.findMany({ where: { isActive: true }, orderBy: { nameEn: "asc" } }),
    db.unitOfMeasure.findMany({ orderBy: { code: "asc" } }),
  ]);

  const name = (e: { nameAr: string; nameEn: string }) => (ar ? e.nameAr : e.nameEn);
  const landed = (m: (typeof materials)[number]) =>
    dec(m.basePrice).times(dec(m.freightPct).plus(dec(m.dutyPct)).plus(1));

  const active = materials.filter((m) => m.isActive);
  const fabrics = active.filter((m) => m.type === "FABRIC");

  const typeLabel: Record<string, string> = ar
    ? { FABRIC: "قماش", TRIM: "إكسسوار", PACKAGING: "تغليف", CONSUMABLE: "مستهلك" }
    : { FABRIC: "Fabric", TRIM: "Trim", PACKAGING: "Packaging", CONSUMABLE: "Consumable" };

  return (
    <>
      <PageHeader
        title={t("materials", locale)}
        subtitle={
          ar
            ? "السعر المعروض هو التكلفة النهائية شاملة الشحن والجمارك — ده اللي التسعير بيستخدمه"
            : "The price shown is the landed cost including freight and duty — that is what costing uses"
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatTile
          label={ar ? "خامات نشطة" : "Active materials"}
          value={formatNumber(active.length, locale)}
          hint={`${materials.length} ${ar ? "إجمالي" : "on record"}`}
        />
        <StatTile
          label={ar ? "أقمشة" : "Fabrics"}
          value={formatNumber(fabrics.length, locale)}
        />
        <StatTile
          label={ar ? "مستخدمة في مكونات" : "Used in a BOM"}
          value={formatNumber(
            materials.filter((m) => m._count.bomLines > 0).length,
            locale,
          )}
        />
      </div>

      {mayEdit && (
        <Card className="mb-4" title={ar ? "إضافة خامة" : "Add a material"}>
          {can(session.role, "settings:manage") && (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-xs text-ink-500">
                {ar ? "الوحدة مش في القايمة؟" : "Unit not listed?"}
              </span>
              <AddInline
                ar={ar}
                title={ar ? "وحدة قياس جديدة" : "New unit"}
                action={addUnitAction}
                label={ar ? "+ وحدة" : "+ Unit"}
                fields={[
                  {
                    name: "code", label: ar ? "الرمز" : "Code", required: true, half: true,
                    placeholder: "m", 
                    hint: ar ? "زي ما بيتكتب على الفاتورة" : "As it is printed on documents",
                  },
                  { name: "nameAr", label: ar ? "الاسم" : "Name", required: true, half: true },
                  {
                    name: "kind", label: ar ? "بيقيس إيه" : "Measures", type: "select",
                    options: [
                      { value: "LENGTH", label: ar ? "طول" : "Length" },
                      { value: "MASS", label: ar ? "وزن" : "Mass" },
                      { value: "PIECE", label: ar ? "عدد" : "Count" },
                      { value: "AREA", label: ar ? "مساحة" : "Area" },
                    ],
                  },
                ]}
              />
            </div>
          )}

          <EntityForm
            locale={locale}
            action={createMaterialAction}
            submitEn="Add material"
            submitAr="أضف الخامة"
            fields={[
              {
                kind: "text", name: "code", labelEn: "Code", labelAr: "الكود",
                required: true, placeholder: "FAB-JER-180", ltr: true,
                hintEn: "Cannot be changed once the material is used in a BOM.",
                hintAr: "مايتغيّرش بعد استخدام الخامة في مكونات موديل.",
              },
              { kind: "text", name: "nameEn", labelEn: "Name (English)", labelAr: "الاسم بالإنجليزية", required: true },
              { kind: "text", name: "nameAr", labelEn: "Name (Arabic)", labelAr: "الاسم بالعربية", required: true },
              {
                kind: "select", name: "type", labelEn: "Type", labelAr: "النوع", required: true,
                options: Object.entries(typeLabel).map(([value, l]) => ({ value, label: l })),
              },
              {
                kind: "select", name: "uomId", labelEn: "Unit", labelAr: "الوحدة", required: true,
                options: uoms.map((u) => ({ value: u.id, label: `${name(u)} (${u.code})` })),
              },
              {
                kind: "select", name: "supplierId", labelEn: "Supplier", labelAr: "المورد",
                options: suppliers.map((s) => ({ value: s.id, label: name(s) })),
                emptyLabel: ar ? "— بدون —" : "— none —",
              },
              {
                kind: "number", name: "basePrice", labelEn: "Purchase price", labelAr: "سعر الشراء",
                required: true, step: "0.01", min: "0", ltr: true,
                hintEn: "Ex-VAT, before freight and duty.",
                hintAr: "بدون ضريبة، وقبل الشحن والجمارك.",
              },
              {
                kind: "number", name: "freightPct", labelEn: "Freight %", labelAr: "الشحن %",
                defaultValue: 0, step: "0.1", min: "0", max: "100", ltr: true,
                hintEn: "Enter 2.5 for two and a half per cent.",
                hintAr: "اكتب ٢.٥ يعني اتنين ونص بالمية.",
              },
              {
                kind: "number", name: "dutyPct", labelEn: "Duty %", labelAr: "الجمارك %",
                defaultValue: 0, step: "0.1", min: "0", max: "100", ltr: true,
              },
              {
                kind: "number", name: "moq", labelEn: "Minimum order", labelAr: "أقل كمية طلب",
                step: "0.01", min: "0", ltr: true,
                hintEn: "Warns when a run needs less than the smallest purchasable quantity.",
                hintAr: "بينبّه لو أمر الإنتاج محتاج أقل من الحد الأدنى للشراء.",
              },
              { kind: "number", name: "packSize", labelEn: "Roll or pack size", labelAr: "حجم الرول أو العبوة", step: "0.01", min: "0", ltr: true },
              { kind: "number", name: "leadTimeDays", labelEn: "Lead time (days)", labelAr: "مدة التوريد (يوم)", defaultValue: 0, min: "0", ltr: true },
              {
                kind: "number", name: "reorderPoint", labelEn: "Reorder point", labelAr: "حد إعادة الطلب",
                step: "0.01", min: "0", ltr: true,
                hintEn: "Stock below this raises a low-stock alert.",
                hintAr: "لو المخزون قلّ عن كده بينبّه.",
              },
              { kind: "text", name: "composition", labelEn: "Composition", labelAr: "التركيب", placeholder: "100% Cotton" },
              { kind: "number", name: "gsm", labelEn: "GSM", labelAr: "الجرامات", step: "0.01", min: "0", ltr: true },
              { kind: "number", name: "widthCm", labelEn: "Width (cm)", labelAr: "العرض (سم)", step: "0.01", min: "0", ltr: true },
            ]}
          />
        </Card>
      )}

      <Card title={ar ? "الخامات" : "Materials"}>
        {materials.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-400">
            {ar ? "لا توجد خامات بعد." : "No materials yet."}
          </p>
        ) : (
          <DataTable
            headers={[
              ar ? "الكود" : "Code",
              ar ? "الخامة" : "Material",
              ar ? "النوع" : "Type",
              ar ? "المورد" : "Supplier",
              ar ? "سعر الشراء" : "Purchase",
              ar ? "شحن + جمارك" : "Freight + duty",
              ar ? "التكلفة النهائية" : "Landed cost",
              ar ? "الحالة" : "Status",
              ...(mayEdit ? [""] : []),
            ]}
            rows={materials.map((m) => [
              <code key={`${m.id}-c`} dir="ltr" className="text-xs text-ink-500">{m.code}</code>,
              <span key={`${m.id}-n`}>
                {name(m)}
                <span className="mt-0.5 block text-xs text-ink-400">
                  {m.composition ?? ""} {m.gsm ? `· ${m.gsm} gsm` : ""}
                </span>
              </span>,
              <Badge key={`${m.id}-t`} tone={m.type === "FABRIC" ? "info" : "neutral"}>
                {typeLabel[m.type]}
              </Badge>,
              <span key={`${m.id}-s`}>{m.supplier ? name(m.supplier) : "—"}</span>,
              <span key={`${m.id}-p`} className="num">
                {formatMoney(m.basePrice, locale)}/{m.uom.code}
              </span>,
              <span key={`${m.id}-f`} className="num text-ink-500">
                {formatPercent(dec(m.freightPct).plus(dec(m.dutyPct)), locale)}
              </span>,
              <span key={`${m.id}-l`} className="num font-medium">
                {formatMoney(landed(m), locale)}
              </span>,
              <Badge key={`${m.id}-st`} tone={m.isActive ? "good" : "neutral"}>
                {m.isActive ? (ar ? "نشط" : "Active") : (ar ? "موقوف" : "Inactive")}
              </Badge>,
              ...(mayEdit
                ? [
                    <form key={`${m.id}-a`} action={toggleMaterialAction}>
                      <input type="hidden" name="id" value={m.id} />
                      <input type="hidden" name="isActive" value={String(!m.isActive)} />
                      <button
                        type="submit"
                        className="rounded-lg border border-ink-200 px-2 py-1 text-xs text-ink-600 hover:border-ink-400"
                      >
                        {m.isActive ? (ar ? "إيقاف" : "Deactivate") : (ar ? "تفعيل" : "Reactivate")}
                      </button>
                    </form>,
                  ]
                : []),
            ])}
          />
        )}
        {mayEdit && (
          <p className="mt-3 text-xs text-ink-500">
            {ar
              ? "تغيير السعر بيتسجّل في تاريخ الأسعار — لقطات التكلفة القديمة بتفضل على سعرها."
              : "A price change is written to price history — existing cost snapshots keep the price they were built on."}
          </p>
        )}
      </Card>
    </>
  );
}
