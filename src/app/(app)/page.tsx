import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { t } from "@/lib/i18n";
import { formatNumber } from "@/lib/money";
import { PageHeader, Card, StatTile, DataTable, Badge } from "@/components/ui";
import { navigation, isShipped } from "@/lib/navigation";

/**
 * Phase 1 dashboard.
 *
 * Deliberately does NOT display computed costing figures. The costing engine
 * arrives in Phase 2, and showing a placeholder number as though it were real
 * is exactly the failure mode this system exists to eliminate. What it shows
 * instead is the foundation itself: what data exists, and where the rest will
 * land.
 */
export default async function DashboardPage() {
  const { locale, scope } = await getPrefs();

  const [
    entities,
    periods,
    costCategories,
    suppliers,
    materials,
    collections,
    styles,
    variants,
    lines,
    operators,
    channels,
    settings,
    alertRules,
  ] = await Promise.all([
    db.entity.findMany({ orderBy: { kind: "asc" } }),
    db.fiscalPeriod.count(),
    db.costCategory.count(),
    db.supplier.count(),
    db.material.count(),
    db.collection.count(),
    db.style.count(),
    db.variant.count(),
    db.productionLine.count(),
    db.operator.count(),
    db.salesChannel.count(),
    db.setting.count(),
    db.alertRule.count(),
  ]);

  const scopeLabel =
    scope === "FACTORY"
      ? t("factory", locale)
      : scope === "BRAND"
        ? t("brand", locale)
        : t("group", locale);

  const upcoming = navigation
    .flatMap((s) => s.items)
    .filter((i) => !isShipped(i))
    .reduce<Record<number, string[]>>((acc, item) => {
      (acc[item.phase] ??= []).push(t(item.key, locale));
      return acc;
    }, {});

  return (
    <>
      <PageHeader
        title={`${t("dashboard", locale)} — ${scopeLabel}`}
        subtitle={
          locale === "ar"
            ? "المرحلة الأولى: الأساس. قاعدة البيانات والصلاحيات والواجهة جاهزة — محرك التكاليف يأتي في المرحلة الثانية."
            : "Phase 1: foundation. Schema, auth and shell are live — the costing engine arrives in Phase 2."
        }
        actions={<Badge tone="info">Phase 1</Badge>}
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label={locale === "ar" ? "الأصناف (SKU)" : "Variants (SKU)"}
          value={formatNumber(variants, locale)}
          hint={locale === "ar" ? "لون × مقاس" : "colour × size"}
        />
        <StatTile
          label={t("materials", locale)}
          value={formatNumber(materials, locale)}
          hint={locale === "ar" ? "قماش وإكسسوارات" : "fabric and trims"}
        />
        <StatTile
          label={t("minuteRate", locale)}
          value="—"
          pending
          hint={locale === "ar" ? "المرحلة 2" : "Phase 2"}
        />
        <StatTile
          label={t("idleCapacity", locale)}
          value="—"
          pending
          hint={locale === "ar" ? "المرحلة 2" : "Phase 2"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title={locale === "ar" ? "الكيانات" : "Entities"}
          description={
            locale === "ar"
              ? "دفتران منفصلان يتعاملان بسعر تحويل عادل"
              : "Two separate books transacting at an arm's-length transfer price"
          }
        >
          <DataTable
            headers={[
              locale === "ar" ? "الكيان" : "Entity",
              locale === "ar" ? "النوع" : "Kind",
              locale === "ar" ? "العملة" : "Currency",
            ]}
            rows={entities.map((e) => [
              locale === "ar" ? e.nameAr : e.nameEn,
              <Badge key={e.id} tone={e.kind === "FACTORY" ? "info" : "good"}>
                {e.kind}
              </Badge>,
              <span key={`${e.id}-c`} className="num">
                {e.baseCurrency}
              </span>,
            ])}
          />
        </Card>

        <Card
          title={locale === "ar" ? "بيانات الأساس" : "Foundation data"}
          description={
            locale === "ar"
              ? "ما تم تحميله من بيانات مرجعية وتجريبية"
              : "Reference and seed data currently loaded"
          }
        >
          <DataTable
            headers={[
              locale === "ar" ? "الجدول" : "Table",
              locale === "ar" ? "العدد" : "Count",
            ]}
            rows={[
              [locale === "ar" ? "الفترات المالية" : "Fiscal periods", periods],
              [locale === "ar" ? "بنود التكلفة" : "Cost categories", costCategories],
              [t("suppliers", locale), suppliers],
              [locale === "ar" ? "الكوليكشنز" : "Collections", collections],
              [locale === "ar" ? "الموديلات" : "Styles", styles],
              [t("productionLine", locale), lines],
              [locale === "ar" ? "العمال" : "Operators", operators],
              [locale === "ar" ? "قنوات البيع" : "Sales channels", channels],
              [t("settings", locale), settings],
              [locale === "ar" ? "قواعد التنبيهات" : "Alert rules", alertRules],
            ].map(([label, count]) => [
              label as string,
              <span key={String(label)} className="num font-medium">
                {formatNumber(count as number, locale)}
              </span>,
            ])}
          />
        </Card>
      </div>

      <Card
        className="mt-4"
        title={locale === "ar" ? "خارطة الطريق" : "Roadmap"}
        description={
          locale === "ar"
            ? "الجداول موجودة بالفعل في قاعدة البيانات — الشاشات تُبنى مرحلة بمرحلة"
            : "The tables already exist in the database — screens are built phase by phase"
        }
      >
        <div className="space-y-3">
          {Object.entries(upcoming).map(([phase, items]) => (
            <div key={phase} className="flex gap-3">
              <Badge tone="neutral">Phase {phase}</Badge>
              <p className="text-sm text-ink-600">{items.join(" · ")}</p>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
