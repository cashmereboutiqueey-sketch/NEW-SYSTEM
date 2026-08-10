import { notFound } from "next/navigation";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getPrefs } from "@/lib/session";
import { can } from "@/core/permissions";
import { db } from "@/lib/db";
import {
  exhibitionPosition,
  sendableStock,
  ExhibitionError,
} from "@/lib/exhibitions";
import { approvalThreshold } from "@/lib/stocktake";
import { PageHeader, Card, DataTable, StatTile, Badge } from "@/components/ui";
import { formatMoney, formatNumber, dec } from "@/lib/money";
import { SendForm } from "./send-form";
import { CloseForm } from "./close-form";

/**
 * One bazaar, from both ends.
 *
 * The top half is what went out and what is still standing there. The bottom
 * half is the count that closes it. They are on the same screen deliberately:
 * the person reconciling should be able to see what the books expect while
 * they type what they actually found, and then watch the gap appear.
 */
export default async function ExhibitionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requirePermission("inventory:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const mayRun = can(session.role, "inventory:transfer");

  let position;
  try {
    position = await exhibitionPosition(id);
  } catch (error) {
    if (error instanceof ExhibitionError) notFound();
    throw error;
  }

  const { exhibition, lines, totals } = position;

  const [sendable, approvers, threshold] = await Promise.all([
    exhibition.isActive && exhibition.parentId
      ? sendableStock(exhibition.parentId)
      : Promise.resolve([]),
    db.user.findMany({
      where: { isActive: true, id: { not: session.userId } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    approvalThreshold(),
  ]);

  const sold = dec(totals.sold);
  const sent = dec(totals.sent);
  const expected = dec(totals.expected);
  const sellThrough = sent.greaterThan(0)
    ? sold.dividedBy(sent).times(100)
    : dec(0);

  const dateText = (d: Date | null) =>
    d ? new Date(d).toISOString().slice(0, 10) : "—";

  return (
    <>
      <PageHeader
        title={ar ? exhibition.nameAr : exhibition.nameEn}
        subtitle={
          ar
            ? `${exhibition.code} · من ${exhibition.parentName ?? "—"} · ${dateText(exhibition.opensAt)} إلى ${dateText(exhibition.closesAt)}`
            : `${exhibition.code} · from ${exhibition.parentName ?? "—"} · ${dateText(exhibition.opensAt)} to ${dateText(exhibition.closesAt)}`
        }
        actions={
          <div className="flex items-center gap-2">
            {exhibition.isActive ? (
              <Badge tone="info">{ar ? "شغال" : "running"}</Badge>
            ) : (
              <Badge tone="neutral">{ar ? "اتقفل" : "closed"}</Badge>
            )}
            <Link href="/exhibitions" className="text-sm text-ink-500 underline">
              {ar ? "كل البازارات" : "All bazaars"}
            </Link>
          </div>
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label={ar ? "راح" : "Sent"} value={formatNumber(sent.toNumber())} />
        <StatTile
          label={ar ? "اتباع" : "Sold"}
          value={formatNumber(sold.toNumber())}
          hint={`${sellThrough.toFixed(0)}%`}
          tone="good"
        />
        <StatTile
          label={ar ? "المفروض موجود" : "Should be there"}
          value={formatNumber(expected.toNumber())}
          hint={ar ? "على الاستاند دلوقتي" : "on the stand now"}
          tone={expected.greaterThan(0) ? "warn" : "neutral"}
        />
        <StatTile
          label={ar ? "المبيعات" : "Takings"}
          value={formatMoney(totals.revenue)}
          tone="good"
        />
      </div>

      <div className="mb-5">
        <Card
          title={ar ? "الموقف" : "Position"}
          description={
            ar
              ? "راح كام، اتباع كام، والمفروض فاضل كام."
              : "What went out, what sold, what should still be standing."
          }
        >
          <DataTable
            headers={[
              "SKU",
              ar ? "الموديل" : "Style",
              ar ? "المقاس" : "Size",
              ar ? "اللون" : "Colour",
              ar ? "راح" : "Sent",
              ar ? "اتباع" : "Sold",
              ar ? "المفروض" : "Expected",
              ar ? "قيمة الاستاند" : "Cost on stand",
            ]}
            empty={ar ? "لسه مبعتش حاجة" : "Nothing has been sent yet"}
            rows={lines.map((l) => [
              <span key="s" dir="ltr" className="num text-xs">
                {l.sku}
              </span>,
              l.styleName,
              l.size,
              l.colour,
              <span key="a" className="num">{formatNumber(Number(l.sent))}</span>,
              <span key="b" className="num">{formatNumber(Number(l.sold))}</span>,
              <span key="c" className="num font-medium">
                {formatNumber(Number(l.expected))}
              </span>,
              <span key="d" className="num">
                {formatMoney(dec(l.expected).times(dec(l.unitCost)).toString())}
              </span>,
            ])}
          />
        </Card>
      </div>

      {exhibition.isActive && mayRun && (
        <div className="mb-5">
          <Card
            title={ar ? "ابعت بضاعة" : "Send stock"}
            description={
              ar
                ? `من ${exhibition.parentName ?? "—"}. القطع اللي مالهاش باركود مش هتظهر — مش هينفع تتباع ولا تتعد وهي راجعة.`
                : `From ${exhibition.parentName ?? "—"}. Untagged garments are not offered: they cannot be sold or counted back.`
            }
          >
            <SendForm
              exhibitionId={exhibition.id}
              rows={sendable.map((r) => ({
                variantId: r.variantId,
                sku: r.sku,
                styleName: r.styleName,
                size: r.size,
                colour: r.colour,
                available: r.available,
                untagged: r.untagged,
              }))}
              ar={ar}
            />
          </Card>
        </div>
      )}

      {exhibition.isActive && mayRun && (
        <Card
          title={ar ? "اقفل البازار" : "Close the bazaar"}
          description={
            ar
              ? "عدّ اللي قدامك واكتبه. اللي ناقص بيتقيد خسارة، واللي فاضي معناه مفيش حاجة رجعت."
              : "Count what is in front of you and write it down. Whatever is missing is written off."
          }
        >
          <CloseForm
            exhibitionId={exhibition.id}
            rows={lines
              .filter((l) => Number(l.expected) > 0)
              .map((l) => ({
                variantId: l.variantId,
                sku: l.sku,
                styleName: l.styleName,
                size: l.size,
                colour: l.colour,
                expected: l.expected,
                unitCost: l.unitCost,
              }))}
            approvers={approvers.map((a) => ({ id: a.id, name: a.name }))}
            threshold={threshold.toString()}
            ar={ar}
          />
        </Card>
      )}

      {!exhibition.isActive && (
        <Card title={ar ? "خلاص اتقفل" : "Closed"}>
          <p className="text-sm text-ink-500">
            {ar
              ? `البازار ده اتقفل واتسوّى يوم ${dateText(exhibition.closesAt)}. اللي رجع راح لـ ${exhibition.parentName ?? "—"}، واللي مارجعش اتقيد خسارة.`
              : `Closed and reconciled on ${dateText(exhibition.closesAt)}. What came back went to ${exhibition.parentName ?? "—"}; what did not was written off.`}
          </p>
        </Card>
      )}
    </>
  );
}
