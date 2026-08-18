import Link from "next/link";
import { getPrefs } from "@/lib/session";
import { requireUser } from "@/lib/auth";
import { can, type Permission } from "@/core/permissions";
import { reportHeadlines } from "@/lib/report-index";
import { PageHeader, Card, StatTile } from "@/components/ui";
import { formatMoney, formatNumber, formatPercent } from "@/lib/money";

/**
 * التقارير — every report in the system, in one place.
 *
 * The reports were spread across eighteen screens, each sensibly placed next
 * to the thing it describes: sell-through beside sales, dead stock beside
 * inventory. That is right for somebody already working on sales. It is no use
 * to somebody who wants to know how the business is doing and does not yet
 * know which screen answers that.
 *
 * So this is arranged by the question rather than by the part of the system,
 * and it carries the answer rather than only the link. A page listing eighteen
 * reports is a menu; a page answering eighteen questions in a line each is
 * worth opening in the morning.
 *
 * Anything a person cannot open is not shown. A link to a redirect teaches
 * them the index lies.
 */

type Entry = {
  href: string;
  ar: string;
  en: string;
  /** The question it answers, in the words somebody would use to ask it. */
  askAr: string;
  askEn: string;
  needs?: Permission;
};

type Section = { ar: string; en: string; entries: Entry[] };

