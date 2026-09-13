import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getPrefs } from "@/lib/session";
import { can } from "@/core/permissions";
import { db } from "@/lib/db";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber } from "@/lib/money";
import {
  readyToShip, shipmentBatches, shipmentsNeedingAttention, courierOwesUs, courierZones, MG_EXPRESS,
} from "@/lib/shipping";
import { ReadyToShipForm, ReportUploadForm, DestinationForm } from "./shipping-forms";

/**
 * الشحن — handing the day's parcels to MG Express and hearing back.
 *
 * The courier has no API. It imports a sheet in its own template and exports
 * an orders report, so this screen makes the one and reads the other: nobody
 * retypes an order that is already in the system, and nobody reads the
 * courier's portal row by row to find out what was delivered.
 */
export default async function ShippingPage() {
  const session = await requirePermission("sales_order:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const mayShip = can(session.role, "sales_order:create");

  const [ready, batches, attention, owed, zones, zoneGroups] = await Promise.all([
    readyToShip(),
    shipmentBatches(),
    shipmentsNeedingAttention(),
    courierOwesUs(),
    db.courierZone.count({ where: { courier: MG_EXPRESS, isActive: true } }),
    courierZones(),
  ]);

  const shippable = ready.filter((o) => o.problems.length === 0);
  const blocked = ready.length - shippable.length;
  const statusLabel: Record<string, string> = ar
    ? {
        NEEDS_REVIEW: "محتاجة مراجعة", RETURNED: "راجعة", FAILED: "فشل التسليم",
      }
    : { NEEDS_REVIEW: "Review", RETURNED: "Returning", FAILED: "Failed" };

  return (
    <>
      <PageHeader
        title={ar ? "الشحن" : "Shipping"}
        subtitle={
          ar
            ? "شيت MG Express بيطلع من هنا جاهز للرفع، وتقريرهم بيرجع هنا يحدّث كل أوردر"
            : "MG Express sheets come out of here ready to upload, and their report comes back in to update every order"
        }
      />

      {zones === 0 && (
        <div className="mb-4 rounded-lg border border-warn/30 bg-warn/5 p-3 text-sm">
          <strong>{ar ? "مناطق MG لسه ماتحمّلتش." : "MG's delivery areas are not loaded yet."}</strong>{" "}
          {ar
            ? "من غيرها مفيش أوردر يقدر يتشحن. شغّل scripts/import-courier-zones.ts مرة واحدة على السيرفر."
            : "No order can ship without them. Run scripts/import-courier-zones.ts once on the server."}
        </div>
      )}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={ar ? "جاهز يتشحن" : "Ready to ship"}
          value={formatNumber(shippable.length, locale)}
          hint={blocked > 0 ? (ar ? `${blocked} ناقصهم بيانات` : `${blocked} missing details`) : undefined}
          tone={blocked > 0 ? "warn" : "neutral"}
        />
        <StatTile
          label={ar ? "محتاجة متابعة" : "Needs attention"}
          value={formatNumber(attention.length, locale)}
          tone={attention.length > 0 ? "bad" : "good"}
        />
        <StatTile
          label={ar ? "MG اتسلّم" : "Delivered by MG"}
          value={formatNumber(owed.parcels, locale)}
          hint={ar ? `اتحصّل ${formatMoney(owed.collected, locale)}` : `${formatMoney(owed.collected, locale)} collected`}
        />
        <StatTile
          label={ar ? "مستحق لنا عند MG" : "MG owes us"}
          value={formatMoney(owed.outstanding, locale)}
          hint={ar ? `بعد شحن ${formatMoney(owed.fees, locale)}` : `after ${formatMoney(owed.fees, locale)} in fees`}
          tone={Number(owed.outstanding) > 0 ? "warn" : "neutral"}
        />
      </div>

      {mayShip && (
        <Card
          className="mb-4"
          title={ar ? "شحنات النهاردة" : "Today's parcels"}
          description={
            ar
              ? "علّم اللي هيطلع، واعمل الشيت. لكل فرع ملف لوحده — ارفع كل واحد على موقع MG من «تسجيل من الاكسيل» واختار نفس الفرع وعلّم «شامل الشحن»."
              : "Tick what is going out and make the sheets. One file per branch — upload each on MG's site under «تسجيل من الاكسيل», choose the same branch and tick «شامل الشحن»."
          }
        >
          {ready.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-400">
              {ar ? "مفيش أوردرات مستنية تتشحن." : "Nothing is waiting to ship."}
            </p>
          ) : (
            <ReadyToShipForm ar={ar} orders={ready} />
          )}
        </Card>
      )}

      {mayShip && blocked > 0 && zones > 0 && (
        <Card
          className="mb-4"
          title={ar ? "ناقصهم بيانات" : "Missing details"}
          description={
            ar
              ? "غالبًا أوردرات الموقع: العميل كاتب المدينة بطريقته، واختار منطقة MG الصح مرة واحدة."
              : "Mostly website orders: the customer typed the city their own way. Pick MG's area once."
          }
        >
          <div className="space-y-2">
            {ready
              .filter((o) => o.problems.length > 0)
              .map((o) => (
                <DestinationForm key={o.id} ar={ar} order={o} zones={zoneGroups} />
              ))}
          </div>
        </Card>
      )}

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        {mayShip && (
          <Card
            title={ar ? "حدّث من تقرير MG" : "Update from MG's report"}
            description={
              ar
                ? "من موقع MG: «تقرير الاوردرات» ← اختار الفترة ← «تصدير Excel»، وارفعه هنا. رفع نفس التقرير مرتين مابيغيّرش حاجة."
                : "On MG's site: «تقرير الاوردرات» → choose the dates → «تصدير Excel», and upload it here. The same report twice changes nothing."
            }
          >
            <ReportUploadForm ar={ar} />
          </Card>
        )}

        <Card
          title={ar ? "محتاجة متابعة" : "Needs attention"}
          description={
            ar
              ? "المرتجع بيتسجّل من شاشة المرتجعات لما القطعة توصل فعلًا — مش من كلمة في تقرير الشركة."
              : "A return is recorded at the returns desk when the garment actually arrives — not from a word in the courier's report."
          }
        >
          {attention.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-400">{ar ? "مفيش حاجة." : "Nothing."}</p>
          ) : (
            <DataTable
              headers={[ar ? "الأوردر" : "Order", ar ? "المستلم" : "Recipient", ar ? "MG قالت" : "MG says", ""]}
              rows={attention.map((a) => [
                <span key="o" className="num text-xs" dir="ltr">{a.orderNumber}</span>,
                <span key="r">{a.recipient ?? "—"}</span>,
                <span key="s">
                  <Badge tone={a.status === "RETURNED" ? "warn" : "bad"}>{statusLabel[a.status] ?? a.status}</Badge>
                  <span className="ms-2 text-xs text-ink-500">{a.courierStatus}</span>
                  {a.followUp && <span className="block text-xs text-ink-400">{a.followUp}</span>}
                </span>,
                <Link
                  key="l"
                  href={`/returns?order=${encodeURIComponent(a.orderNumber)}`}
                  className="text-xs text-rose-deep underline"
                >
                  {ar ? "المرتجعات" : "Returns"}
                </Link>,
              ])}
            />
          )}
        </Card>
      </div>

      <Card title={ar ? "الشيتات" : "Sheets"}>
        {batches.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-400">{ar ? "لسه مفيش شيتات." : "No sheets yet."}</p>
        ) : (
          <DataTable
            headers={[
              ar ? "الشيت" : "Sheet",
              ar ? "الفرع" : "Branch",
              ar ? "التاريخ" : "Date",
              ar ? "أوردرات" : "Parcels",
              ar ? "اتسلّم" : "Delivered",
              ar ? "لسه" : "Open",
              ar ? "يتحصّل" : "COD",
              "",
            ]}
            rows={batches.map((b) => [
              <span key="n" className="num text-xs" dir="ltr">{b.batchNumber}</span>,
              <span key="b">{b.branch}</span>,
              <span key="d" className="num text-xs" dir="ltr">{b.createdAt.toISOString().slice(0, 10)}</span>,
              <span key="p" className="num">{formatNumber(b.parcels, locale)}</span>,
              <span key="dl" className="num text-good">{formatNumber(b.delivered, locale)}</span>,
              <span key="op" className="num">{formatNumber(b.open, locale)}</span>,
              <span key="c" className="num">{formatMoney(b.cod, locale)}</span>,
              <a key="x" href={`/shipping/batches/${b.id}/manifest`} className="text-xs text-rose-deep underline">
                {ar ? "نزّل" : "Download"}
              </a>,
            ])}
          />
        )}
      </Card>
    </>
  );
}
