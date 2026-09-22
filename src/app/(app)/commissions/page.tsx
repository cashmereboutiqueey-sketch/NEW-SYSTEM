import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { can } from "@/core/permissions";
import {
  moderatorPositions,
  unsettledLines,
  recentSettlements,
  totalOwedToModerators,
} from "@/lib/moderator-commission";
import { PageHeader, Card, DataTable, StatTile, Badge } from "@/components/ui";
import { dec, formatMoney, formatNumber } from "@/lib/money";
import { RateForm, SettleForm, EndRateForm } from "./forms";

/**
 * What the shop owes the people who brought the orders in.
 *
 * Earned when the customer's money is actually in, never when the order is
 * taken: a parcel that comes back is not a sale, and paying on orders placed
 * means paying for sales that never happened. Between earning and paying, it
 * is a debt with a name on it and it sits on the liabilities side, exactly
 * like what is owed to a consignor.
 *
 * Behind `journal:view`, so it opens for the owner and the accountant and for
 * nobody who is paid out of it. Setting a rate and paying it over need
 * `payment:create` on top, because deciding what somebody earns is not
 * something the person earning it should be able to do.
 */
export default async function CommissionsPage() {
  const session = await requirePermission("journal:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const mayPay = can(session.role, "payment:create");

  const [positions, lines, settlements, owed, users] = await Promise.all([
    moderatorPositions(),
    unsettledLines(null, 120),
    recentSettlements(20),
    totalOwedToModerators(),
    db.user.findMany({
      where: { isActive: true },
      select: { id: true, name: true, role: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const onRate = positions.filter((p) => p.perPieceAmount !== null);
  const earnedTotal = positions.reduce((s, p) => s.plus(p.earned), dec(0));
  const clawedTotal = positions.reduce((s, p) => s.plus(p.clawedBack), dec(0));

  const dateText = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : "—");

  /** A rate reads as what was agreed, not as two columns of zeroes. */
  const rateText = (p: { perPieceAmount: string | null; percentOfNet: string | null }) => {
    if (p.perPieceAmount === null) return ar ? "مش على عمولة" : "not on commission";
    const piece = dec(p.perPieceAmount);
    const pct = dec(p.percentOfNet ?? 0).times(100);
    const parts: string[] = [];
    if (piece.greaterThan(0)) parts.push(ar ? `${piece.toFixed(2)} للقطعة` : `${piece.toFixed(2)} a piece`);
    if (pct.greaterThan(0)) parts.push(ar ? `${pct.toFixed(2)}% من الصافي` : `${pct.toFixed(2)}% of net`);
    return parts.join(ar ? " + " : " + ") || (ar ? "صفر" : "nothing");
  };

  return (
    <>
      <PageHeader
        title={ar ? "عمولات المودريتورز" : "Moderator commission"}
        subtitle={
          ar
            ? "بيتكسب لما فلوس العميل تتحصّل فعلًا — مش لما الأوردر يتكتب. والمرتجع بيرجّع عمولته."
            : "Earned when the customer's money is actually in, not when the order is taken. A return takes its share back."
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={ar ? "مستحق ولسه ماتدفعش" : "Owed and unpaid"}
          value={formatMoney(owed.toString(), locale)}
          hint={ar ? "دين على المحل باسم صاحبه" : "a debt with a name on it"}
          tone={owed.greaterThan(0) ? "warn" : "good"}
        />
        <StatTile
          label={ar ? "اتكسب" : "Earned"}
          value={formatMoney(earnedTotal.toString(), locale)}
          hint={ar ? "من أوردرات اتحصّلت" : "on orders collected"}
        />
        <StatTile
          label={ar ? "رجع بالمرتجع" : "Taken back"}
          value={formatMoney(clawedTotal.toString(), locale)}
          tone={clawedTotal.greaterThan(0) ? "bad" : "neutral"}
        />
        <StatTile
          label={ar ? "على عمولة" : "On commission"}
          value={formatNumber(onRate.length, locale)}
          hint={`${ar ? "من" : "of"} ${users.length}`}
        />
      </div>

      {mayPay && (
        <Card
          className="mb-5"
          title={ar ? "ثبّت رات لحد" : "Put somebody on a rate"}
          description={
            ar
              ? "الرات القديم بيتقفل اليوم اللي قبل الجديد — الشهر اللي فات بيفضل زي ما هو بالظبط."
              : "The previous rate closes the day before this one starts, so last month stays exactly what last month was."
          }
        >
          <RateForm ar={ar} users={users} />
        </Card>
      )}

      <Card
        className="mb-5"
        title={ar ? "مين على إيه، ومستحقه كام" : "Who is on what, and owed how much"}
      >
        <DataTable
          headers={[
            ar ? "الاسم" : "Name",
            ar ? "الرات" : "Rate",
            ar ? "من" : "Since",
            ar ? "أوردرات" : "Orders",
            ar ? "قطع" : "Pieces",
            ar ? "اتكسب" : "Earned",
            ar ? "رجع" : "Taken back",
            ar ? "المستحق" : "Owed",
            "",
          ]}
          empty={ar ? "محدش على عمولة لسه" : "Nobody is on commission yet"}
          rows={positions.map((p) => [
            <span key="n" className="font-medium text-ink-900">{p.name}</span>,
            <span key="r" className="text-xs">
              {rateText(p)}
              {p.perPieceAmount === null && (
                <Badge tone="neutral">{ar ? "موقوف" : "ended"}</Badge>
              )}
            </span>,
            <span key="s" className="num text-xs" dir="ltr">{dateText(p.since)}</span>,
            <span key="o" className="num">{formatNumber(p.orders, locale)}</span>,
            <span key="q" className="num">{formatNumber(p.pieces, locale)}</span>,
            <span key="e" className="num">{formatMoney(p.earned.toString(), locale)}</span>,
            p.clawedBack.greaterThan(0) ? (
              <span key="c" className="num text-bad">{formatMoney(p.clawedBack.toString(), locale)}</span>
            ) : (
              <span key="c" className="text-ink-300">—</span>
            ),
            <span key="w" className="num font-semibold">{formatMoney(p.owed.toString(), locale)}</span>,
            <span key="a" className="flex items-center gap-2">
              {mayPay && p.owed.greaterThan(0) && (
                <SettleForm ar={ar} userId={p.userId} name={p.name} owed={p.owed.toString()} />
              )}
              {mayPay && p.perPieceAmount !== null && <EndRateForm ar={ar} userId={p.userId} />}
            </span>,
          ])}
        />
      </Card>

      <Card
        className="mb-5"
        title={ar ? "السطور اللي لسه ماتدفعتش" : "Lines not yet paid"}
        description={
          ar
            ? "كل سطر أوردر اتحصّل — أو مرتجع رجّع جزء منه."
            : "One line per order collected, or per return that took part of it back."
        }
      >
        <DataTable
          headers={[
            ar ? "اليوم" : "Day",
            ar ? "مين" : "Who",
            ar ? "الأوردر" : "Order",
            ar ? "قطع" : "Pieces",
            ar ? "صافي الأوردر" : "Order net",
            ar ? "الرات" : "Rate",
            ar ? "العمولة" : "Commission",
          ]}
          empty={ar ? "مفيش حاجة مستحقة" : "Nothing outstanding"}
          rows={lines.map((l) => [
            <span key="d" className="num text-xs" dir="ltr">{dateText(l.earnedOn)}</span>,
            <span key="u" className="text-xs">{l.user}</span>,
            <span key="o" className="num text-xs" dir="ltr">
              {l.orderNumber}
              <span className="ms-2 text-[10px] text-ink-400">{l.source}</span>
            </span>,
            <span key="p" className={`num ${l.pieces < 0 ? "text-bad" : ""}`}>{l.pieces}</span>,
            <span key="n" className="num text-xs">{formatMoney(l.netAmount, locale)}</span>,
            <span key="r" className="text-[11px] text-ink-500">
              {rateText({ perPieceAmount: l.perPieceAmount, percentOfNet: l.percentOfNet })}
            </span>,
            <span key="a" className={`num font-medium ${l.kind === "REVERSED" ? "text-bad" : ""}`}>
              {formatMoney(l.amount, locale)}
            </span>,
          ])}
        />
      </Card>

      <Card title={ar ? "اللي اتدفع" : "Already paid over"}>
        <DataTable
          headers={[
            ar ? "رقم" : "No.",
            ar ? "مين" : "Who",
            ar ? "اليوم" : "Day",
            ar ? "إزاي" : "How",
            ar ? "سطور" : "Lines",
            ar ? "المبلغ" : "Amount",
          ]}
          empty={ar ? "لسه مفيش" : "Nothing yet"}
          rows={settlements.map((s) => [
            <span key="n" className="num text-xs" dir="ltr">{s.number}</span>,
            s.user,
            <span key="d" className="num text-xs" dir="ltr">{dateText(s.paidOn)}</span>,
            <span key="m" className="text-xs text-ink-500">{s.method}</span>,
            <span key="l" className="num">{s.lines}</span>,
            <span key="a" className="num">{formatMoney(s.amount, locale)}</span>,
          ])}
        />
      </Card>
    </>
  );
}