const SECTIONS: Section[] = [
  {
    ar: "الربح والخسارة",
    en: "Am I making money",
    entries: [
      {
        href: "/reports/entity-pnl?entity=FACTORY",
        ar: "قائمة دخل المصنع", en: "Factory P&L",
        askAr: "المصنع كسب ولا خسر، وفين راحت الفلوس",
        askEn: "Did the factory make anything, and where did it go",
        needs: "report:factory",
      },
      {
        href: "/reports/entity-pnl?entity=BRAND",
        ar: "قائمة دخل البراند", en: "Brand P&L",
        askAr: "المحل كسب ولا خسر",
        askEn: "Did the shop make anything",
        needs: "report:brand",
      },
      {
        href: "/reports/group-pnl",
        ar: "قائمة دخل المجموعة", en: "Group P&L",
        askAr: "الاتنين مع بعض بعد استبعاد البيع الداخلي",
        askEn: "The two together, with the internal selling taken out",
        needs: "report:group",
      },
      {
        href: "/reports/break-even",
        ar: "نقطة التعادل", en: "Break-even",
        askAr: "لازم أبيع كام قطعة عشان أغطي مصاريفي",
        askEn: "How many pieces cover the running costs",
        needs: "journal:view",
      },
      {
        href: "/pricing",
        ar: "تسعير البراند", en: "Brand pricing",
        askAr: "السعر ده بيكسب فعلًا بعد الإيجار والمرتبات؟",
        askEn: "Does this price actually earn anything after rent and salaries",
        needs: "retail_price:manage",
      },
      {
        href: "/costing",
        ar: "تسعير المصنع", en: "Factory costing",
        askAr: "القطعة بتكلف كام، وببيعها للبراند بكام",
        askEn: "What a garment costs to make, and what the Brand is charged",
        needs: "transfer_price:view",
      },
    ],
  },
  {
    ar: "الفلوس فين",
    en: "Where the money is",
    entries: [
      {
        href: "/cash-flow",
        ar: "توقعات التدفق النقدي", en: "Cash forecast",
        askAr: "هيبقى معايا كام الأسبوع الجاي، وهل هينقص",
        askEn: "What will be in the account next week, and does it run out",
        needs: "journal:view",
      },
      {
        href: "/reports/cash-cycle",
        ar: "دورة الكاش", en: "Cash cycle",
        askAr: "فلوسي بتقعد قد إيه محبوسة قبل ما ترجع",
        askEn: "How long the money stays tied up before it comes back",
        needs: "journal:view",
      },
      {
        href: "/receivables",
        ar: "ذمم العملاء", en: "Customer credit",
        askAr: "مين عليه فلوس ليا، وبقاله قد إيه",
        askEn: "Who owes me, and for how long",
        needs: "sales_order:view",
      },
      {
        href: "/suppliers/statements",
        ar: "كشف حساب الموردين", en: "Supplier statements",
        askAr: "أنا عليا كام لكل مورد",
        askEn: "What I owe each supplier",
        needs: "expense:view",
      },
      {
        href: "/expenses/aging",
        ar: "أعمار الذمم الدائنة", en: "Payables aging",
        askAr: "الفواتير اللي فات ميعادها",
        askEn: "Which bills are past their date",
        needs: "expense:view",
      },
      {
        href: "/reconciliation",
        ar: "التسويات", en: "Reconciliation",
        askAr: "كشف البنك بيطابق دفاتري؟",
        askEn: "Does the bank statement agree with the books",
        needs: "journal:view",
      },
    ],
  },
  {
    ar: "البضاعة",
    en: "The stock",
    entries: [
      {
        href: "/inventory",
        ar: "المخزون", en: "Inventory",
        askAr: "عندي إيه، وفين",
        askEn: "What I have, and where",
        needs: "inventory:view",
      },
      {
        href: "/materials/ledger",
        ar: "كشف الخامات", en: "Material ledger",
        askAr: "كل قماش: اشتريت كام، سحبت كام، فاضل كام",
        askEn: "For each cloth: bought, drawn, and left",
        needs: "inventory:view",
      },
      {
        href: "/inventory/dead-stock",
        ar: "المخزون الراكد", en: "Dead stock",
        askAr: "فلوسي واقفة في إيه من زمان",
        askEn: "What has the cash been sitting in",
        needs: "inventory:view",
      },
      {
        href: "/reports/gmroi",
        ar: "العائد على المخزون", en: "GMROI",
        askAr: "كل جنيه في البضاعة بيرجع كام",
        askEn: "What each pound in stock earns back",
        needs: "inventory:view",
      },
    ],
  },
  {
    ar: "البيع",
    en: "The selling",
    entries: [
      {
        href: "/collections",
        ar: "أداء التشكيلة", en: "Collection performance",
        askAr: "التشكيلة عملت إيه، وأحسن موديل فيها إيه",
        askEn: "How a collection did, and which product carried it",
        needs: "production:view",
      },
      {
        href: "/sales/sell-through",
        ar: "معدل التصريف", en: "Sell-through",
        askAr: "اتصرف كام من اللي اتعمل",
        askEn: "How much of what was made has sold",
        needs: "sales_order:view",
      },
      {
        href: "/sales/markdown",
        ar: "تحليل الخصومات", en: "Markdown analysis",
        askAr: "الخصم كلفني كام من الربح",
        askEn: "What the discounting cost in profit",
        needs: "sales_order:view",
      },
      {
        href: "/customers",
        ar: "ربحية العميل", en: "Customer profitability",
        askAr: "مين العملاء اللي بيجيبوا فلوس فعلًا",
        askEn: "Which customers actually bring money",
        needs: "customer:view",
      },
      {
        href: "/returns",
        ar: "المرتجعات", en: "Returns",
        askAr: "إيه اللي بيرجع، وليه",
        askEn: "What comes back, and why",
        needs: "sales_order:view",
      },
    ],
  },
  {
    ar: "المصنع",
    en: "The factory floor",
    entries: [
      {
        href: "/minute-rate",
        ar: "تكلفة الدقيقة", en: "Minute rate",
        askAr: "الدقيقة في المصنع بتكلف كام",
        askEn: "What a minute on the floor costs",
        needs: "minute_rate:view",
      },
      {
        href: "/capacity",
        ar: "الطاقة الإنتاجية", en: "Capacity",
        askAr: "المصنع شغال قد إيه من طاقته",
        askEn: "How much of the factory is actually working",
        needs: "minute_rate:view",
      },
      {
        href: "/production/lines",
        ar: "كفاءة الخط", en: "Line efficiency",
        askAr: "الخط أنتج قد إيه من الساعات اللي اتدفعت",
        askEn: "What the line produced against the hours paid for",
        needs: "production:view",
      },
      {
        href: "/production/operators",
        ar: "إنتاجية العامل", en: "Operator productivity",
        askAr: "مين بينتج قد إيه",
        askEn: "Who produces how much",
        needs: "production:view",
      },
      {
        href: "/production/quality",
        ar: "الجودة وإعادة التشغيل", en: "Quality and rework",
        askAr: "نسبة العيوب كام، والإصلاح كلف كام",
        askEn: "The defect rate, and what fixing it cost",
        needs: "production:view",
      },
      {
        href: "/production/scrap",
        ar: "القصاصات", en: "Scrap",
        askAr: "القماش اللي اترمى كلف كام",
        askEn: "What the cloth on the floor cost",
        needs: "production:view",
      },
      {
        href: "/suppliers/scorecard",
        ar: "تقييم المورد", en: "Supplier scorecard",
        askAr: "مين بيسلّم في ميعاده وبسعر كويس",
        askEn: "Who delivers on time and at a fair price",
        needs: "purchase_order:view",
      },
    ],
  },
  {
    ar: "الدفاتر",
    en: "The books themselves",
    entries: [
      {
        href: "/journal",
        ar: "دفتر اليومية", en: "Journal",
        askAr: "كل قيد اتسجل، وإزاي أصحح غلط",
        askEn: "Every posting, and how a mistake is put right",
        needs: "journal:view",
      },
      {
        href: "/accounts",
        ar: "شجرة الحسابات", en: "Chart of accounts",
        askAr: "الحسابات وأرصدتها",
        askEn: "The accounts and what each holds",
        needs: "journal:view",
      },
      {
        href: "/audit",
        ar: "سجل التدقيق", en: "Audit trail",
        askAr: "مين عمل إيه وإمتى",
        askEn: "Who did what, and when",
        needs: "audit:view",
      },
      {
        href: "/tax",
        ar: "الضريبة", en: "VAT",
        askAr: "مستحق للمصلحة كام",
        askEn: "What is owed to the authority",
        needs: "journal:view",
      },
    ],
  },
];

