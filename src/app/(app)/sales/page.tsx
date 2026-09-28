import Link from "next/link";
import { OrderSource, type Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { can } from "@/core/permissions";
import { t } from "@/lib/i18n";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber, formatPercent } from "@/lib/money";
import { dec, safeDiv } from "@/lib/money";

/**
 * Brand sales.
 *
 * Every order carries where it came from and who entered it, so the useful
 * question — which channel and which moderator actually earn money — is
 * answerable without stitching spreadsheets together.
 *
 * Margin here is gross: revenue less the FIFO cost relieved. Marketing,
 * packaging and the rest are Brand operating costs and belong further down
 * the P&L, not on this screen.
 *
 * Reading only. Taking an order used to be possible from here as well as from
 * the moderator desk, which meant the same sale could be entered from two
 * screens that had drifted apart — one of them offering a piece the other had
 * already promised. The desk is where an order is taken; this is where the
 * results are read.
 */
export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string; q?: string; page?: string }>;
}) {
  const session = await requirePermission("report:brand");
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const params = await searchParams;
  const source = Object.values(OrderSource).includes(params.source as OrderSource)
    ? params.source as OrderSource : "";
  const q = (params.q ?? "").trim().slice(0, 100);
  const requestedPage = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);
  const pageSize = 100;
  const where: Prisma.SalesOrderWhereInput = {
    ...(source ? { source } : {}),
    ...(q ? { OR: [
      { orderNumber: { contains: q, mode: "insensitive" } },
      { shopifyOrderId: { contains: q, mode: "insensitive" } },
      { customer: { is: { name: { contains: q, mode: "insensitive" } } } },
      { customer: { is: { phone: { contains: q } } } },
      { shippingPhone: { contains: q } },
      { lines: { some: { variant: { sku: { contains: q, mode: "insensitive" } } } } },
    ] } : {}),
  };
  const matchCount = await db.salesOrder.count({ where });
  const pageCount = Math.max(1, Math.ceil(matchCount / pageSize));
  const page = Math.min(requestedPage, pageCount);
  const pageHref = (number: number) => {
    const query = new URLSearchParams();
    if (source) query.set("source", source);
    if (q) query.set("q", q);
    query.set("page", String(number));
    return `/sales?${query.toString()}`;
  };

  const [orders, sessions] = await Promise.all([
    db.salesOrder.findMany({
      where,
      include: {
        customer: true,
        createdBy: true,
        location: true,
        lines: true,
        payments: true,
      },
      orderBy: [{ orderDate: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.posSession.findMany({
      include: {
        location: true, cashier: true, closedBy: true,
        _count: { select: { orders: true } },
      },
      orderBy: { openedAt: "desc" },
      take: 10,
    }),
  ]);

  const revenue = orders.reduce((s, o) => s.plus(dec(o.netAmount)), dec(0));
  const cogs = orders.reduce((s, o) => s.plus(dec(o.cogsAmount)), dec(0));
  const units = orders.reduce(
    (s, o) => s + o.lines.reduce((t, l) => t + l.quantity, 0), 0,
  );
  const grossMargin = revenue.minus(cogs);
  const marginPct = safeDiv(grossMargin, revenue);

  // Money taken but not yet in the bank — mostly cash on delivery in transit.
  const uncollected = orders
    .flatMap((o) => o.payments)
    .filter((p) => p.status === "PENDING")
    .reduce((s, p) => s.plus(dec(p.amount)), dec(0));

  type Agg = { orders: number; units: number; revenue: ReturnType<typeof dec>; cogs: ReturnType<typeof dec> };
  const emptyAgg = (): Agg => ({ orders: 0, units: 0, revenue: dec(0), cogs: dec(0) });

  function groupBy(key: (o: (typeof orders)[number]) => string | null) {
    const map = new Map<string, Agg>();
    for (const o of orders) {
      const k = key(o);
      if (!k) continue;
      const agg = map.get(k) ?? emptyAgg();
      agg.orders += 1;
      agg.units += o.lines.reduce((t, l) => t + l.quantity, 0);
      agg.revenue = agg.revenue.plus(dec(o.netAmount));
      agg.cogs = agg.cogs.plus(dec(o.cogsAmount));
      map.set(k, agg);
    }
    return [...map.entries()].sort((a, b) => Number(b[1].revenue.minus(a[1].revenue)));
  }

  const bySource = groupBy((o) => o.source);
  const byModerator = groupBy((o) =>
    o.source === "MODERATOR" ? (o.createdBy?.name ?? "—") : null,
  );

  const sourceLabel: Record<string, string> = ar
    ? {
        SHOPIFY: "Shopify / الموقع", MODERATOR: "السوشيال", POS: "المعرض",
        EXHIBITION: "بازار", WHOLESALE: "جملة", MANUAL: "يدوي",
      }
    : {
        SHOPIFY: "Shopify / Website", MODERATOR: "Social", POS: "Showroom",
        EXHIBITION: "Exhibition", WHOLESALE: "Wholesale", MANUAL: "Manual",
      };

  const name = (e: { nameAr: string; nameEn: string } | null) =>
    e ? (ar ? e.nameAr : e.nameEn) : "—";

  function marginRow(label: string, a: Agg) {
    const gm = a.revenue.minus(a.cogs);
    const pct = safeDiv(gm, a.revenue);
    const aov = safeDiv(a.revenue, a.orders);
    return [
      <span key={`${label}-l`}>{label}</span>,
      <span key={`${label}-o`} className="num">{formatNumber(a.orders, locale)}</span>,
      <span key={`${label}-u`} className="num">{formatNumber(a.units, locale)}</span>,
      <span key={`${label}-r`} className="num">{formatMoney(a.revenue, locale)}</span>,
      <span key={`${label}-a`} className="num">{aov ? formatMoney(aov, locale) : "—"}</span>,
      <span key={`${label}-m`} className="num font-medium">{formatMoney(gm, locale)}</span>,
      <span
        key={`${label}-p`}
        className={pct && pct.lessThan("0.2") ? "num text-bad" : "num"}
      >
        {pct ? formatPercent(pct, locale) : "—"}
      </span>,
    ];
  }

  const marginHeaders = [
    ar ? "المصدر" : "Source",
    ar ? "طلبات" : "Orders",
    ar ? "قطع" : "Units",
    ar ? "الإيراد" : "Revenue",
    ar ? "متوسط الطلب" : "AOV",
    ar ? "مجمل الربح" : "Gross margin",
    "%",
  ];

  return (
    <>
      <PageHeader
        title={t("sales", locale)}
        subtitle={
          ar
            ? "كل الطلبات في محرك واحد، مع الاحتفاظ بمصدرها ومن سجّلها"
            : "Every order in one engine, with its source and who entered it preserved"
        }
      />

      <p className="mb-4 rounded-lg border border-ink-200 bg-panel px-3 py-2.5 text-sm text-ink-600">
        {ar
          ? "دي المبيعات اللي اتسجلت في النظام من كل المصادر. أوردرات Shopify اللي لسه ما اتسجلتش بتظهر في شاشة Shopify."
          : "These are recorded sales from every source. Shopify orders that have not been imported appear on the Shopify orders screen."}{" "}
        {can(session.role, "settings:manage") && <Link href="/integrations/shopify-orders" className="font-medium text-ink-900 underline">{ar ? "افتح أوردرات Shopify" : "Open Shopify orders"}</Link>}
      </p>

      <form action="/sales" method="get" className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-ink-200 bg-panel p-3 text-sm">
        <label className="flex min-w-44 flex-col gap-1">
          <span>{ar ? "مصدر الطلب" : "Order source"}</span>
          <select name="source" defaultValue={source} className="rounded-md border border-ink-200 bg-white px-3 py-2">
            <option value="">{ar ? "كل المصادر" : "All sources"}</option>
            {Object.values(OrderSource).map((value) => <option key={value} value={value}>{sourceLabel[value] ?? value}</option>)}
          </select>
        </label>
        <label className="flex min-w-56 flex-1 flex-col gap-1">
          <span>{ar ? "بحث في الطلبات" : "Search orders"}</span>
          <input name="q" defaultValue={q} placeholder={ar ? "رقم الطلب، اسم العميل، تليفونه أو SKU" : "Order number, customer, phone or SKU"} className="rounded-md border border-ink-200 bg-white px-3 py-2" />
        </label>
        <button type="submit" className="rounded-md bg-ink-900 px-4 py-2 text-white">{ar ? "اعرض" : "Show"}</button>
        {(source || q) && <Link href="/sales" className="px-2 py-2 underline">{ar ? "إلغاء الفلتر" : "Clear filters"}</Link>}
        <span className="w-full text-ink-500">{ar ? `${formatNumber(matchCount, locale)} طلب مطابق. الأرقام أدناه تخص الطلبات الظاهرة في الصفحة الحالية.` : `${formatNumber(matchCount, locale)} matching orders. Figures below cover the orders shown on this page.`}</span>
      </form>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={ar ? "صافي الإيراد" : "Net revenue"}
          value={formatMoney(revenue, locale)}
          hint={`${formatNumber(units, locale)} ${ar ? "قطعة" : "units"}`}
        />
        <StatTile
          label={ar ? "تكلفة المبيعات" : "Cost of goods sold"}
          value={formatMoney(cogs, locale)}
        />
        <StatTile
          label={ar ? "مجمل الربح" : "Gross margin"}
          value={formatMoney(grossMargin, locale)}
          tone={grossMargin.greaterThan(0) ? "good" : "bad"}
          hint={marginPct ? formatPercent(marginPct, locale) : undefined}
        />
        <StatTile
          label={ar ? "متحصلات معلّقة" : "Uncollected"}
          value={formatMoney(uncollected, locale)}
          tone={uncollected.greaterThan(0) ? "warn" : "neutral"}
          hint={ar ? "غالبًا تحصيل عند الاستلام" : "Mostly cash on delivery in transit"}
        />
      </div>

      {orders.length === 0 ? (
        <Card>
          <p className="py-8 text-center text-sm text-ink-400">
            {ar
              ? (source || q ? "مفيش مبيعات مطابقة للبحث. أوردرات Shopify اللي لم تُستورد بتظهر في صفحة أوردرات Shopify." : "لا توجد مبيعات بعد. الموقع والسوشيال والمعرض كلهم بيدخلوا نفس المحرك.")
              : (source || q ? "No matching sales. Shopify orders that were not imported appear on the Shopify orders page." : "No sales yet. The website, social orders and the showroom all enter the same engine.")}
          </p>
        </Card>
      ) : (
        <>
          <div className="mb-4 grid gap-4 lg:grid-cols-2">
            <Card
              title={ar ? "أداء القنوات" : "Channel performance"}
              description={
                ar
                  ? "مجمل الربح = الإيراد ناقص تكلفة البضاعة المنصرفة فعليًا"
                  : "Gross margin is revenue less the cost actually relieved from stock"
              }
            >
              <DataTable
                headers={marginHeaders}
                rows={bySource.map(([source, agg]) =>
                  marginRow(sourceLabel[source] ?? source, agg),
                )}
              />
            </Card>

            <Card
              title={ar ? "أداء المودريتور" : "Moderator performance"}
              description={
                ar
                  ? "طلبات السوشيال فقط — كل طلب لازم يكون له مودريتور"
                  : "Social orders only — every one must name its moderator"
              }
            >
              {byModerator.length === 0 ? (
                <p className="py-4 text-center text-sm text-ink-400">
                  {ar ? "لا توجد طلبات سوشيال." : "No social orders yet."}
                </p>
              ) : (
                <DataTable
                  headers={marginHeaders.map((h, i) =>
                    i === 0 ? (ar ? "المودريتور" : "Moderator") : h,
                  )}
                  rows={byModerator.map(([who, agg]) => marginRow(who, agg))}
                />
              )}
            </Card>
          </div>

          {sessions.length > 0 && (
            <Card
              className="mb-4"
              title={ar ? "ورديات الكاشير" : "Till sessions"}
              description={
                ar
                  ? "الفرق يُسجَّل ولا يُجبَر على الصفر"
                  : "A variance is recorded, never forced to zero"
              }
            >
              <DataTable
                headers={[
                  ar ? "الوردية" : "Session",
                  ar ? "الموقع" : "Location",
                  ar ? "البياع" : "Sold by",
                  ar ? "اللي عدّ" : "Counted by",
                  ar ? "طلبات" : "Orders",
                  ar ? "المتوقع" : "Expected",
                  ar ? "المعدود" : "Counted",
                  ar ? "الفرق" : "Variance",
                ]}
                rows={sessions.map((s) => [
                  <code key={`${s.id}-n`} dir="ltr" className="text-xs text-ink-500">
                    {s.sessionNumber}
                  </code>,
                  <span key={`${s.id}-l`}>{name(s.location)}</span>,
                  <span key={`${s.id}-c`}>{s.cashier.name}</span>,
                  // One person sells, another counts. Both names sit on the
                  // same row so the owner reads the pair, not just the total.
                  <span key={`${s.id}-cb`} className={s.closedBy ? "" : "text-ink-300"}>
                    {s.closedBy?.name ?? "—"}
                  </span>,
                  <span key={`${s.id}-o`} className="num">{s._count.orders}</span>,
                  <span key={`${s.id}-e`} className="num">
                    {s.expectedCash ? formatMoney(s.expectedCash, locale) : "—"}
                  </span>,
                  <span key={`${s.id}-ct`} className="num">
                    {s.countedCash ? formatMoney(s.countedCash, locale) : "—"}
                  </span>,
                  s.cashVariance == null ? (
                    <Badge key={`${s.id}-v`} tone="info">{ar ? "مفتوحة" : "Open"}</Badge>
                  ) : (
                    <span
                      key={`${s.id}-v`}
                      className={Number(s.cashVariance) === 0 ? "num text-good" : "num text-bad"}
                    >
                      {formatMoney(s.cashVariance, locale)}
                    </span>
                  ),
                ])}
              />
            </Card>
          )}

          <Card title={ar ? "الطلبات" : "Orders"}>
            <DataTable
              headers={[
                ar ? "الطلب" : "Order",
                ar ? "المصدر" : "Source",
                ar ? "سجّلها" : "Entered by",
                ar ? "الموقع" : "Location",
                ar ? "قطع" : "Units",
                ar ? "الإيراد" : "Revenue",
                ar ? "التكلفة" : "Cost",
                ar ? "الربح" : "Margin",
                ar ? "التاريخ" : "Date",
              ]}
              rows={orders.map((o) => {
                const gm = dec(o.netAmount).minus(dec(o.cogsAmount));
                return [
                  <code key={`${o.id}-n`} dir="ltr" className="text-xs text-ink-500">
                    {o.orderNumber}
                  </code>,
                  <Badge key={`${o.id}-s`} tone={o.source === "MODERATOR" ? "info" : "neutral"}>
                    {sourceLabel[o.source] ?? o.source}
                  </Badge>,
                  <span key={`${o.id}-b`}>{o.createdBy?.name ?? "—"}</span>,
                  <span key={`${o.id}-l`}>{name(o.location)}</span>,
                  <span key={`${o.id}-u`} className="num">
                    {o.lines.reduce((t, l) => t + l.quantity, 0)}
                  </span>,
                  <span key={`${o.id}-r`} className="num">{formatMoney(o.netAmount, locale)}</span>,
                  <span key={`${o.id}-c`} className="num">{formatMoney(o.cogsAmount, locale)}</span>,
                  <span
                    key={`${o.id}-m`}
                    className={gm.greaterThan(0) ? "num text-good" : "num text-bad"}
                  >
                    {formatMoney(gm, locale)}
                  </span>,
                  <span key={`${o.id}-d`} className="num" dir="ltr">
                    {o.orderDate.toISOString().slice(0, 10)}
                  </span>,
                ];
              })}
            />
          </Card>
          {pageCount > 1 && (
            <nav aria-label={ar ? "صفحات الطلبات" : "Order pages"} className="mt-4 flex items-center justify-center gap-4 text-sm">
              {page > 1 && <Link href={pageHref(page - 1)} className="underline">{ar ? "السابق" : "Previous"}</Link>}
              <span>{ar ? `صفحة ${page} من ${pageCount}` : `Page ${page} of ${pageCount}`}</span>
              {page < pageCount && <Link href={pageHref(page + 1)} className="underline">{ar ? "التالي" : "Next"}</Link>}
            </nav>
          )}
        </>
      )}
    </>
  );
}
