import { requirePermission } from "@/lib/auth";
import { getPrefs } from "@/lib/session";
import { can } from "@/core/permissions";
import {
  recentOrdersForReturn,
  recentReturns,
  returnRateByStyle,
  returnWindowDays,
} from "@/lib/returns";
import { PageHeader, Card, DataTable, StatTile, Badge } from "@/components/ui";
import { formatMoney, formatNumber, dec } from "@/lib/money";
import { ReturnDesk } from "./return-desk";

/**
 * المرتجعات — a customer brings a garment back.
 *
 * A shop takes returns every week. Without a screen they happen on paper, and
 * two things drift at once: the stock says a garment was sold that is hanging
 * on the rail, and the cash says money went out that no document explains.
 *
 * The return rate by style is here rather than buried in a report because it
 * is usually saying something specific — the sizing runs small, the colour
 * photographs differently — and that is worth knowing before the next
 * production run, not after it.
 */
export default async function ReturnsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await requirePermission("sales_order:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const params = await searchParams;

  const mayRefund = can(session.role, "sales_order:refund");

  const [orders, returns, rates, windowDays] = await Promise.all([
    recentOrdersForReturn(params.q ?? null),
    recentReturns(),
    returnRateByStyle(),
    returnWindowDays(),
  ]);

  const refunded = returns.reduce((s, r) => s.plus(dec(r.refundAmount)), dec(0));
  const unitsBack = returns.reduce((s, r) => s + r.quantity, 0);
  const writtenOff = returns.filter((r) => r.disposition === "WRITE_OFF").length;

  const dateText = (d: Date) => new Date(d).toISOString().slice(0, 10);

  const dispositionLabel = (d: string) =>
    ar
      ? { RESTOCK: "رجعت المخزن", WRITE_OFF: "اتشالت", REPAIR_AND_RESTOCK: "تصليح ورجوع" }[d] ?? d
      : { RESTOCK: "restocked", WRITE_OFF: "written off", REPAIR_AND_RESTOCK: "repaired" }[d] ?? d;

  return (
    <>
      <PageHeader
        title={ar ? "المرتجعات" : "Returns"}
        subtitle={
          ar
            ? `الزبون بيرجّع حاجة. مهلة الاسترجاع ${windowDays} يوم.`
            : `A customer brings something back. The return window is ${windowDays} days.`
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatTile
          label={ar ? "قطع رجعت" : "Garments back"}
          value={formatNumber(unitsBack)}
          hint={`${returns.length} ${ar ? "مرتجع" : "returns"}`}
          tone={unitsBack > 0 ? "warn" : "good"}
        />
        <StatTile
          label={ar ? "فلوس رجعت" : "Refunded"}
          value={formatMoney(refunded.toString())}
          tone={refunded.greaterThan(0) ? "bad" : "good"}
        />
        <StatTile
          label={ar ? "مارجعتش المخزن" : "Not resellable"}
          value={formatNumber(writtenOff)}
          hint={ar ? "اتقيدت خسارة" : "written off"}
          tone={writtenOff > 0 ? "bad" : "good"}
        />
      </div>

      {mayRefund && (
        <div className="mb-5">
          <Card
            title={ar ? "استلام مرتجع" : "Take a return"}
            description={
              ar
                ? "دوّر على الطلب برقمه أو باسم الزبون أو تليفونه، وبعدين اختار اللي راجع."
                : "Find the order by its number, the customer's name or their phone."
            }
          >
            <ReturnDesk
              ar={ar}
              initialQuery={params.q ?? ""}
              orders={orders.map((o) => ({
                id: o.id,
                orderNumber: o.orderNumber,
                orderDate: dateText(o.orderDate),
                customerName: o.customerName,
                customerPhone: o.customerPhone,
                netAmount: o.netAmount,
                units: o.units,
                returnedUnits: o.returnedUnits,
                fullyReturned: o.fullyReturned,
              }))}
            />
          </Card>
        </div>
      )}

      <div className="mb-5">
        <Card title={ar ? "اللي رجع" : "What has come back"}>
          <DataTable
            headers={[
              ar ? "المرتجع" : "Return",
              ar ? "الطلب" : "Order",
              ar ? "الزبون" : "Customer",
              ar ? "الصنف" : "Item",
              ar ? "عدد" : "Qty",
              ar ? "المرتجع فلوس" : "Refunded",
              ar ? "راح فين" : "Outcome",
              ar ? "السبب" : "Reason",
            ]}
            empty={ar ? "محدش رجّع حاجة لسه" : "Nothing has come back yet"}
            rows={returns.map((r) => [
              <span key="n" className="num text-xs" dir="ltr">{r.returnNumber}</span>,
              <span key="o" className="num text-xs" dir="ltr">{r.orderNumber}</span>,
              r.customerName ?? "—",
              <span key="i" className="text-xs">
                {r.styleName} · {r.colour} · {r.size}
              </span>,
              <span key="q" className="num">{r.quantity}</span>,
              <span key="r" className="num">{formatMoney(r.refundAmount)}</span>,
              <Badge key="d" tone={r.disposition === "WRITE_OFF" ? "bad" : "good"}>
                {dispositionLabel(r.disposition)}
              </Badge>,
              <span key="w" className="text-xs text-ink-500">{r.reason ?? "—"}</span>,
            ])}
          />
        </Card>
      </div>

      <Card
        title={ar ? "أكتر موديلات بترجع" : "What comes back most"}
        description={
          ar
            ? "نسبة عالية معناها غالباً حاجة محددة — المقاسات ضيقة، أو الصورة بتوري لون تاني. أحسن تعرفها قبل التشغيلة الجاية."
            : "A high rate usually means something specific — the sizing runs small, the photograph flatters. Better known before the next run than after."
        }
      >
        <DataTable
          headers={[
            ar ? "الموديل" : "Style",
            ar ? "اتباع" : "Sold",
            ar ? "رجع" : "Returned",
            ar ? "النسبة" : "Rate",
          ]}
          empty={ar ? "مفيش مرتجعات" : "No returns"}
          rows={rates.map((r) => [
            r.styleName,
            <span key="s" className="num">{formatNumber(r.sold)}</span>,
            <span key="b" className="num">{formatNumber(r.returned)}</span>,
            <span
              key="r"
              className={Number(r.rate) >= 15 ? "num font-semibold text-bad" : "num"}
            >
              {r.rate}%
            </span>,
          ])}
        />
      </Card>

      <p className="mt-4 text-xs text-ink-500">
        {ar
          ? "القطعة بترجع المخزن بنفس التكلفة اللي خرجت بيها، وبتاريخ استلامها الأصلي — عشان المرتجع مايعملش ربح وهمي ولا يخفي إن البضاعة قديمة."
          : "A garment returns at the cost it left at and keeps its original receipt date, so a return cannot invent profit or launder how old the stock is."}
      </p>
    </>
  );
}
