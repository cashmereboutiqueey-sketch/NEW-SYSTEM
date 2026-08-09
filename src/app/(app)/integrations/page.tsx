import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { EntityForm } from "@/components/entity-form";
import { formatNumber } from "@/lib/money";
import { inventoryToPublish } from "@/lib/shopify";
import {
  connectShopifyAction, pullOrdersAction, resolveExceptionAction,
} from "./actions";

/**
 * التكاملات — external connections.
 *
 * Shopify is authoritative for what happened on the website and nothing more.
 * Imported orders become internal sales through the same service a cashier
 * uses, so they relieve the same stock and post the same journals.
 *
 * Anything that cannot be matched with certainty waits here for a person.
 */
export default async function IntegrationsPage() {
  await requirePermission("settings:manage");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const [connections, exceptions, recentSyncs, publishable] = await Promise.all([
    db.integrationConnection.findMany({ orderBy: { createdAt: "asc" } }),
    db.integrationException.findMany({
      where: { status: "OPEN" },
      orderBy: { createdAt: "desc" },
      take: 25,
    }),
    db.syncLog.findMany({
      include: { connection: true },
      orderBy: { startedAt: "desc" },
      take: 10,
    }),
    inventoryToPublish().catch(() => []),
  ]);

  const shopify = connections.find((c) => c.provider === "SHOPIFY");
  const unlinked = publishable.filter((p) => !p.linked);

  return (
    <>
      <PageHeader
        title={ar ? "التكاملات" : "Integrations"}
        subtitle={
          ar
            ? "الموقع مرجع لما حصل عليه فقط — الطلب المستورد بيدخل نفس محرك البيع"
            : "The website is authoritative for what happened on it, and nothing else — an imported order enters the same sales engine"
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatTile
          label={ar ? "حالة الربط" : "Connection"}
          value={
            shopify
              ? shopify.isActive
                ? ar ? "متصل" : "Connected"
                : ar ? "موقوف" : "Paused"
              : ar ? "غير مربوط" : "Not connected"
          }
          tone={shopify?.isActive ? "good" : "neutral"}
          hint={shopify?.lastSyncedAt
            ? `${ar ? "آخر مزامنة" : "last sync"} ${shopify.lastSyncedAt.toISOString().slice(0, 16).replace("T", " ")}`
            : undefined}
        />
        <StatTile
          label={ar ? "تحتاج مراجعة" : "Needing attention"}
          value={formatNumber(exceptions.length, locale)}
          tone={exceptions.length > 0 ? "bad" : "good"}
        />
        <StatTile
          label={ar ? "أكواد غير مربوطة" : "SKUs not linked"}
          value={formatNumber(unlinked.length, locale)}
          tone={unlinked.length > 0 ? "warn" : "good"}
          hint={ar ? "موجودة عندنا ومش متربطة بالموقع" : "In stock here, unlinked on the website"}
        />
      </div>

      {/* ------------------------------------------------------ exceptions */}
      {exceptions.length > 0 && (
        <Card
          className="mb-4"
          title={ar ? "طلبات لم تُستورد" : "Orders that were not imported"}
          description={
            ar
              ? "النظام مابيخمّنش الموديل المقصود — تخمين غلط يخصم من مخزون قطعة تانية"
              : "The system does not guess which garment was meant — a wrong guess relieves the wrong stock"
          }
        >
          <DataTable
            headers={[
              ar ? "المصدر" : "Source",
              ar ? "الرقم الخارجي" : "External id",
              ar ? "السبب" : "Reason",
              ar ? "التاريخ" : "Raised",
              "",
            ]}
            rows={exceptions.map((e) => [
              <Badge key={`${e.id}-p`} tone="neutral">{e.provider}</Badge>,
              <code key={`${e.id}-x`} dir="ltr" className="text-xs text-ink-500">
                {e.externalId ?? "—"}
              </code>,
              <span key={`${e.id}-r`} className="text-sm">{e.reason}</span>,
              <span key={`${e.id}-d`} className="num" dir="ltr">
                {e.createdAt.toISOString().slice(0, 10)}
              </span>,
              <form key={`${e.id}-a`} action={resolveExceptionAction} className="flex gap-1">
                <input type="hidden" name="id" value={e.id} />
                <input type="hidden" name="status" value="RESOLVED" />
                <input
                  name="note"
                  placeholder={ar ? "ماذا تم" : "What was done"}
                  className="w-36 rounded-lg border border-ink-200 px-2 py-1 text-xs"
                />
                <button
                  type="submit"
                  className="rounded-lg border border-ink-300 px-2 py-1 text-xs text-ink-700"
                >
                  {ar ? "تم" : "Close"}
                </button>
              </form>,
            ])}
          />
        </Card>
      )}

      {/* --------------------------------------------------------- connect */}
      <Card
        className="mb-4"
        title={ar ? "ربط متجر Shopify" : "Connect a Shopify shop"}
        description={
          ar
            ? "التوكن بيتخزّن في قاعدة البيانات ومابيرجعش للمتصفح أبدًا"
            : "The token is stored in the database and never returned to the browser"
        }
      >
        <EntityForm
          locale={locale}
          action={connectShopifyAction}
          submitEn={shopify ? "Update connection" : "Connect"}
          submitAr={shopify ? "تحديث الربط" : "اربط"}
          fields={[
            {
              kind: "text", name: "shopDomain", labelEn: "Shop domain", labelAr: "دومين المتجر",
              required: true, ltr: true, placeholder: "cashmere.myshopify.com",
              defaultValue: shopify?.externalRef ?? null,
              hintEn: "The .myshopify.com address, not the public one.",
              hintAr: "عنوان myshopify.com مش العنوان اللي الزباين بيشوفوه.",
            },
            {
              kind: "text", name: "displayName", labelEn: "Name", labelAr: "الاسم",
              defaultValue: shopify?.displayName ?? "Cashmere Boutique",
            },
            {
              kind: "text", name: "accessToken", labelEn: "Admin API access token", labelAr: "توكن الوصول",
              ltr: true, placeholder: shopify?.accessToken ? "••••••••" : "shpat_…",
              hintEn: "Leave blank to keep the stored one.",
              hintAr: "سيبه فاضي عشان تحتفظ بالمخزّن.",
            },
            {
              kind: "text", name: "webhookSecret", labelEn: "Webhook signing secret", labelAr: "سر توقيع الويب هوك",
              ltr: true, placeholder: shopify?.webhookSecret ? "••••••••" : "",
              hintEn: "Without this, unsigned payloads are rejected and nothing arrives automatically.",
              hintAr: "من غيره أي طلب غير موقّع بيترفض ومش هيوصل حاجة أوتوماتيك.",
            },
          ]}
        />

        {shopify && (
          <div className="mt-4 border-t border-ink-100 pt-4">
            <p className="mb-2 text-xs text-ink-500">
              {ar
                ? `عنوان الويب هوك: /api/webhooks/shopify — سجّله في Shopify لأحداث orders/create و orders/paid.`
                : `Webhook URL: /api/webhooks/shopify — register it in Shopify for orders/create and orders/paid.`}
            </p>
            <EntityForm
              locale={locale}
              action={pullOrdersAction}
              hidden={{ connectionId: shopify.id }}
              columns={2}
              submitEn="Pull orders now"
              submitAr="اسحب الطلبات الآن"
              fields={[
                {
                  kind: "number", name: "sinceDays", labelEn: "Look back (days)", labelAr: "الرجوع كام يوم",
                  defaultValue: 7, min: "1", max: "60", ltr: true,
                  hintEn: "Re-pulling is safe — an order already imported is skipped.",
                  hintAr: "السحب تاني آمن — الطلب المستورد قبل كده بيتخطّى.",
                },
              ]}
            />
          </div>
        )}
      </Card>

      {/* ----------------------------------------------------- sync history */}
      <Card
        className="mb-4"
        title={ar ? "سجل المزامنة" : "Sync history"}
        description={
          ar
            ? "كل محاولة متسجّلة، فالطلب الناقص ممكن يترجع لأصله"
            : "Every attempt is recorded, so a missing order can be traced to the run that should have brought it"
        }
      >
        {recentSyncs.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-400">
            {ar ? "لا توجد مزامنات بعد." : "No syncs yet."}
          </p>
        ) : (
          <DataTable
            headers={[
              ar ? "المتجر" : "Shop",
              ar ? "النوع" : "Object",
              ar ? "معالَج" : "Processed",
              ar ? "جديد" : "Created",
              ar ? "مكرر" : "Duplicates",
              ar ? "فشل" : "Failed",
              ar ? "الحالة" : "Status",
              ar ? "الوقت" : "When",
            ]}
            rows={recentSyncs.map((s) => [
              <span key={`${s.id}-c`} className="text-sm">{s.connection.displayName}</span>,
              <span key={`${s.id}-o`} className="text-sm">{s.objectType}</span>,
              <span key={`${s.id}-p`} className="num">{s.processed}</span>,
              <span key={`${s.id}-cr`} className="num text-good">{s.created}</span>,
              <span key={`${s.id}-d`} className="num text-ink-500">{s.duplicates}</span>,
              <span key={`${s.id}-f`} className={s.failed > 0 ? "num text-bad" : "num"}>
                {s.failed}
              </span>,
              <Badge
                key={`${s.id}-s`}
                tone={s.status === "SUCCESS" ? "good" : s.status === "PARTIAL" ? "warn" : "bad"}
              >
                {s.status}
              </Badge>,
              <span key={`${s.id}-t`} className="num" dir="ltr">
                {s.startedAt.toISOString().slice(0, 16).replace("T", " ")}
              </span>,
            ])}
          />
        )}
      </Card>

      <Card
        title={ar ? "المخزون المتاح للنشر" : "Stock available to publish"}
        description={
          ar
            ? "العرض فقط — رفع الكميات للموقع قرار بيتاخد لوحده، لأنه ممكن يبيع حاجة مش موجودة"
            : "Read-only — pushing quantities to a live shop is its own decision, because it can oversell"
        }
      >
        {publishable.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-400">
            {ar ? "لا يوجد مخزون في معرض الإسكندرية." : "No stock at the Alexandria showroom."}
          </p>
        ) : (
          <DataTable
            headers={[
              "SKU",
              ar ? "الموديل" : "Style",
              ar ? "المتاح" : "Available",
              ar ? "مربوط بالموقع" : "Linked",
            ]}
            rows={publishable.slice(0, 50).map((p) => [
              <code key={`${p.sku}-s`} dir="ltr" className="text-xs">{p.sku}</code>,
              <code key={`${p.sku}-st`} dir="ltr" className="text-xs text-ink-500">{p.style}</code>,
              <span key={`${p.sku}-a`} className="num">{formatNumber(p.available, locale)}</span>,
              <Badge key={`${p.sku}-l`} tone={p.linked ? "good" : "warn"}>
                {p.linked ? (ar ? "مربوط" : "Linked") : (ar ? "غير مربوط" : "Not linked")}
              </Badge>,
            ])}
          />
        )}
      </Card>
    </>
  );
}
