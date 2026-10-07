import { requirePermission } from "@/lib/auth";
import { getPrefs } from "@/lib/session";
import { can } from "@/core/permissions";
import { canViewInventoryValue } from "@/core/visibility";
import { db } from "@/lib/db";
import {
  consignedStock,
  consignorPositions,
  recentConsignmentSales,
  totalOwedToConsignors,
} from "@/lib/consignment";
import { PageHeader, Card, DataTable, StatTile, Badge } from "@/components/ui";
import { formatMoney, formatNumber, dec } from "@/lib/money";
import { ConsignorForm } from "./consignor-form";
import { ReceiveForm } from "./receive-form";
import { ItemActions } from "./item-actions";
import { SettleForm } from "./settle-form";
import { PhotoForm } from "@/components/photo-form";

/**
 * بضاعة الأمانة — selling somebody else's goods for a share.
 *
 * The figure to look at is not the takings, it is what is owed. Money from a
 * consigned sale sits in the drawer looking exactly like the shop's own, and
 * a shop that spends it has spent somebody else's money without noticing.
 *
 * These garments are deliberately absent from every stock screen: they are
 * not the shop's, and showing them as inventory would overstate what the
 * business owns.
 */
export default async function ConsignmentPage() {
  const session = await requirePermission("stock_value:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const mayHandle = can(session.role, "inventory:transfer");
  const maySell = can(session.role, "sales_order:create");
  const mayPay = can(session.role, "payment:create");
  const seeFinancials = canViewInventoryValue(session.role);

  const [rail, positions, sales, owed, locations, customers] = await Promise.all([
    consignedStock(),
    consignorPositions(),
    recentConsignmentSales(),
    totalOwedToConsignors(),
    db.location.findMany({
      where: { isActive: true, kind: { in: ["SHOWROOM", "STORE", "EXHIBITION"] } },
      orderBy: { sortOrder: "asc" },
    }),
    db.customer.findMany({
      where: { isActive: true, mergedIntoId: null },
      select: { id: true, name: true, phone: true },
      orderBy: { name: "asc" },
      take: 200,
    }),
  ]);

  const onRail = rail.reduce((s, i) => s + i.left, 0);
  const railValue = rail.reduce(
    (s, i) => s.plus(dec(i.retailPrice).times(i.left)),
    dec(0),
  );
  const earned = positions.reduce((s, p) => s.plus(dec(p.commissionEarned)), dec(0));
  const overdue = rail.filter((i) => i.overdue);

  return (
    <>
      <PageHeader
        title={ar ? "بضاعة الأمانة" : "Consignment"}
        subtitle={
          ar
            ? "بضاعة حد تاني بتتباع عندك، وانت بتاخد نسبة."
            : "Somebody else's goods, sold here for a share of the price."
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={ar ? "قطع على الرف" : "On the rail"}
          value={formatNumber(onRail)}
          hint={ar ? `بسعر بيع ${formatMoney(railValue.toString())}` : `worth ${formatMoney(railValue.toString())} at retail`}
        />
        <StatTile
          label={ar ? "عمولتك المكتسبة" : "Commission earned"}
          value={seeFinancials ? formatMoney(earned.toString()) : "—"}
          tone="good"
        />
        <StatTile
          label={ar ? "فلوس مش بتاعتك" : "Money you are holding"}
          value={seeFinancials ? formatMoney(owed.toString()) : "—"}
          hint={ar ? "لأصحاب البضاعة" : "owed to the owners"}
          tone={seeFinancials ? (owed.greaterThan(0) ? "bad" : "good") : "neutral"}
        />
        {seeFinancials && (
          <StatTile
            label={ar ? "عمولتك المكتسبة" : "Commission earned"}
            value={formatMoney(earned.toString())}
            tone="good"
          />
        )}
        {seeFinancials && (
          <StatTile
            label={ar ? "فلوس مش بتاعتك" : "Money you are holding"}
            value={formatMoney(owed.toString())}
            hint={ar ? "لأصحاب البضاعة" : "owed to the owners"}
            tone={owed.greaterThan(0) ? "bad" : "good"}
          />
        )}
        <StatTile
          label={ar ? "فات ميعاد رجوعها" : "Overdue back"}
          value={formatNumber(overdue.length)}
          tone={overdue.length > 0 ? "warn" : "good"}
        />
      </div>

      {mayHandle && (
        <div className="mb-5 grid gap-4 lg:grid-cols-2">
          <Card
            title={ar ? "صاحب بضاعة جديد" : "New consignor"}
            description={
              ar
                ? "النسبة بتتكتب كنسبة مئوية — ٢٥ يعني ٢٥٪."
                : "The rate is typed as a percentage: 25 means 25%."
            }
          >
            <ConsignorForm ar={ar} />
          </Card>

          <Card
            title={ar ? "استلام بضاعة" : "Take goods in"}
            description={
              ar
                ? "البضاعة دي مش بتدخل مخزونك — هي فاضلة ملك صاحبها لحد ما تتباع."
                : "These never enter your stock: they stay their owner's until sold."
            }
          >
            {positions.length === 0 ? (
              <p className="py-4 text-sm text-ink-500">
                {ar ? "ضيف صاحب بضاعة الأول." : "Add a consignor first."}
              </p>
            ) : (
              <ReceiveForm
                ar={ar}
                consignors={positions
                  .filter((p) => p.isActive)
                  .map((p) => ({ id: p.id, name: p.name, commissionPct: p.commissionPct }))}
                locations={locations.map((l) => ({
                  id: l.id,
                  name: ar ? l.nameAr : l.nameEn,
                }))}
              />
            )}
          </Card>
        </div>
      )}

      <div className="mb-5">
        <Card
          title={ar ? "اللي على الرف" : "On the rail"}
          description={
            ar
              ? "دي مش في المخزون بتاعك — لو ظهرت هناك يبقى النظام بيقول إنك بتملك حاجة مش بتاعتك."
              : "Deliberately absent from your stock screens: they are not yours to count."
          }
        >
          <DataTable
            headers={[
              ar ? "الكود" : "Code",
              ar ? "الصنف" : "Item",
              ar ? "صاحبها" : "Owner",
              ar ? "السعر" : "Price",
              ...(seeFinancials ? [ar ? "نسبتك" : "Your share"] : []),
              ar ? "فاضل" : "Left",
              ar ? "قاعدة" : "Held",
              "",
            ]}
            empty={ar ? "مفيش بضاعة أمانة دلوقتي" : "Nothing on consignment"}
            rows={rail
              .filter((i) => i.left > 0)
              .map((i) => [
                <span key="c" className="num text-xs" dir="ltr">{i.itemCode}</span>,
                <div key="d" className="min-w-48">
                  <div className="flex items-center gap-2">
                    {i.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={i.image} alt={i.description} className="h-14 w-11 shrink-0 rounded object-cover" />
                    ) : <div className="flex h-14 w-11 shrink-0 items-center justify-center rounded bg-ink-100 text-[10px] text-ink-400">{ar ? "صورة" : "Photo"}</div>}
                    <span>
                      {i.description}
                      {(i.size || i.colour) && (
                        <span className="ms-2 text-xs text-ink-500">
                          {[i.colour, i.size].filter(Boolean).join(" · ")}
                        </span>
                      )}
                    </span>
                  </div>
                  {mayHandle && (
                    <details className="mt-1 text-xs">
                      <summary className="cursor-pointer text-ink-600 underline">{ar ? "ارفع أو غيّر الصورة" : "Add or change photo"}</summary>
                      <div className="mt-2"><PhotoForm ar={ar} consignmentItemId={i.id} current={i.image} /></div>
                    </details>
                  )}
                </div>,
                i.consignorName,
                <span key="p" className="num">{formatMoney(i.retailPrice)}</span>,
                <span key="r" className="num text-xs">{seeFinancials ? `${i.commissionPct}%` : "—"}</span>,
                <span key="l" className="num font-medium">
                  {i.left}
                  <span className="ms-1 text-xs text-ink-400">/{i.received}</span>
                </span>,
                <span key="h" className="text-xs">
                  <span className="num">{i.daysHeld}</span>{" "}
                  <span className="text-ink-400">{ar ? "يوم" : "days"}</span>
                  {i.overdue && (
                    <Badge tone="warn">{ar ? "فات الميعاد" : "overdue"}</Badge>
                  )}
                </span>,
                <ItemActions
                  key="a"
                  ar={ar}
                  item={{
                    id: i.id,
                    description: i.description,
                    retailPrice: i.retailPrice,
                    left: i.left,
                    commissionPct: seeFinancials ? i.commissionPct : null,
                  }}
                  customers={customers}
                  maySell={maySell}
                  mayGiveCredit={can(session.role, "sales_order:credit")}
                  mayReturn={mayHandle}
                  seeValue={seeFinancials}
                />,
              ])}
          />
        </Card>
      </div>

      <div className="mb-5">
        <Card
          title={ar ? "أصحاب البضاعة" : "Consignors"}
          description={
            ar
              ? "«مستحق ليه» بيتحسب من وقت البيع، حتى لو العميل لسه عليه باقي."
              : "The owner's share is owed from the sale, even if the customer still has a balance."
          }
        >
          <DataTable
            headers={[
              ar ? "الاسم" : "Name",
              ...(seeFinancials ? [ar ? "نسبتك" : "Your share"] : []),
              ar ? "على الرف" : "On rail",
              ar ? "بيعات" : "Sales",
              ...(seeFinancials
                ? [
                    ar ? "إجمالي البيع" : "Sold for",
                    ar ? "عمولتك" : "You earned",
                    ar ? "مستحق ليه" : "Owed to them",
                  ]
                : []),
              ar ? "تساكي" : "Labels",
              "",
            ]}
            empty={ar ? "مفيش أصحاب بضاعة" : "No consignors"}
            rows={positions.map((p) => [
              <span key="n" className="font-medium text-ink-900">{p.name}</span>,
              <span key="r" className="num text-xs">{seeFinancials ? `${p.commissionPct}%` : "—"}</span>,
              <span key="i" className="num">{formatNumber(p.itemsOnRail)}</span>,
              <span key="s" className="num">{formatNumber(p.salesCount)}</span>,
              <span key="t" className="num">{formatMoney(p.takings)}</span>,
              <span key="c" className="num text-good">{seeFinancials ? formatMoney(p.commissionEarned) : "—"}</span>,
              seeFinancials && dec(p.owed).greaterThan(0) ? (
                <span key="o" className="num font-semibold text-bad">{formatMoney(p.owed)}</span>
              ) : (
                <span key="o" className="text-ink-300">—</span>
              ),
              p.itemsOnRail > 0 ? (
                // Only while something of theirs is still on the rail: a tag
                // printed for a piece already sold is a live code on a garment
                // that has left the shop.
                <a
                  key="l"
                  href={`/print/labels/consignment/${p.id}`}
                  target="_blank"
                  rel="noopener"
                  className="rounded-lg border border-ink-200 px-2 py-1 text-xs text-ink-700"
                >
                  {ar ? "اطبع" : "Print"}
                </a>
              ) : (
                <span key="l" className="text-ink-300">—</span>
              ),
              mayPay && dec(p.owed).greaterThan(0) ? (
                <SettleForm
                  key="b"
                  ar={ar}
                  consignorId={p.id}
                  name={p.name}
                  owed={p.owed}
                />
              ) : (
                <span key="b" />
              ),
            ])}
          />
        </Card>
      </div>

      <Card title={ar ? "بيعات الأمانة" : "Consignment sales"}>
        <DataTable
          headers={[
            ar ? "البيعة" : "Sale",
            ar ? "الصنف" : "Item",
            ar ? "العميل" : "Customer",
            ar ? "صاحبها" : "Owner",
            ar ? "اتباعت بـ" : "Sold for",
            ar ? "المدفوع" : "Paid",
            ar ? "على العميل" : "Customer owes",
            ...(seeFinancials
              ? [ar ? "عمولتك" : "Your share", ar ? "لصاحبها" : "Their share"]
              : []),
            ar ? "اتدفعت؟" : "Paid over?",
          ]}
          empty={ar ? "لسه مفيش بيعات" : "No sales yet"}
          rows={sales.map((s) => [
            <span key="n" className="num text-xs" dir="ltr">{s.saleNumber}</span>,
            <span key="i" className="text-xs">{s.description} ×{s.quantity}</span>,
            <span key="customer" className="text-xs">{s.customerName ?? "—"}</span>,
            s.consignorName,
            <span key="t" className="num">{formatMoney(s.total)}</span>,
            <span key="paid" className="num">{formatMoney(s.paid)}</span>,
            <span key="due" className="num text-warn">{dec(s.stillOwed).greaterThan(0) ? formatMoney(s.stillOwed) : "—"}</span>,
            <span key="c" className="num text-good">{seeFinancials ? formatMoney(s.commission) : "—"}</span>,
            <span key="o" className="num">{seeFinancials ? formatMoney(s.owedToOwner) : "—"}</span>,
            s.settled ? (
              <Badge key="p" tone="good">{s.settlementNumber}</Badge>
            ) : (
              <Badge key="p" tone="warn">{ar ? "لسه" : "not yet"}</Badge>
            ),
          ])}
        />
      </Card>

      <p className="mt-4 text-xs text-ink-500">
        {ar
          ? "الإيراد بتاعك هو العمولة بس. لو بعت فستان بـ ٢٠٠٠ ونسبتك ٢٥٪، مبيعاتك زادت ٥٠٠ مش ٢٠٠٠ — والـ ١٥٠٠ دين عليك من لحظة البيع مش فلوسك."
          : "Only the commission is your revenue. A 2,000 dress on 25% adds 500 to your sales, not 2,000, and the other 1,500 is a debt from the moment it leaves."}
      </p>
    </>
  );
}
