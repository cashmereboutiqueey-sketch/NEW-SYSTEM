import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { t } from "@/lib/i18n";
import { PageHeader, Card, DataTable, Badge } from "@/components/ui";

/**
 * Every configurable number in the system, in one place.
 *
 * Rule 3 of the specification: no hardcoded rates or magic numbers anywhere.
 * If a figure influences a calculation, it is a row in this table — visible,
 * auditable, and changeable without a deploy. Editing arrives with Phase 2,
 * when there is a costing engine for these values to drive.
 */
export default async function SettingsPage() {
  const { locale } = await getPrefs();

  const settings = await db.setting.findMany({
    orderBy: [{ group: "asc" }, { key: "asc" }],
  });

  const groups = settings.reduce<Record<string, typeof settings>>((acc, s) => {
    (acc[s.group] ??= []).push(s);
    return acc;
  }, {});

  function displayValue(value: string, type: string): string {
    if (type === "PERCENT") {
      const n = Number(value);
      return Number.isFinite(n) ? `${(n * 100).toFixed(2)}%` : value;
    }
    return value;
  }

  return (
    <>
      <PageHeader
        title={t("settings", locale)}
        subtitle={
          locale === "ar"
            ? "كل رقم قابل للتعديل في النظام — لا توجد أرقام ثابتة داخل الكود"
            : "Every configurable number in the system — nothing is hardcoded in application code"
        }
        actions={<Badge tone="neutral">{settings.length}</Badge>}
      />

      <div className="space-y-4">
        {Object.entries(groups).map(([group, rows]) => (
          <Card key={group} title={group}>
            <DataTable
              headers={[
                locale === "ar" ? "المفتاح" : "Key",
                locale === "ar" ? "الوصف" : "Label",
                locale === "ar" ? "القيمة" : "Value",
                locale === "ar" ? "النوع" : "Type",
              ]}
              rows={rows.map((s) => [
                <code
                  key={`${s.id}-k`}
                  dir="ltr"
                  className="rounded bg-ink-100 px-1.5 py-0.5 text-xs text-ink-700"
                >
                  {s.key}
                </code>,
                <span key={`${s.id}-l`}>
                  {locale === "ar" ? s.labelAr : s.labelEn}
                  {(locale === "ar" ? s.descriptionAr : s.descriptionEn) && (
                    <span className="mt-0.5 block text-xs text-ink-400">
                      {locale === "ar" ? s.descriptionAr : s.descriptionEn}
                    </span>
                  )}
                </span>,
                <span key={`${s.id}-v`} className="num font-medium text-ink-900">
                  {displayValue(s.value, s.type)}
                </span>,
                <Badge key={`${s.id}-t`} tone="neutral">
                  {s.type}
                </Badge>,
              ])}
            />
          </Card>
        ))}
      </div>
    </>
  );
}
