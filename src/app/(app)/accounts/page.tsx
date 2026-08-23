import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { can } from "@/core/permissions";
import { chartOfAccounts, possibleParents } from "@/lib/accounts";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber, dec } from "@/lib/money";
import { AccountForm } from "./account-form";
import { AccountRowActions } from "./account-row-actions";

/**
 * شجرة الحسابات — the chart, and what each account actually holds.
 *
 * Every account came from the seed and there was no way to see the chart at
 * all, let alone add to it: adding a heading meant editing a seed file and
 * reseeding, which on a live database is not something anybody should be asked
 * to do.
 *
 * Balances are shown beside the names because a list of accounts without them
 * cannot answer the question people open it for — which of these is doing
 * anything, and which are just structure.
 */
export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ all?: string; type?: string }>;
}) {
  const session = await requirePermission("journal:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const query = await searchParams;

  const includeInactive = query.all === "1";
  const [chart, parents] = await Promise.all([
    chartOfAccounts({ includeInactive }),
    possibleParents(),
  ]);

  const mayManage = can(session.role, "account:manage");

  const rows = query.type ? chart.filter((a) => a.type === query.type) : chart;

  const postable = chart.filter((a) => a.isPostable && a.isActive);
  const used = chart.filter((a) => a.postings > 0);
  const inMinuteRate = chart.filter((a) => a.includeInMinuteRate);
  const inBrandPool = chart.filter((a) => a.includeInBrandFixedPool);

  const typeLabel: Record<string, string> = ar
    ? {
        ASSET: "أصول",
        LIABILITY: "خصوم",
        EQUITY: "حقوق ملكية",
        REVENUE: "إيرادات",
        COGS: "تكلفة مبيعات",
        EXPENSE: "مصروفات",
      }
    : {
        ASSET: "Asset",
        LIABILITY: "Liability",
        EQUITY: "Equity",
        REVENUE: "Revenue",
        COGS: "Cost of sales",
        EXPENSE: "Expense",
      };

  const link = (next: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ all: query.all, type: query.type, ...next })) {
      if (v) p.set(k, String(v));
    }
    const q = p.toString();
    return q ? `/accounts?${q}` : "/accounts";
  };

  const tab = (active: boolean) =>
    active
      ? "rounded-md bg-ink-900 px-3 py-1.5 text-white"
      : "rounded-md border border-ink-200 px-3 py-1.5 text-ink-600 hover:border-ink-300";

  return (
    <>
      <PageHeader
        title={ar ? "شجرة الحسابات" : "Chart of accounts"}
        subtitle={
          ar
            ? "الكود ما بيتغيّرش ولا بيتعاد استخدامه، والحساب اللي عليه حركات ما بيتمسحش — بيتوقّف بس."
            : "A code is never changed or reused, and an account with postings is never deleted — only retired."
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <StatTile
          label={ar ? "حسابات شغالة" : "Active accounts"}
          value={formatNumber(chart.filter((a) => a.isActive).length)}
          hint={`${formatNumber(postable.length)} ${ar ? "بيتسجل عليها" : "postable"}`}
        />
        <StatTile
          label={ar ? "عليها حركات" : "With postings"}
          value={formatNumber(used.length)}
          hint={ar ? "دي مش ممكن تتمسح" : "these can never be deleted"}
          tone="info"
        />
        <StatTile
          label={ar ? "في تكلفة الدقيقة" : "In the minute rate"}
          value={formatNumber(inMinuteRate.length)}
          hint={ar ? "بتحدد تكلفة كل قطعة" : "sets what every garment costs"}
        />
        <StatTile
          label={ar ? "في مصاريف البراند الثابتة" : "In the brand's fixed pool"}
          value={formatNumber(inBrandPool.length)}
          hint={ar ? "بتحدد نقطة التعادل والتسعير" : "drives break-even and pricing"}
        />
      </div>

      {mayManage && (
        <div className="mb-5">
          <Card
            title={ar ? "إضافة حساب" : "Add an account"}
            description={
              ar
                ? "الرصيد الطبيعي بيتحدد من النوع — مش اختيار، لأن قلبه بيقلب التقارير."
                : "The normal balance follows from the type — not a choice, because inverting it inverts the reports."
            }
          >
            <AccountForm ar={ar} parents={parents} />
          </Card>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <a href={link({ type: undefined })} className={tab(!query.type)}>
          {ar ? "الكل" : "All"}
        </a>
        {Object.keys(typeLabel).map((t) => (
          <a key={t} href={link({ type: t })} className={tab(query.type === t)}>
            {typeLabel[t]}
          </a>
        ))}
        <span className="mx-1 text-ink-300">|</span>
        <a href={link({ all: includeInactive ? undefined : "1" })} className={tab(includeInactive)}>
          {ar ? "اعرض الموقوفة" : "Show retired"}
        </a>
      </div>

      <Card
        title={ar ? "الشجرة" : "The chart"}
        description={
          ar
            ? "«رأس مجموعة» يعني ما بيتسجلش عليه — الرصيد بيتجمّع من اللي تحته، ولو اتسجل عليه كمان كان الإجمالي هيتحسب مرتين."
            : "A header takes no postings: its balance comes from what sits under it, and posting to both would count the same money twice."
        }
      >
        <DataTable
          headers={[
            ar ? "الكود" : "Code",
            ar ? "الاسم" : "Name",
            ar ? "النوع" : "Type",
            ar ? "الرصيد الطبيعي" : "Normal",
            ar ? "بيخص" : "Scope",
            ar ? "حركات" : "Postings",
            ar ? "الرصيد" : "Balance",
            "",
          ]}
          empty={ar ? "مفيش حسابات" : "No accounts"}
          rows={rows.map((a) => [
            <span key="c" className="num text-xs" dir="ltr">{a.code}</span>,
            <span key="n" style={{ paddingInlineStart: `${a.depth * 1.25}rem` }}>
              <span className={a.isPostable ? "text-ink-900" : "font-semibold text-ink-800"}>
                {ar ? a.nameAr : a.nameEn}
              </span>
              {!a.isPostable && (
                <span className="ms-2 text-[11px] text-ink-400">
                  {ar ? "رأس مجموعة" : "header"}
                </span>
              )}
              {!a.isActive && (
                <span className="ms-2 text-[11px] text-bad">{ar ? "موقوف" : "retired"}</span>
              )}
            </span>,
            <span key="t" className="text-xs text-ink-500">{typeLabel[a.type] ?? a.type}</span>,
            <span key="nb" className="text-xs text-ink-500">
              {a.normalBalance === "DEBIT" ? (ar ? "مدين" : "Debit") : ar ? "دائن" : "Credit"}
            </span>,
            <span key="s" className="text-xs text-ink-400">
              {a.scope === "BOTH" ? (ar ? "الاتنين" : "Both") : a.scope === "FACTORY" ? (ar ? "المصنع" : "Factory") : (ar ? "البراند" : "Brand")}
            </span>,
            a.postings > 0 ? (
              <a
                key="p"
                href={`/journal?account=${a.code}`}
                className="num text-xs text-ink-600 hover:underline"
              >
                {formatNumber(a.postings)}
              </a>
            ) : (
              <span key="p" className="text-ink-300">—</span>
            ),
            dec(a.balance).isZero() ? (
              <span key="b" className="text-ink-300">—</span>
            ) : (
              <span key="b" className="num font-medium">{formatMoney(a.balance.toString())}</span>
            ),
            <span key="f" className="flex flex-wrap items-center gap-1">
              {a.includeInMinuteRate && (
                <Badge tone="warn">{ar ? "تكلفة الدقيقة" : "minute rate"}</Badge>
              )}
              {a.includeInBrandFixedPool && (
                <Badge tone="info">{ar ? "ثابت البراند" : "brand fixed"}</Badge>
              )}
              {a.isIntercompany && (
                <Badge tone="neutral">{ar ? "بيني" : "intercompany"}</Badge>
              )}
              {mayManage && (
                <AccountRowActions
                  ar={ar}
                  id={a.id}
                  code={a.code}
                  nameAr={a.nameAr}
                  nameEn={a.nameEn}
                  isActive={a.isActive}
                  postings={a.postings}
                  includeInMinuteRate={a.includeInMinuteRate}
                  includeInBrandFixedPool={a.includeInBrandFixedPool}
                />
              )}
            </span>,
          ])}
        />

        <p className="mt-3 text-xs text-ink-400">
          {ar
            ? "الرصيد هنا هو المدين ناقص الدائن على القيود المرحّلة. يعني حساب دائن بطبيعته (زي الإيرادات) هيظهر بالسالب، وده صح مش غلط."
            : "The balance is debits less credits on posted entries, so an account whose normal balance is a credit — revenue, for instance — shows negative here. That is correct, not a fault."}
        </p>
      </Card>
    </>
  );
}