export default async function ReportsPage() {
  const session = await requireUser();
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const h = await reportHeadlines();

  const period = h.period
    ? `${h.period.year}-${String(h.period.month).padStart(2, "0")}`
    : ar ? "مافيش فترة مفتوحة" : "no open period";
  const allowed = (e: Entry) => !e.needs || can(session.role, e.needs);

  /** Only what wants doing, so an empty strip means nothing wants doing. */
  const attention = [
    { n: h.openAlerts, href: "/alerts", ar: "تنبيه مفتوح", en: "open alert", needs: "journal:view" as Permission },
    { n: h.openApprovals, href: "/approvals", ar: "مستني اعتماد", en: "awaiting approval", needs: "expense:view" as Permission },
    { n: h.lateInvoices, href: "/expenses/aging", ar: "فاتورة فات ميعادها", en: "bill past its date", needs: "expense:view" as Permission },
    { n: h.overdueCustomers, href: "/receivables", ar: "عميل متأخر في السداد", en: "customer late paying", needs: "sales_order:view" as Permission },
    { n: h.unpricedStyles, href: "/costing", ar: "موديل من غير تكلفة", en: "style with no costing", needs: "transfer_price:view" as Permission },
    { n: h.staleStock, href: "/inventory/dead-stock", ar: "لوط واقف أكتر من ٩٠ يوم", en: "lot standing over 90 days", needs: "inventory:view" as Permission },
  ].filter((a) => a.n > 0 && can(session.role, a.needs));

  return (
    <>
      <PageHeader
        title={ar ? "التقارير" : "Reports"}
        subtitle={
          ar
            ? "كل تقرير في النظام، مرتّب على السؤال اللي بيجاوبه مش على مكانه"
            : "Every report in the system, arranged by the question it answers rather than by where it lives"
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <StatTile
          label={ar ? "الكاش" : "Cash"}
          value={formatMoney(h.cash.toString())}
          hint={ar ? "الخزنة والدرج والبنك" : "safe, drawer and bank"}
          tone={h.cash.greaterThan(0) ? "good" : "bad"}
        />
        <StatTile
          label={ar ? "ليا عند العملاء" : "Owed to me"}
          value={formatMoney(h.receivable.toString())}
          tone={h.receivable.greaterThan(0) ? "info" : "neutral"}
        />
        <StatTile
          label={ar ? "عليا للموردين" : "I owe"}
          value={formatMoney(h.payable.toString())}
          tone={h.payable.greaterThan(0) ? "warn" : "neutral"}
        />
        <StatTile
          label={ar ? "قيمة البضاعة" : "Stock at cost"}
          value={formatMoney(h.stock.toString())}
          hint={ar ? "خامات وتحت التشغيل وتام" : "materials, WIP and finished"}
        />
      </div>

      <div className="mb-5">
        <Card
          title={ar ? `الفترة المفتوحة — ${period}` : `Open period — ${period}`}
          description={
            ar
              ? "أرقام المجموعة بعد استبعاد البيع الداخلي — مش المصنع والبراند مجموعين"
              : "The group's own figures, with the internal selling taken out — not the two halves added together"
          }
        >
          <div className="grid gap-4 sm:grid-cols-4">
            {([
              [
                ar ? "مبيعات للسوق" : "Sold outside",
                formatMoney(h.revenue.toString()),
                "text-ink-900",
              ],
              [
                ar ? "مصاريف التشغيل" : "Running costs",
                formatMoney(h.expenses.toString()),
                "text-ink-500",
              ],
              [
                ar ? "ربح المجموعة" : "Group profit",
                formatMoney(h.profit.toString()),
                h.profit.greaterThan(0) ? "text-good" : "text-bad",
              ],
              [
                ar ? "ربح محبوس في البضاعة" : "Profit still in stock",
                formatMoney(h.unrealisedInStock.toString()),
                "text-warn",
              ],
            ] as const).map(([label, value, tone]) => (
              <div key={label}>
                <div className="text-xs text-ink-500">{label}</div>
                <div className={`num text-lg font-semibold ${tone}`}>{value}</div>
              </div>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-baseline gap-4 border-t border-line pt-3 text-sm">
            <span>
              {ar ? "هامش الربح" : "Profit margin"}{" "}
              <b className="num">
                {h.profitMarginPct ? formatPercent(h.profitMarginPct.toString()) : "—"}
              </b>
            </span>
            <Link href="/reports/group-pnl" className="text-xs text-ink-600 hover:underline">
              {ar ? "التفصيل الكامل" : "The full breakdown"}
            </Link>
            <span className="text-xs text-ink-400">
              {ar
                ? "«ربح محبوس» هو اللي المصنع كسبه على الورق والمجموعة لسه ماكسبتوش — البضاعة لسه على رف البراند."
                : "\"Still in stock\" is margin the factory has earned on paper and the group has not: the garments are on the brand's shelf."}
            </span>
          </div>
        </Card>
      </div>

      {attention.length > 0 && (
        <div className="mb-5">
          <Card
            title={ar ? "محتاج حد يبصلها" : "Wants somebody's attention"}
            description={
              ar ? "دي مش تقارير — دي حاجات مستنية قرار" : "Not reports: things waiting on a decision"
            }
          >
            <div className="flex flex-wrap gap-2">
              {attention.map((a) => (
                <Link
                  key={a.href + a.en}
                  href={a.href}
                  className="rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 text-sm hover:border-warn"
                >
                  <span className="num font-semibold">{formatNumber(a.n)}</span>{" "}
                  <span className="text-ink-700">{ar ? a.ar : a.en}</span>
                </Link>
              ))}
            </div>
          </Card>
        </div>
      )}

      {SECTIONS.map((section) => {
        const entries = section.entries.filter(allowed);
        if (entries.length === 0) return null;

        return (
          <div key={section.en} className="mb-5">
            <Card title={ar ? section.ar : section.en}>
              <div className="grid gap-2 sm:grid-cols-2">
                {entries.map((e) => (
                  <Link
                    key={e.href}
                    href={e.href}
                    className="rounded-lg border border-line p-3 transition hover:border-ink-300"
                  >
                    <div className="text-sm font-medium text-ink-900">{ar ? e.ar : e.en}</div>
                    <div className="mt-0.5 text-xs text-ink-500">{ar ? e.askAr : e.askEn}</div>
                  </Link>
                ))}
              </div>
            </Card>
          </div>
        );
      })}

      <p className="text-xs text-ink-400">
        {ar
          ? "كل تقرير هنا بيقرا من نفس القيود المرحّلة، فأي رقمين من صفحتين مختلفتين لازم يتفقوا. لو ما اتفقوش، ده فرق حقيقي مش اختلاف في طريقة الحساب."
          : "Every report here reads from the same posted journals, so two figures on two screens must agree. If they ever do not, that is a real difference rather than two ways of counting."}
      </p>
    </>
  );
}
