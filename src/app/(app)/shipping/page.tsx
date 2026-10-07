import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getPrefs } from "@/lib/session";
import { can } from "@/core/permissions";
import { db } from "@/lib/db";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber } from "@/lib/money";
import {
  readyToShip, shipmentBatches, recentFlextockApiShipments, shipmentsNeedingAttention, courierOwesUs, courierZones, FLEXTOCK,
} from "@/lib/shipping";
import { ReadyToShipForm, DestinationForm, RefreshFlextockButton } from "./shipping-forms";
import { CourierZoneCreate } from "@/components/courier-zone-create";
import { flextockApiEnabled } from "@/lib/flextock-api";

/** Flextock delivery desk. Cashmere keeps stock and prepares each parcel. */
export default async function ShippingPage() {
  const session = await requirePermission("sales_order:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const mayShip = can(session.role, "sales_order:create");
  const apiEnabled = flextockApiEnabled();

  const [ready, batches, attention, owed, zones, zoneGroups, apiShipments] = await Promise.all([
    readyToShip(),
    shipmentBatches(),
    shipmentsNeedingAttention(),
    courierOwesUs(),
    db.courierZone.count({ where: { courier: FLEXTOCK, isActive: true } }),
    courierZones(),
    apiEnabled ? recentFlextockApiShipments() : Promise.resolve([]),
  ]);

  const shippable = ready.filter((o) => o.problems.length === 0);
  const blocked = ready.length - shippable.length;
  const statusLabel: Record<string, string> = ar
    ? { NEEDS_REVIEW: "محتاجة مراجعة", RETURNED: "راجعة", FAILED: "فشل التسليم" }
    : { NEEDS_REVIEW: "Review", RETURNED: "Returning", FAILED: "Failed" };

  return (
    <>
      <PageHeader
        title={ar ? "الشحن مع Flextock" : "Flextock shipping"}
        subtitle={ar
          ? "جهّز الأوردر هنا، وسجّل تسليمه بعد ما Flextock تقبله"
          : "Prepare orders here and record the handoff after Flextock accepts them"}
      />

      <div className="mb-4 rounded-lg border border-warn/30 bg-warn/5 p-3 text-sm text-ink-700">
        {ar
          ? apiEnabled
            ? "الربط مع Flextock مفعل للشحن فقط. النظام يرسل بيانات المنتجات المطلوبة للشحنة من غير مزامنة المخزون، ويسجل التسليم بعد قبول الأوردر."
            : "كود الربط مع Flextock جاهز، لكنه غير مفعل لحد وصول بيانات الحساب والمناطق المعتمدة. سجّل التسليم يدويًا فقط بعد تأكيد Flextock قبول الأوردر."
          : apiEnabled
            ? "Flextock delivery API is enabled. Required SKU details are sent without inventory sync; handoff is recorded after order acceptance."
            : "The Flextock API connector is prepared but disabled until account credentials and approved areas arrive. Record a manual handoff only after Flextock accepts the order."}
      </div>

      {zones === 0 && (
        <div className="mb-4 rounded-lg border border-warn/30 bg-warn/5 p-3 text-sm">
          {ar
            ? "مفيش مناطق Flextock مؤكدة لسه. أضف المناطق والأسعار المؤكدة قبل تسجيل تسليم أوردر."
            : "No confirmed Flextock delivery areas yet. Add confirmed areas and rates before recording a handoff."}
        </div>
      )}

      {mayShip && (
        <Card className="mb-4" title={ar ? "مناطق الشحن" : "Delivery areas"}
          description={ar ? `${zones} منطقة Flextock متاحة.` : `${zones} Flextock areas available.`}>
          <CourierZoneCreate ar={ar} />
        </Card>
      )}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label={ar ? "جاهز للشحن" : "Ready to ship"}
          value={formatNumber(shippable.length, locale)}
          hint={blocked > 0 ? (ar ? `${blocked} ناقصهم بيانات` : `${blocked} missing details`) : undefined}
          tone={blocked > 0 ? "warn" : "neutral"} />
        <StatTile label={ar ? "محتاجة متابعة" : "Needs attention"}
          value={formatNumber(attention.length, locale)} tone={attention.length > 0 ? "bad" : "good"} />
        <StatTile label={ar ? "اتسلّمت" : "Delivered"}
          value={formatNumber(owed.parcels, locale)}
          hint={ar ? `تحصيل مؤكد ${formatMoney(owed.collected, locale)}` : `${formatMoney(owed.collected, locale)} confirmed collected`} />
        <StatTile label={ar ? "مستحق مؤكد عند Flextock" : "Confirmed due from Flextock"}
          value={formatMoney(owed.outstanding, locale)}
          hint={owed.unreconciled > 0
            ? (ar ? `${owed.unreconciled} شحنة مستنية كشف تحصيل` : `${owed.unreconciled} parcels await a collection report`)
            : ar ? `بعد شحن ${formatMoney(owed.fees, locale)}` : `after ${formatMoney(owed.fees, locale)} in fees`}
          tone={Number(owed.outstanding) > 0 ? "warn" : "neutral"} />
      </div>

      {mayShip && (
        <Card className="mb-4" title={ar ? "أوردرات جاهزة" : "Orders ready for handoff"}
          description={ar
            ? apiEnabled
              ? "اختار لحد 10 أوردرات لإرسالها لـ Flextock. الطلبات المدفوعة جزئيًا هتتبعت برصيد التحصيل الصحيح."
              : "اختار الأوردرات اللي Flextock قبلتها بالفعل، ثم سجّل التسليم. تسجيل التسليم لا يرسل بيانات للشركة."
            : apiEnabled
              ? "Select up to 10 orders to send to Flextock. Part-paid orders include the correct COD balance."
              : "Select orders Flextock has already accepted, then record the handoff. Recording does not send data to Flextock."}>
          {ready.length === 0
            ? <p className="py-6 text-center text-sm text-ink-400">{ar ? "مفيش أوردرات مستنية." : "Nothing is waiting to ship."}</p>
            : <ReadyToShipForm ar={ar} orders={ready} apiEnabled={apiEnabled} />}
        </Card>
      )}

      {mayShip && apiEnabled && <RefreshFlextockButton ar={ar} />}

      {apiEnabled && apiShipments.length > 0 && (
        <Card className="mb-4" title={ar ? "شحنات Flextock عبر الـAPI" : "Flextock API shipments"}>
          <DataTable headers={[ar ? "الأوردر" : "Order", ar ? "الحالة" : "Status", ar ? "التتبع" : "Tracking"]}
            rows={apiShipments.map((shipment) => [
              <span key="order" className="num text-xs" dir="ltr">{shipment.reference}</span>,
              <span key="status" className="text-xs">{shipment.courierStatus || shipment.status}</span>,
              shipment.trackingUrl
                ? <a key="tracking" href={shipment.trackingUrl} target="_blank" rel="noopener noreferrer"
                    className="text-xs text-rose-deep underline" dir="ltr">{shipment.trackingNumber || (ar ? "رابط التتبع" : "Track parcel")}</a>
                : <span key="tracking" className="num text-xs" dir="ltr">{shipment.trackingNumber || "—"}</span>,
            ])} />
        </Card>
      )}

      {mayShip && blocked > 0 && zones > 0 && (
        <Card className="mb-4" title={ar ? "ناقصهم بيانات" : "Missing details"}
          description={ar ? "صحّح عنوان العميل واختار منطقة Flextock المؤكدة." : "Correct the destination and choose a confirmed Flextock area."}>
          <div className="space-y-2">
            {ready.filter((o) => o.problems.length > 0).map((o) =>
              <DestinationForm key={o.id} ar={ar} order={o} zones={zoneGroups} />)}
          </div>
        </Card>
      )}

      <Card className="mb-4" title={ar ? "محتاجة متابعة" : "Needs attention"}
        description={ar
          ? "المرتجع بيتسجل من شاشة المرتجعات بعد وصول القطعة فعليًا."
          : "Record a return at the returns desk after the garment actually arrives."}>
        {attention.length === 0
          ? <p className="py-6 text-center text-sm text-ink-400">{ar ? "مفيش حاجة." : "Nothing."}</p>
          : <DataTable headers={[ar ? "الأوردر" : "Order", ar ? "المستلم" : "Recipient", ar ? "الحالة" : "Status", ""]}
              rows={attention.map((a) => [
                <span key="o" className="num text-xs" dir="ltr">{a.orderNumber}</span>,
                <span key="r">{a.recipient ?? "—"}</span>,
                <span key="s"><Badge tone={a.status === "RETURNED" ? "warn" : "bad"}>{statusLabel[a.status] ?? a.status}</Badge>
                  {a.courierStatus && <span className="ms-2 text-xs text-ink-500">{a.courierStatus}</span>}
                  {a.followUp && <span className="block text-xs text-ink-400">{a.followUp}</span>}
                </span>,
                <Link key="l" href={`/returns?order=${encodeURIComponent(a.orderNumber)}`}
                  className="text-xs text-rose-deep underline">{ar ? "المرتجعات" : "Returns"}</Link>,
              ])} />}
      </Card>

      <Card title={ar ? "تسليمات Flextock" : "Flextock handoffs"}>
        {batches.length === 0
          ? <p className="py-6 text-center text-sm text-ink-400">{ar ? "لسه مفيش تسليمات." : "No handoffs yet."}</p>
          : <DataTable headers={[ar ? "الدفعة" : "Batch", ar ? "التاريخ" : "Date", ar ? "أوردرات" : "Parcels", ar ? "اتسلّم" : "Delivered", ar ? "لسه" : "Open", ar ? "يتحصّل" : "COD"]}
              rows={batches.map((b) => [
                <span key="n" className="num text-xs" dir="ltr">{b.batchNumber}</span>,
                <span key="d" className="num text-xs" dir="ltr">{b.createdAt.toISOString().slice(0, 10)}</span>,
                <span key="p" className="num">{formatNumber(b.parcels, locale)}</span>,
                <span key="dl" className="num text-good">{formatNumber(b.delivered, locale)}</span>,
                <span key="op" className="num">{formatNumber(b.open, locale)}</span>,
                <span key="c" className="num">{formatMoney(b.cod, locale)}</span>,
              ])} />}
      </Card>
    </>
  );
}
