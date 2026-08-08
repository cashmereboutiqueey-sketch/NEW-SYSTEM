import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber, formatPercent } from "@/lib/money";
import { customerProfiles, duplicateCandidates } from "@/lib/crm";
import { dec } from "@/lib/money";

/**
 * العملاء — customer intelligence.
 *
 * Lifetime value here is gross profit already earned, not a forecast, and
 * segments come from stated thresholds rather than quintiles of the current
 * base — so a segment means the same thing next week as it does today.
 */
export default async function CustomersPage() {
  await requirePermission("customer:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const [profiles, duplicates] = await Promise.all([
    customerProfiles(),
    duplicateCandidates(),
  ]);

  const buyers = profiles.filter((p) => p.orders > 0);
  const revenue = buyers.reduce((s, p) => s.plus(dec(p.revenue)), dec(0));
  const value = buyers.reduce((s, p) => s.plus(dec(p.lifetimeValue)), dec(0));
  const repeat = buyers.filter((p) => p.orders > 1).length;
  const consented = profiles.filter((p) => p.marketingConsent && !p.isSuppressed).length;

  const segmentTone: Record<string, "good" | "info" | "warn" | "bad" | "neutral"> = {
    CHAMPION: "good", LOYAL: "good", PROMISING: "info", NEW: "info",
    AT_RISK: "warn", LOST: "bad", NEVER_PURCHASED: "neutral",
  };
  const segmentLabel: Record<string, string> = ar
    ? {
        CHAMPION: "بطل", LOYAL: "وفي", PROMISING: "واعد", NEW: "جديد",
        AT_RISK: "معرّض للفقد", LOST: "مفقود", NEVER_PURCHASED: "لم يشترِ",
      }
    : {
        CHAMPION: "Champion", LOYAL: "Loyal", PROMISING: "Promising", NEW: "New",
        AT_RISK: "At risk", LOST: "Lost", NEVER_PURCHASED: "Never purchased",
      };

  const bySegment = profiles.reduce<Record<string, number>>((acc, p) => {
    acc[p.segment] = (acc[p.segment] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <>
      <PageHeader
        title={t("customers", locale)}
        subtitle={
          ar
            ? "قيمة العميل = الربح المحقق فعلًا، مش توقّع"
            : "Customer value is gross profit actually earned, not a forecast"
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={ar ? "عملاء اشتروا" : "Customers who bought"}
          value={formatNumber(buyers.length, locale)}
          hint={`${formatNumber(profiles.length, locale)} ${ar ? "مسجل" : "on record"}`}
        />
        <StatTile
          label={ar ? "إيراد" : "Revenue"}
          value={formatMoney(revenue, locale)}
        />
        <StatTile
          label={ar ? "قيمة محققة" : "Value earned"}
          value={formatMoney(value, locale)}
          tone={value.greaterThan(0) ? "good" : "neutral"}
        />
        <StatTile
          label={ar ? "عملاء متكررون" : "Repeat customers"}
          value={formatNumber(repeat, locale)}
          hint={
            buyers.length > 0
              ? formatPercent(dec(repeat).div(buyers.length), locale)
              : undefined
          }
        />
      </div>

      {duplicates.length > 0 && (
        <Card
          className="mb-4"
          title={ar ? "سجلات متشابهة تحتاج مراجعة" : "Possible duplicates to review"}
          description={
            ar
              ? "النظام لا يدمج تلقائيًا — تليفون العائلة المشترك شائع، والدمج الخاطئ يفقد تاريخًا لا يُسترجع"
              : "Nothing is merged automatically — a shared family phone is common, and a wrong merge loses history that cannot be recovered"
          }
        >
          <DataTable
            headers={[
              ar ? "السبب" : "Reason",
              ar ? "القيمة" : "Value",
              ar ? "السجل الأول" : "First record",
              ar ? "السجل الثاني" : "Second record",
              "",
            ]}
            rows={duplicates.slice(0, 20).map((d, i) => [
              <Badge key={`${i}-r`} tone="warn">
                {d.reason === "PHONE" ? (ar ? "تليفون" : "Phone") : (ar ? "إيميل" : "Email")}
              </Badge>,
              <code key={`${i}-v`} dir="ltr" className="text-xs">{d.value}</code>,
              <span key={`${i}-a`}>
                {d.a.name}
                <code dir="ltr" className="ms-2 text-xs text-ink-400">{d.a.code}</code>
              </span>,
              <span key={`${i}-b`}>
                {d.b.name}
                <code dir="ltr" className="ms-2 text-xs text-ink-400">{d.b.code}</code>
              </span>,
              d.namesDiffer ? (
                <Badge key={`${i}-n`} tone="bad">
                  {ar ? "الأسماء مختلفة" : "Names differ"}
                </Badge>
              ) : (
                <span key={`${i}-n`} />
              ),
            ])}
          />
        </Card>
      )}

      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Card title={ar ? "الشرائح" : "Segments"}>
          <dl className="space-y-1.5 text-sm">
            {Object.entries(segmentLabel).map(([key, label]) => (
              <div key={key} className="flex items-center justify-between border-b border-ink-100 pb-1.5">
                <dt>
                  <Badge tone={segmentTone[key]}>{label}</Badge>
                </dt>
                <dd className="num text-ink-700">{formatNumber(bySegment[key] ?? 0, locale)}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card
          className="lg:col-span-2"
          title={ar ? "الموافقة على التسويق" : "Marketing consent"}
          description={
            ar
              ? "عدم الرد ليس موافقة، وإلغاء الاشتراك يتفوق على أي موافقة قديمة"
              : "Silence is not consent, and an unsubscribe outranks any earlier opt-in"
          }
        >
          <div className="flex flex-wrap gap-6 text-sm">
            <div>
              <div className="text-ink-500">{ar ? "يمكن مراسلتهم" : "Marketable"}</div>
              <div className="num text-lg font-semibold text-good">
                {formatNumber(consented, locale)}
              </div>
            </div>
            <div>
              <div className="text-ink-500">{ar ? "لم يوافقوا بعد" : "No decision recorded"}</div>
              <div className="num text-lg font-semibold text-ink-700">
                {formatNumber(
                  profiles.filter((p) => p.marketingConsent == null && !p.isSuppressed).length,
                  locale,
                )}
              </div>
            </div>
            <div>
              <div className="text-ink-500">{ar ? "موقوفون" : "Suppressed"}</div>
              <div className="num text-lg font-semibold text-bad">
                {formatNumber(profiles.filter((p) => p.isSuppressed).length, locale)}
              </div>
            </div>
          </div>
        </Card>
      </div>

      <Card title={ar ? "العملاء" : "Customers"}>
        {profiles.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-400">
            {ar ? "لا يوجد عملاء بعد." : "No customers yet."}
          </p>
        ) : (
          <DataTable
            headers={[
              ar ? "العميل" : "Customer",
              ar ? "الشريحة" : "Segment",
              ar ? "آخر شراء" : "Last order",
              ar ? "طلبات" : "Orders",
              ar ? "إيراد" : "Revenue",
              ar ? "متوسط الطلب" : "AOV",
              ar ? "قيمة محققة" : "Value earned",
              ar ? "مرتجعات" : "Returns",
            ]}
            rows={profiles.slice(0, 100).map((p) => [
              <span key={`${p.id}-n`}>
                {p.name}
                {p.phone && (
                  <code dir="ltr" className="ms-2 text-xs text-ink-400">{p.phone}</code>
                )}
              </span>,
              <Badge key={`${p.id}-s`} tone={segmentTone[p.segment]}>
                {segmentLabel[p.segment]}
              </Badge>,
              <span key={`${p.id}-l`} className="num" dir="ltr">
                {p.recencyDays == null
                  ? "—"
                  : `${formatNumber(p.recencyDays, locale)} ${ar ? "يوم" : "d"}`}
              </span>,
              <span key={`${p.id}-o`} className="num">{formatNumber(p.orders, locale)}</span>,
              <span key={`${p.id}-r`} className="num">{formatMoney(p.revenue, locale)}</span>,
              <span key={`${p.id}-a`} className="num">
                {p.averageOrderValue ? formatMoney(p.averageOrderValue, locale) : "—"}
              </span>,
              <span
                key={`${p.id}-v`}
                className={
                  dec(p.lifetimeValue).greaterThan(0)
                    ? "num font-medium text-good"
                    : dec(p.lifetimeValue).lessThan(0)
                      ? "num font-medium text-bad"
                      : "num"
                }
              >
                {formatMoney(p.lifetimeValue, locale)}
              </span>,
              <span key={`${p.id}-rr`} className="num">
                {p.returnRate ? formatPercent(p.returnRate, locale) : "—"}
              </span>,
            ])}
          />
        )}
      </Card>
    </>
  );
}
