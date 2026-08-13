import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { can } from "@/core/permissions";
import { cmtOrders, confirmableQuotes } from "@/lib/cmt-orders";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber, formatPercent, formatMinutes, dec } from "@/lib/money";
import { ConfirmForm, CompleteForm, CancelForm } from "./order-forms";

/**
 * أوامر التصنيع للغير — accepted quotes that became commitments.
 *
 * Accepting a quote used to be a status and nothing more. Nothing reserved the
 * minutes, so the factory could take on more external work than it had
 * capacity for while the capacity screen still showed it as free, and nothing
 * ever checked whether a run came in on the minutes it was priced at.
 *
 * The realised margin is the column that matters. A job quoted at 40 minutes a
 * garment that took 50 was not profitable at the rate agreed, and a factory
 * that cannot see that repeats the job that lost it money.
 */
export default async function CMTOrdersPage() {
  const session = await requirePermission("cmt_quote:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const [orders, quotes] = await Promise.all([cmtOrders(), confirmableQuotes()]);
  const mayManage = can(session.role, "cmt_quote:create");

  const open = orders.filter((o) => o.status === "CONFIRMED" || o.status === "IN_PRODUCTION");
  const done = orders.filter((o) => o.status === "COMPLETED");

  const committed = open.reduce((t, o) => t.plus(dec(o.totalMinutes)), dec(0));
  const contracted = open.reduce((t, o) => t.plus(dec(o.contractValue)), dec(0));
  const realised = done.reduce((t, o) => t.plus(dec(o.realisedMargin ?? 0)), dec(0));
  const overran = done.filter((o) => Number(o.minutesOverrun ?? 0) > 0);

  const statusLabel: Record<string, string> = ar
    ? {
        CONFIRMED: "مؤكد",
        IN_PRODUCTION: "تحت التنفيذ",
        COMPLETED: "اتقفل",
        CANCELLED: "اتلغى",
      }
    : {
        CONFIRMED: "Confirmed",
        IN_PRODUCTION: "In production",
        COMPLETED: "Closed",
        CANCELLED: "Cancelled",
      };

  const day = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : "—");

  return (
    <>
      <PageHeader
        title={ar ? "أوامر التصنيع للغير" : "CMT orders"}
        subtitle={
          ar
            ? "العروض المقبولة اللي بقت التزام — والدقايق المحجوزة عليها فعلًا"
            : "Accepted quotes that became commitments, and the capacity they actually hold"
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <StatTile
          label={ar ? "أوامر مفتوحة" : "Open orders"}
          value={formatNumber(open.length)}
          hint={`${formatNumber(quotes.length)} ${ar ? "عرض مستني" : "quotes waiting"}`}
        />
        <StatTile
          label={ar ? "دقايق محجوزة" : "Minutes committed"}
          value={formatMinutes(committed.toString())}
          hint={ar ? "مش متاحة لشغل تاني" : "not available for other work"}
          tone={committed.greaterThan(0) ? "info" : "neutral"}
        />
        <StatTile
          label={ar ? "قيمة التعاقدات" : "Contracted value"}
          value={formatMoney(contracted.toString())}
        />
        <StatTile
          label={ar ? "ربح محقق" : "Realised margin"}
          value={formatMoney(realised.toString())}
          hint={
            overran.length > 0
              ? `${formatNumber(overran.length)} ${ar ? "أمر زاد عن المتفق" : "overran"}`
              : ar ? "كله في حدود المتفق" : "all within the minutes sold"
          }
          tone={realised.greaterThan(0) ? "good" : realised.lessThan(0) ? "bad" : "neutral"}
        />
      </div>

      {mayManage && (
        <div className="mb-5">
          <Card
            title={ar ? "حوّل عرض مقبول لأمر" : "Turn an accepted quote into an order"}
            description={
              ar
                ? "تأكيد الأمر بيحجز دقايقه من طاقة الشهر — الطاقة بتتصرف فعلًا، وتسجيلها هو اللي بيخلي العرض الجاي صادق."
                : "Confirming books its minutes against the month. The capacity is spent either way; recording it is what keeps the next quote honest."
            }
          >
            <ConfirmForm ar={ar} quotes={quotes} />
          </Card>
        </div>
      )}

      {orders.length === 0 ? (
        <Card>
          <p className="py-8 text-center text-sm text-ink-400">
            {ar ? "لسه مفيش أوامر تصنيع." : "No CMT orders yet."}
          </p>
        </Card>
      ) : (
        <Card
          title={ar ? "الأوامر" : "Orders"}
          description={
            ar
              ? "«زيادة الدقايق» هي الفرق بين اللي اتباع واللي اتصرف فعلًا. دي اللي بتقول الشغلانة كانت مربحة ولا لأ."
              : "\"Overrun\" is the gap between the minutes sold and the minutes spent. It is what says whether the job actually paid."
          }
        >
          <DataTable
            headers={[
              ar ? "الأمر" : "Order",
              ar ? "العميل" : "Client",
              ar ? "الموديل" : "Style",
              ar ? "عدد" : "Qty",
              ar ? "دقايق متفقة" : "Minutes sold",
              ar ? "دقايق فعلية" : "Actual",
              ar ? "الزيادة" : "Overrun",
              ar ? "قيمة التعاقد" : "Contract",
              ar ? "التكلفة" : "Cost",
              ar ? "الربح" : "Margin",
              ar ? "الحالة" : "Status",
              "",
            ]}
            rows={orders.map((o) => [
              <span key="n" className="num text-xs" dir="ltr">{o.orderNumber}</span>,
              <span key="c" className="font-medium text-ink-900">{o.clientName}</span>,
              <span key="d" className="text-xs text-ink-600">{o.description}</span>,
              <span key="q" className="num">{formatNumber(o.quantity)}</span>,
              <span key="tm" className="num text-xs">{formatMinutes(o.totalMinutes)}</span>,
              <span key="am" className="num text-xs">
                {o.actualMinutes ? formatMinutes(o.actualMinutes) : "—"}
              </span>,
              o.overrunPct != null ? (
                <Badge key="ov" tone={Number(o.overrunPct) > 0 ? "bad" : "good"}>
                  {Number(o.overrunPct) > 0 ? "+" : ""}
                  {formatPercent(o.overrunPct)}
                </Badge>
              ) : (
                <span key="ov" className="text-ink-300">—</span>
              ),
              <span key="cv" className="num">{formatMoney(o.contractValue)}</span>,
              <span key="ac" className="num text-ink-500">
                {o.actualCost ? formatMoney(o.actualCost) : "—"}
              </span>,
              o.realisedMargin ? (
                <span
                  key="rm"
                  className={Number(o.realisedMargin) >= 0 ? "num font-medium text-good" : "num font-medium text-bad"}
                >
                  {formatMoney(o.realisedMargin)}
                  {o.marginPct && (
                    <span className="ms-1 text-xs text-ink-400">
                      {formatPercent(o.marginPct)}
                    </span>
                  )}
                </span>
              ) : (
                <span key="rm" className="text-ink-300">—</span>
              ),
              <Badge
                key="s"
                tone={
                  o.status === "COMPLETED" ? "good" : o.status === "CANCELLED" ? "neutral" : "info"
                }
              >
                {statusLabel[o.status] ?? o.status}
              </Badge>,
              mayManage && (o.status === "CONFIRMED" || o.status === "IN_PRODUCTION") ? (
                <div key="a" className="flex flex-wrap items-start gap-1.5">
                  <CompleteForm ar={ar} cmtOrderId={o.id} quotedMinutes={o.totalMinutes} />
                  <CancelForm ar={ar} cmtOrderId={o.id} />
                </div>
              ) : (
                <span key="a" className="num text-xs text-ink-400" dir="ltr">
                  {day(o.completedAt)}
                </span>
              ),
            ])}
          />
        </Card>
      )}
    </>
  );
}
