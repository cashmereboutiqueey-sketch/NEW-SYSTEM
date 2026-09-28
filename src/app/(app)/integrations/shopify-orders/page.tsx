import Link from "next/link";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { getPrefs } from "@/lib/session";
import { formatMoney, formatNumber } from "@/lib/money";
import { isShopDomain } from "@/core/shopify-domain";
import { PageHeader, Card, Badge, StatTile } from "@/components/ui";
import type { ShopifyOrder } from "@/lib/shopify";

/** Shopify's delivery history is also the inbox for orders stock could not fulfil. */
export default async function ShopifyOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; state?: string }>;
}) {
  await requirePermission("settings:manage");
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const params = await searchParams;
  const q = (params.q ?? "").trim().slice(0, 100);
  const state = ["all", "imported", "blocked", "cancelled"].includes(params.state ?? "") ? params.state : "all";
  const connection = await db.integrationConnection.findFirst({ where: { provider: "SHOPIFY" } });

  if (!connection) {
    return <Card title={ar ? "أوردرات Shopify" : "Shopify orders"}>{ar ? "اربط المتجر الأول من صفحة التكاملات." : "Connect the shop on the integrations page first."}</Card>;
  }

  const [events, exceptions, mappings] = await Promise.all([
    db.shopifyWebhookEvent.findMany({ where: { connectionId: connection.id }, orderBy: { receivedAt: "desc" } }),
    db.integrationException.findMany({ where: { connectionId: connection.id, provider: "SHOPIFY", objectType: "order", status: "OPEN" }, orderBy: { createdAt: "desc" } }),
    db.externalMapping.findMany({ where: { connectionId: connection.id, objectType: "order" } }),
  ]);
  const saleIds = mappings.map((mapping) => mapping.internalId);
  const [sales, movements] = await Promise.all([
    db.salesOrder.findMany({
      where: { id: { in: saleIds } },
      include: { lines: { include: { variant: true } }, customer: true },
    }),
    db.inventoryMovement.findMany({
      where: { referenceType: "SALES_ORDER", referenceId: { in: saleIds }, direction: "OUT" },
      select: { referenceId: true, quantity: true },
    }),
  ]);

  const snapshots = new Map<string, ShopifyOrder>();
  const latestEvents = new Map<string, (typeof events)[number]>();
  for (const event of events) {
    const order = event.payload as unknown as ShopifyOrder;
    const id = String(order?.id ?? "");
    if (!id || snapshots.has(id)) continue;
    snapshots.set(id, order);
    latestEvents.set(id, event);
  }
  const openErrors = new Map<string, (typeof exceptions)[number]>();
  for (const exception of exceptions) {
    if (!exception.externalId) continue;
    if (!openErrors.has(exception.externalId)) openErrors.set(exception.externalId, exception);
    if (!snapshots.has(exception.externalId) && exception.payload) {
      snapshots.set(exception.externalId, exception.payload as unknown as ShopifyOrder);
    }
  }
  const mappingByExternal = new Map(mappings.map((mapping) => [mapping.externalId, mapping]));
  const saleById = new Map(sales.map((sale) => [sale.id, sale]));
  const deducted = new Map<string, number>();
  for (const movement of movements) {
    if (!movement.referenceId) continue;
    deducted.set(movement.referenceId, (deducted.get(movement.referenceId) ?? 0) + Number(movement.quantity));
  }
  const ids = new Set([...snapshots.keys(), ...mappingByExternal.keys()]);
  const orders = [...ids].map((id) => {
    const snapshot = snapshots.get(id);
    const sale = saleById.get(mappingByExternal.get(id)?.internalId ?? "");
    const event = latestEvents.get(id);
    const exception = openErrors.get(id);
    const sold = sale?.lines.reduce((total, line) => total + line.quantity, 0) ?? 0;
    const moved = sale ? deducted.get(sale.id) ?? 0 : 0;
    return { id, snapshot, sale, event, exception, sold, moved };
  }).sort((a, b) => {
    const date = (row: (typeof orders)[number]) => row.snapshot?.created_at ?? row.sale?.orderDate.toISOString() ?? "";
    return date(b).localeCompare(date(a));
  });
  const imported = orders.filter((order) => order.sale);
  const blocked = orders.filter((order) => !order.sale && !order.snapshot?.cancelled_at);
  const cancelled = orders.filter((order) => !!order.snapshot?.cancelled_at);
  const needle = q.toLocaleLowerCase();
  const visibleOrders = orders.filter((order) => {
    if (state === "imported" && !order.sale) return false;
    if (state === "blocked" && (order.sale || order.snapshot?.cancelled_at)) return false;
    if (state === "cancelled" && !order.snapshot?.cancelled_at) return false;
    if (!needle) return true;
    const snapshot = order.snapshot;
    return [
      order.id,
      snapshot?.name,
      order.sale?.orderNumber,
      order.sale?.customer?.name,
      snapshot?.customer?.first_name,
      snapshot?.customer?.last_name,
      snapshot?.customer?.phone,
      snapshot?.shipping_address?.name,
      snapshot?.shipping_address?.phone,
      ...(snapshot?.line_items ?? []).flatMap((line) => [line.sku, line.title, line.variant_title]),
      ...(order.sale?.lines ?? []).map((line) => line.variant.sku),
    ].some((value) => String(value ?? "").toLocaleLowerCase().includes(needle));
  });

  return (
    <>
      <PageHeader
        title={ar ? "أوردرات Shopify" : "Shopify orders"}
        subtitle={ar ? `المصدر: ${connection.externalRef}. كل أوردر يوضح هل دخل المبيعات وهل اتخصم من مخزون النظام.` : `Source: ${connection.externalRef}. Each order shows whether it reached sales and relieved system stock.`}
      />
      <div className="mb-4 flex flex-wrap gap-3 text-sm">
        <Link href="/integrations" className="underline">{ar ? "التكاملات والأخطاء" : "Integrations and errors"}</Link>
        <Link href="/sales?source=SHOPIFY" className="underline">{ar ? "مبيعات Shopify المسجلة" : "Recorded Shopify sales"}</Link>
        <Link href="/shipping" className="underline">{ar ? "الطلبات الجاهزة للشحن" : "Shipping queue"}</Link>
      </div>
      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label={ar ? "وصل من Shopify" : "Seen from Shopify"} value={formatNumber(orders.length, locale)} />
        <StatTile label={ar ? "دخل المبيعات" : "Imported to sales"} value={formatNumber(imported.length, locale)} tone={imported.length ? "good" : "neutral"} />
        <StatTile label={ar ? "لم يدخل المبيعات" : "Not imported"} value={formatNumber(blocked.length, locale)} tone={blocked.length ? "bad" : "good"} />
        <StatTile label={ar ? "ملغي في Shopify" : "Cancelled on Shopify"} value={formatNumber(cancelled.length, locale)} />
      </div>
      <form action="/integrations/shopify-orders" method="get" className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-ink-200 bg-panel p-3 text-sm">
        <label className="flex min-w-40 flex-col gap-1">
          <span>{ar ? "حالة الأوردر" : "Order status"}</span>
          <select name="state" defaultValue={state} className="rounded-md border border-ink-200 bg-white px-3 py-2">
            <option value="all">{ar ? "كل أوردرات Shopify" : "All Shopify orders"}</option>
            <option value="imported">{ar ? "دخل المبيعات" : "Imported to sales"}</option>
            <option value="blocked">{ar ? "لم يدخل المبيعات" : "Not imported"}</option>
            <option value="cancelled">{ar ? "ملغي في Shopify" : "Cancelled on Shopify"}</option>
          </select>
        </label>
        <label className="flex min-w-56 flex-1 flex-col gap-1">
          <span>{ar ? "بحث في Shopify" : "Search Shopify"}</span>
          <input name="q" defaultValue={q} placeholder={ar ? "رقم الأوردر، العميل أو المنتج / SKU" : "Order number, customer, product or SKU"} className="rounded-md border border-ink-200 bg-white px-3 py-2" />
        </label>
        <button type="submit" className="rounded-md bg-ink-900 px-4 py-2 text-white">{ar ? "اعرض" : "Show"}</button>
        {(q || state !== "all") && <Link href="/integrations/shopify-orders" className="px-2 py-2 underline">{ar ? "إلغاء الفلتر" : "Clear filters"}</Link>}
        <span className="w-full text-ink-500">{ar ? `${formatNumber(visibleOrders.length, locale)} من ${formatNumber(orders.length, locale)} أوردر` : `${formatNumber(visibleOrders.length, locale)} of ${formatNumber(orders.length, locale)} orders`}</span>
      </form>
      {blocked.length > 0 && (
        <p role="alert" className="mb-4 rounded-lg bg-warn/10 p-3 text-sm text-warn">
          {ar
            ? "الأوردرات غير المستوردة موجودة هنا للمراجعة فقط. لم تُخصم من المخزون ولم تدخل المبيعات أو شيت الشحن. أصلح الكود أو الرصيد الفعلي ثم أعد الاستيراد من التكاملات."
            : "Unimported orders are visible here for review. They did not reduce stock or enter sales or shipping. Fix the SKU or real stock balance, then retry from Integrations."}
        </p>
      )}
      <div className="space-y-3">
        {visibleOrders.map(({ id, snapshot, sale, event, exception, sold, moved }) => {
          const number = snapshot?.name || mappingByExternal.get(id)?.externalRef || id;
          const shopUrl = isShopDomain(connection.externalRef) && /^\d+$/.test(id)
            ? `https://${connection.externalRef}/admin/orders/${id}` : null;
          const stockOk = !!sale && moved === sold && sold > 0;
          const cancelledUpstream = !!snapshot?.cancelled_at;
          const address = snapshot?.shipping_address;
          const lines = Array.isArray(snapshot?.line_items) ? snapshot.line_items : [];
          const shopifyMoney = (amount: string) => `${formatMoney(amount, locale, false)} ${snapshot?.currency ?? ""}`.trim();
          return (
            <Card key={id} title={number} description={`${connection.displayName} · ${snapshot?.created_at?.slice(0, 10) ?? sale?.orderDate.toISOString().slice(0, 10) ?? "—"}`}>
              <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={cancelledUpstream ? "warn" : sale ? "good" : "bad"}>{cancelledUpstream ? (ar ? "ملغي في Shopify" : "Cancelled on Shopify") : sale ? (ar ? "دخل المبيعات" : "Imported") : (ar ? "لم يُستورد" : "Not imported")}</Badge>
                {cancelledUpstream && sale && <Badge tone="info">{ar ? "دخل المبيعات قبل الإلغاء" : "Imported before cancellation"}</Badge>}
                <Badge tone={stockOk ? "good" : sale ? "warn" : "neutral"}>
                  {stockOk ? (cancelledUpstream ? (ar ? `لسه متخصم ${moved} قطعة لحين المرتجع` : `${moved} units still deducted pending return`) : (ar ? `اتخصم ${moved} قطعة` : `${moved} units deducted`)) : sale ? (ar ? "راجع حركة المخزون" : "Check stock movement") : (ar ? "لم يُخصم مخزون" : "No stock deducted")}
                </Badge>
                {event && <Badge tone={event.status === "FAILED" ? "bad" : "neutral"}>{event.status}</Badge>}
                {sale && <span className="num">{sale.orderNumber} · {sale.status}</span>}
                {shopUrl && <a href={shopUrl} target="_blank" rel="noopener noreferrer" className="underline">{ar ? "افتحه في Shopify" : "Open in Shopify"}</a>}
              </div>
              {(exception || event?.lastError) && (!sale || cancelledUpstream) && (
                <p className="mb-2 text-sm text-bad">{exception?.reason ?? event?.lastError}</p>
              )}
              <details className="text-sm">
                <summary className="cursor-pointer underline">{ar ? "تفاصيل الأوردر" : "Order details"}</summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div>
                    <p>{ar ? "رقم Shopify" : "Shopify ID"}: <code dir="ltr">{id}</code></p>
                    <p>{ar ? "الدفع" : "Payment"}: {snapshot?.financial_status ?? "—"}</p>
                    <p>{ar ? "التجهيز والشحن" : "Fulfillment"}: {snapshot?.fulfillment_status ?? (snapshot ? (ar ? "لسه" : "Unfulfilled") : "—")}</p>
                    <p>{ar ? "إجمالي Shopify" : "Shopify total"}: {snapshot?.total_price ? shopifyMoney(snapshot.total_price) : "—"}</p>
                    <p>{ar ? "العميل" : "Customer"}: {sale?.customer?.name ?? snapshot?.customer?.first_name ?? "—"}</p>
                    <p>{ar ? "التليفون" : "Phone"}: {snapshot?.shipping_address?.phone ?? snapshot?.customer?.phone ?? sale?.shippingPhone ?? "—"}</p>
                    <p>{ar ? "الشحن إلى" : "Ships to"}: {[address?.name, address?.address1, address?.address2, address?.city, address?.province].filter(Boolean).join(" · ") || "—"}</p>
                  </div>
                  <div>
                    <p className="mb-1 font-medium">{ar ? "الأصناف" : "Items"}</p>
                    {lines.length ? (
                      <ul className="space-y-1">
                        {lines.map((line) => <li key={line.id}>
                          <code dir="ltr">{line.sku || "—"}</code> · {line.title || "—"}{line.variant_title && line.variant_title !== "Default Title" ? ` · ${line.variant_title}` : ""} · ×{line.quantity} · {shopifyMoney(line.price)}
                        </li>)}
                      </ul>
                    ) : sale ? <ul>{sale.lines.map((line) => <li key={line.id}>{line.variant.sku} · ×{line.quantity}</li>)}</ul> : "—"}
                    {sale && <p className="mt-2">{ar ? "إجمالي البيع" : "Sale total"}: {formatMoney(Number(sale.netAmount) + Number(sale.shippingAmount), locale)}</p>}
                  </div>
                </div>
              </details>
            </Card>
          );
        })}
        {visibleOrders.length === 0 && <Card title={ar ? "لا توجد أوردرات مطابقة" : "No matching orders"}>{orders.length === 0 ? (ar ? "لم تصل أوردرات من Shopify لهذا الربط." : "No Shopify orders have reached this connection.") : (ar ? "غيّر البحث أو حالة الأوردر." : "Try a different search or status.")}</Card>}
      </div>
    </>
  );
}
