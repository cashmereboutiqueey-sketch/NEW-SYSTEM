import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { can } from "@/core/permissions";
import { sellableStock } from "@/lib/pos";
import { t } from "@/lib/i18n";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber, formatPercent } from "@/lib/money";
import { dec, safeDiv } from "@/lib/money";
import { ModeratorOrderForm } from "./moderator-form";

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
 */
export default async function SalesPage() {
  const session = await requirePermission("sales_order:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const mayOrder = can(session.role, "sales_order:create");
  const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });

  const [orders, sessions, customers, channels, brandLocations] = await Promise.all([
    db.salesOrder.findMany({
      include: {
        customer: true,
        createdBy: true,
        location: true,
        lines: true,
        payments: true,
      },
      orderBy: [{ orderDate: "desc" }, { createdAt: "desc" }],
      take: 100,
    }),
    db.posSession.findMany({
      include: { location: true, cashier: true, _count: { select: { orders: true } } },
      orderBy: { openedAt: "desc" },
      take: 10,
    }),
    db.customer.findMany({
      where: { isSuppressed: false, mergedIntoId: null },
      orderBy: { name: "asc" },
      take: 500,
    }),
    db.salesChannel.findMany({ where: { isActive: true }, orderBy: { nameEn: "asc" } }),
    db.location.findMany({
      where: { isActive: true, entityId: brand.id },
      orderBy: { sortOrder: "asc" },
    }),
  ]);

  // Only what the brand actually holds, so an order cannot promise a garment
  // that is still at the factory or still on the road.
  const stockByLocation = await Promise.all(
    brandLocations.map((l) => sellableStock(l.id, brand.id)),
  );
  const sellable = new Map<
    string,
    { variantId: string; sku: string; label: string; available: number; retailPrice: number }
  >();
  for (const shelf of stockByLocation) {
    for (const p of shelf) {
      const existing = sellable.get(p.variantId);
      const available = Number(p.available);
      if (existing) existing.available += available;
      else
        sellable.set(p.variantId, {
          variantId: p.variantId,
          sku: p.sku,
          label: `${ar ? p.styleAr : p.styleEn} · ${ar ? p.colourAr : p.colourEn} · ${p.size}`,
          available,
          retailPrice: Number(p.retailPrice ?? 0),
        });
    }
  }

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
        SHOPIFY: "الموقع", MODERATOR: "السوشيال", POS: "المعرض",
        EXHIBITION: "بازار", WHOLESALE: "جملة", MANUAL: "يدوي",
      }
    : {
        SHOPIFY: "Website", MODERATOR: "Social", POS: "Showroom",
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

      {mayOrder && (
        <Card
          className="mb-4"
          title={ar ? "أوردر مودريتور" : "Moderator order"}
          description={
            ar
              ? "الأوردر اللي جه على واتساب أو إنستجرام — نفس المحرك اللي بيشتغل بيه الكاشير والموقع"
              : "An order that came in by message — the same engine the till and the website use"
          }
        >
          {sellable.size === 0 || channels.length === 0 || brandLocations.length === 0 ? (
            <p className="py-4 text-sm text-ink-500">
              {ar
                ? "مفيش مخزون عند البراند دلوقتي. استلم بضاعة من المصنع الأول من صفحة الوارد."
                : "The Brand holds no stock yet. Receive a delivery from the factory first."}
            </p>
          ) : (
            <ModeratorOrderForm
              locale={locale}
              entityId={brand.id}
              today={new Date().toISOString().slice(0, 10)}
              canDiscount={can(session.role, "sales_order:discount")}
              products={[...sellable.values()].sort((a, b) => a.sku.localeCompare(b.sku))}
              customers={customers.map((c) => ({ id: c.id, name: c.name, phone: c.phone }))}
              channels={channels.map((c) => ({ id: c.id, label: ar ? c.nameAr : c.nameEn }))}
              locations={brandLocations.map((l) => ({ id: l.id, label: ar ? l.nameAr : l.nameEn }))}
            />
          )}
        </Card>
      )}

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
              ? "لا توجد مبيعات بعد. الموقع والسوشيال والمعرض كلهم بيدخلوا نفس المحرك."
              : "No sales yet. The website, social orders and the showroom all enter the same engine."}
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
                  ar ? "الكاشير" : "Cashier",
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
        </>
      )}
    </>
  );
}
