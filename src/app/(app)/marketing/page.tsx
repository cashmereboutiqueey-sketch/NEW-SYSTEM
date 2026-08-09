import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { can } from "@/core/permissions";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { EntityForm } from "@/components/entity-form";
import { formatMoney, formatNumber, formatPercent } from "@/lib/money";
import { campaignResults } from "@/lib/marketing";
import { dec } from "@/lib/money";
import { createCampaignAction, recordSpendAction } from "./actions";
import { MetaImportForm } from "./import-form";

/**
 * التسويق — campaigns.
 *
 * The headline is contribution after marketing, not return on ad spend. A
 * campaign can post a ROAS of four and still lose money if the garments it
 * sold were discounted to move, so both figures are shown side by side and
 * the one that pays wages is the one in the total.
 */
export default async function MarketingPage() {
  const session = await requirePermission("campaign:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const mayManage = can(session.role, "campaign:manage");

  const [results, collections, styles] = await Promise.all([
    campaignResults(),
    db.collection.findMany({ where: { isActive: true }, orderBy: { code: "asc" } }),
    db.style.findMany({ where: { isActive: true }, orderBy: { code: "asc" } }),
  ]);

  const name = (e: { nameAr: string; nameEn: string }) => (ar ? e.nameAr : e.nameEn);
  const today = new Date().toISOString().slice(0, 10);

  const totalSpend = results.reduce((s, r) => s.plus(r.spend), dec(0));
  const totalRevenue = results.reduce((s, r) => s.plus(r.revenue), dec(0));
  const totalContribution = results.reduce((s, r) => s.plus(r.contribution), dec(0));
  const losing = results.filter((r) => r.spend.greaterThan(0) && !r.profitable);

  const platformLabel: Record<string, string> = ar
    ? {
        META: "ميتا", GOOGLE: "جوجل", TIKTOK: "تيك توك",
        INFLUENCER: "مؤثر", EMAIL: "إيميل", WHATSAPP: "واتساب", OTHER: "أخرى",
      }
    : {
        META: "Meta", GOOGLE: "Google", TIKTOK: "TikTok",
        INFLUENCER: "Influencer", EMAIL: "Email", WHATSAPP: "WhatsApp", OTHER: "Other",
      };

  return (
    <>
      <PageHeader
        title={ar ? "التسويق" : "Marketing"}
        subtitle={
          ar
            ? "الربح بعد التسويق هو الرقم — العائد على الإنفاق ممكن يبان حلو وإنت خسران"
            : "Contribution after marketing is the number — a healthy ROAS can sit on top of a loss"
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <StatTile
          label={ar ? "إنفاق إعلاني" : "Ad spend"}
          value={formatMoney(totalSpend, locale)}
          hint={`${results.length} ${ar ? "حملة" : "campaigns"}`}
        />
        <StatTile
          label={ar ? "إيراد منسوب" : "Attributed revenue"}
          value={formatMoney(totalRevenue, locale)}
        />
        <StatTile
          label={ar ? "الربح بعد التسويق" : "Contribution after marketing"}
          value={formatMoney(totalContribution, locale)}
          tone={totalContribution.greaterThan(0) ? "good" : "bad"}
        />
        <StatTile
          label={ar ? "حملات خاسرة" : "Campaigns losing money"}
          value={formatNumber(losing.length, locale)}
          tone={losing.length > 0 ? "bad" : "good"}
        />
      </div>

      <Card
        className="mb-4"
        title={ar ? "أداء الحملات" : "Campaign performance"}
        description={
          ar
            ? "العائد على الإنفاق مقابل العائد على الهامش — التاني هو اللي بيدفع المرتبات"
            : "Return on spend against return on margin — only the second one pays wages"
        }
      >
        {results.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-400">
            {ar ? "لا توجد حملات بعد." : "No campaigns yet."}
          </p>
        ) : (
          <DataTable
            headers={[
              ar ? "الحملة" : "Campaign",
              ar ? "المنصة" : "Platform",
              ar ? "الإنفاق" : "Spend",
              ar ? "الإيراد" : "Revenue",
              ar ? "مجمل الربح" : "Gross margin",
              "ROAS",
              ar ? "على الهامش" : "On margin",
              ar ? "بعد التسويق" : "Contribution",
              ar ? "طلبات" : "Orders",
            ]}
            rows={results.map((r) => [
              <span key={`${r.id}-n`}>
                <code dir="ltr" className="text-xs text-ink-500">{r.code}</code>
                <span className="ms-2">{ar ? r.nameAr : r.nameEn}</span>
                {(r.scopeEn || r.creatorName) && (
                  <span className="mt-0.5 block text-xs text-ink-400">
                    {ar ? r.scopeAr ?? r.scopeEn : r.scopeEn}
                    {r.creatorName ? ` · ${r.creatorName}` : ""}
                  </span>
                )}
              </span>,
              <Badge key={`${r.id}-p`} tone="neutral">{platformLabel[r.platform]}</Badge>,
              <span key={`${r.id}-s`} className="num">{formatMoney(r.spend, locale)}</span>,
              <span key={`${r.id}-r`} className="num">{formatMoney(r.revenue, locale)}</span>,
              <span key={`${r.id}-g`} className="num">{formatMoney(r.grossMargin, locale)}</span>,
              <span key={`${r.id}-ro`} className="num text-ink-500">
                {r.roas ? `${r.roas.toFixed(2)}×` : "—"}
              </span>,
              <span
                key={`${r.id}-cr`}
                className={
                  r.contributionRoas && r.contributionRoas.lessThan(1)
                    ? "num text-bad"
                    : "num text-good"
                }
              >
                {r.contributionRoas ? `${r.contributionRoas.toFixed(2)}×` : "—"}
              </span>,
              <span
                key={`${r.id}-c`}
                className={r.profitable ? "num font-semibold text-good" : "num font-semibold text-bad"}
              >
                {formatMoney(r.contribution, locale)}
              </span>,
              <span key={`${r.id}-o`} className="num">
                {formatNumber(r.orders, locale)}
                {r.reportedConversions > 0 && r.reportedConversions !== r.orders && (
                  <span className="mt-0.5 block text-xs text-ink-400">
                    {ar ? "المنصة تقول" : "platform says"} {r.reportedConversions}
                  </span>
                )}
              </span>,
            ])}
          />
        )}

        {results.some((r) => r.reportedConversions > 0 && r.reportedConversions !== r.orders) && (
          <p className="mt-3 text-xs text-ink-500">
            {ar
              ? "لما رقم المنصة يختلف عن طلباتنا، الرقم بتاعنا هو المعتمد — المنصة بتصحّح لنفسها."
              : "Where the platform's count differs from ours, ours is the one used — the platform is marking its own homework."}
          </p>
        )}
      </Card>

      {mayManage && (
        <>
          <div className="mb-4 grid gap-4 lg:grid-cols-2">
            <Card
              title={ar ? "استيراد إنفاق من Meta" : "Import spend from Meta"}
              description={
                ar
                  ? "من تصدير Ads Manager — شغّال دلوقتي من غير انتظار موافقة API"
                  : "From an Ads Manager export — works today, with no API approval to wait for"
              }
            >
              <MetaImportForm locale={locale} />
            </Card>

            <Card
              title={ar ? "تسجيل إنفاق يدوي" : "Record spend by hand"}
              description={
                ar
                  ? "بيتسجّل كمصروف على البراند كمان، فالحملة بتطابق الدفاتر"
                  : "Also booked as a Brand expense, so the campaign reconciles to the books"
              }
            >
              {results.length === 0 ? (
                <p className="py-4 text-sm text-ink-500">
                  {ar ? "أنشئ حملة أولًا." : "Create a campaign first."}
                </p>
              ) : (
                <EntityForm
                  locale={locale}
                  action={recordSpendAction}
                  columns={2}
                  submitEn="Record spend"
                  submitAr="سجّل الإنفاق"
                  fields={[
                    {
                      kind: "select", name: "campaignId", labelEn: "Campaign", labelAr: "الحملة",
                      required: true, span: 2,
                      options: results.map((r) => ({
                        value: r.id, label: `${r.code} — ${ar ? r.nameAr : r.nameEn}`,
                      })),
                    },
                    {
                      kind: "date", name: "spendDate", labelEn: "Day", labelAr: "اليوم",
                      required: true, defaultValue: today, ltr: true,
                      hintEn: "The same day twice replaces rather than adds.",
                      hintAr: "نفس اليوم مرتين بيستبدل مش بيجمع.",
                    },
                    {
                      kind: "number", name: "amount", labelEn: "Amount spent", labelAr: "المبلغ",
                      required: true, step: "0.01", min: "0", ltr: true,
                    },
                    { kind: "number", name: "impressions", labelEn: "Impressions", labelAr: "مرات الظهور", defaultValue: 0, min: "0", ltr: true },
                    { kind: "number", name: "clicks", labelEn: "Clicks", labelAr: "النقرات", defaultValue: 0, min: "0", ltr: true },
                  ]}
                />
              )}
            </Card>
          </div>

          <Card title={ar ? "حملة جديدة" : "New campaign"}>
            <EntityForm
              locale={locale}
              action={createCampaignAction}
              submitEn="Create campaign"
              submitAr="أنشئ الحملة"
              fields={[
                {
                  kind: "text", name: "code", labelEn: "Code", labelAr: "الكود",
                  required: true, ltr: true, placeholder: "AW26-LAUNCH",
                },
                {
                  kind: "text", name: "nameEn", labelEn: "Name in Meta", labelAr: "الاسم في Meta",
                  required: true,
                  hintEn: "Match the campaign's name in Ads Manager exactly, so imports find it.",
                  hintAr: "لازم يطابق اسم الحملة في Ads Manager بالظبط عشان الاستيراد يلاقيها.",
                },
                { kind: "text", name: "nameAr", labelEn: "Name (Arabic)", labelAr: "الاسم بالعربية", required: true },
                {
                  kind: "select", name: "platform", labelEn: "Platform", labelAr: "المنصة", required: true,
                  options: Object.entries(platformLabel).map(([value, label]) => ({ value, label })),
                },
                {
                  kind: "select", name: "collectionId", labelEn: "Collection", labelAr: "التشكيلة",
                  options: collections.map((c) => ({ value: c.id, label: name(c) })),
                  emptyLabel: ar ? "— كل البراند —" : "— whole brand —",
                },
                {
                  kind: "select", name: "styleId", labelEn: "Single style", labelAr: "موديل واحد",
                  options: styles.map((s) => ({ value: s.id, label: `${s.code} — ${name(s)}` })),
                  emptyLabel: ar ? "— غير محدد —" : "— not style-specific —",
                },
                { kind: "date", name: "startDate", labelEn: "Starts", labelAr: "تبدأ", required: true, defaultValue: today, ltr: true },
                { kind: "date", name: "endDate", labelEn: "Ends", labelAr: "تنتهي", ltr: true },
                { kind: "number", name: "budget", labelEn: "Budget", labelAr: "الميزانية", defaultValue: 0, step: "0.01", min: "0", ltr: true },
                {
                  kind: "text", name: "couponCode", labelEn: "Coupon code", labelAr: "كود الخصم", ltr: true,
                  hintEn: "Ties an order back to this campaign. One code, one campaign.",
                  hintAr: "بيربط الطلب بالحملة دي. كود واحد لحملة واحدة.",
                },
                { kind: "text", name: "creatorName", labelEn: "Creator or agency", labelAr: "المؤثر أو الوكالة" },
                {
                  kind: "number", name: "creatorFee", labelEn: "Creator fee", labelAr: "أجر المؤثر",
                  defaultValue: 0, step: "0.01", min: "0", ltr: true,
                  hintEn: "Counted as part of the campaign's cost, not separately.",
                  hintAr: "بيتحسب ضمن تكلفة الحملة مش لوحده.",
                },
                { kind: "text", name: "objective", labelEn: "Objective", labelAr: "الهدف", span: 2 },
              ]}
            />
          </Card>
        </>
      )}
    </>
  );
}
