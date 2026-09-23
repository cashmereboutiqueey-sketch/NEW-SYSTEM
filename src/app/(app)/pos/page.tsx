import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { can } from "@/core/permissions";
import { PageHeader, Card, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber } from "@/lib/money";
import { sellableStock, openTillFor, tillTotals } from "@/lib/pos";
import { shiftFor, locationsFree } from "@/core/till";
import { sellableConsignedStock } from "@/lib/consignment";
import { PosTerminal } from "./pos-terminal";
import { OpenTillForm, CloseTillForm } from "./till-forms";

/**
 * نقطة البيع — the till.
 *
 * A cashier's screen, not a report: search or scan, tap to add, take payment.
 * Only stock actually on the shelf at this location is offered, so the
 * cashier cannot promise a customer something the shop does not have.
 *
 * The shift totals across the top are the day’s takings, which is a ledger
 * figure, so they follow `journal:view` the way the owner dashboard does. The
 * person standing at the till rings up sales; how the day is going is not
 * their number, and a running total on a screen facing a shop is the one
 * figure in the building that anybody can read from the other side of a
 * counter.
 */
export default async function PosPage({
  searchParams,
}: {
  searchParams: Promise<{ location?: string }>;
}) {
  // Two different people need this screen for two different reasons: the
  // cashier to sell, the accountant to count the drawer at the end of the
  // shift. Guarding on `pos:operate` alone locked the accountant out of the
  // only screen where a till can be closed, which is where the shop actually
  // stops for the night.
  const session = await requireUser();
  const maySell = can(session.role, "pos:operate");
  const mayClose = can(session.role, "pos:close_shift");
  const seeTakings = can(session.role, "journal:view");
  if (!maySell && !mayClose) redirect("/");
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const params = await searchParams;

  const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });

  const locations = await db.location.findMany({
    where: { isActive: true, kind: { in: ["SHOWROOM", "STORE", "EXHIBITION"] } },
    orderBy: { sortOrder: "asc" },
  });

  const name = (e: { nameAr: string; nameEn: string }) => (ar ? e.nameAr : e.nameEn);

  /*
   * Which till this person is standing at.
   *
   * Their own first, wherever it is, so a cashier returning to the screen
   * lands back in their own shift. Only then somebody else's, and only to be
   * told about it: the screen used to hand a cashier the first open till it
   * found anywhere — including one at another branch, opened by somebody else
   * — let her fill a basket on it, and refuse at the moment she pressed sell
   * with the customer standing there.
   */
  const open = (
    await Promise.all(
      locations
        .filter((l) => !params.location || l.id === params.location)
        .map((l) => openTillFor(l.id)),
    )
  ).filter((t) => t !== null);

  const { use: till, blockedBy: elsewhere } = shiftFor(open, session.userId, mayClose);
  const free = locationsFree(locations, open);

  // A retail channel if one is configured, otherwise whatever exists — the
  // till must not refuse to open because nobody has named a channel yet.
  const [retailChannel, anyChannel, customers] = await Promise.all([
    db.salesChannel.findFirst({ where: { kind: "RETAIL_STORE" } }),
    db.salesChannel.findFirstOrThrow(),
    db.customer.findMany({
      where: { mergedIntoId: null, isActive: true },
      // The limit comes with them: the till refuses a part payment that would
      // pass it, and finding that out after pressing sell, with the customer
      // at the counter, is finding out too late.
      select: { id: true, name: true, phone: true, creditLimit: true },
      orderBy: { name: "asc" },
      take: 200,
    }),
  ]);

  // What each of them owes already: every uncancelled order with what has
  // been paid against it, reduced by customer. The same arithmetic the credit
  // check runs, so the till cannot promise what the ledger will refuse.
  const openOrders = await db.salesOrder.findMany({
    where: { customerId: { in: customers.map((c) => c.id) }, status: { not: "CANCELLED" } },
    select: {
      customerId: true,
      netAmount: true,
      shippingAmount: true,
      payments: { select: { amount: true } },
    },
  });
  const owedByCustomer = new Map<string, number>();
  for (const order of openOrders) {
    if (!order.customerId) continue;
    const billed = Number(order.netAmount) + Number(order.shippingAmount ?? 0);
    const paid = order.payments.reduce((sum, p) => sum + Number(p.amount), 0);
    owedByCustomer.set(
      order.customerId,
      (owedByCustomer.get(order.customerId) ?? 0) + Math.max(0, billed - paid),
    );
  }

  if (!till) {
    return (
      <>
        <PageHeader
          title={ar ? "نقطة البيع" : "Point of sale"}
          subtitle={
            ar
              ? "افتح الوردية بعدّ النقدية اللي في الدرج قبل أول بيعة"
              : "Open the shift by counting what is in the drawer before the first sale"
          }
        />

        {/* Said before a basket is built, not after it. The drawer belongs to
            one shift and one person; whoever is not that person has to be told
            so, and told what actually unblocks it. */}
        {elsewhere && (
          <Card
            className="mb-4"
            title={ar ? "الدرج مفتوح باسم حد تاني" : "The drawer is open in somebody else's name"}
          >
            <p className="text-sm text-ink-700">
              {ar
                ? `وردية ${elsewhere.sessionNumber} مفتوحة في ${name(elsewhere.location)} باسم ${elsewhere.cashier.name}، من ${elsewhere.openedAt.toISOString().slice(0, 16).replace("T", " ")}.`
                : `Till ${elsewhere.sessionNumber} is open at ${name(elsewhere.location)} in ${elsewhere.cashier.name}'s name, since ${elsewhere.openedAt.toISOString().slice(0, 16).replace("T", " ")}.`}
            </p>
            <p className="mt-2 text-sm text-ink-600">
              {ar
                ? "درج واحد لوردية واحدة، عشان الفرق في العدّ يبقى على اسم واحد. علشان تبيع، لازم حد معاه صلاحية قفل الوردية يعدّ الدرج ويقفلها — بعدها تفتح وردية باسمك."
                : "One drawer, one shift, so a difference in the count has one name on it. Before you can sell, somebody who may close a till has to count the drawer and close it — then you open one in your own name."}
            </p>
            {free.length > 0 && maySell && (
              <p className="mt-2 text-sm text-good">
                {ar
                  ? `ولو هتبيع من مكان تاني، ${free.map(name).join(" أو ")} فاضي ومتاح تفتح فيه دلوقتي.`
                  : `If you are selling somewhere else, ${free.map(name).join(" or ")} has no till open and you can start one now.`}
              </p>
            )}
          </Card>
        )}

        {(free.length > 0 || !elsewhere) && (
        <Card title={ar ? "فتح وردية" : "Open a till"}>
          {maySell ? (
            <>
              <OpenTillForm
                locale={locale}
                locations={free.map((l) => ({ id: l.id, label: name(l) }))}
              />
              <p className="mt-3 text-xs text-ink-500">
                {ar
                  ? "الرصيد الافتتاحي بيتقارن بالنقدية المعدودة عند القفل، والفرق بيتسجّل باسم الكاشير."
                  : "The opening float is compared with the cash counted at close, and any difference is recorded against the cashier."}
              </p>
            </>
          ) : (
            // Whoever counts the drawer does not open it. There is simply
            // nothing here for them until a cashier has been selling.
            <p className="py-4 text-sm text-ink-500">
              {ar
                ? "مفيش وردية مفتوحة دلوقتي. الوردية بيفتحها البياع، وانت بتقفلها آخر اليوم."
                : "No till is open. A cashier opens the shift; you close it at the end of the day."}
            </p>
          )}
        </Card>
        )}
      </>
    );
  }

  const products = await sellableStock(till.locationId, brand.id);
  // Goods held for other people, on the same rail and in the same grid.
  const consigned = await sellableConsignedStock(till.locationId);
  const totals = tillTotals(till);

  // An empty shelf has two very different causes, and the cashier cannot tell
  // them apart: nothing was ever made, or it was made and is still the
  // factory's. Say which, because the second one is fixable in a minute.
  const stuckAtFactory =
    products.length === 0
      ? await db.inventoryLot.aggregate({
          where: {
            state: "FINISHED_GOODS",
            remainingQty: { gt: 0 },
            variantId: { not: null },
            entity: { kind: "FACTORY" },
          },
          _sum: { remainingQty: true },
        })
      : null;
  const waiting = Number(stuckAtFactory?._sum.remainingQty ?? 0);

  return (
    <>
      <PageHeader
        title={ar ? "نقطة البيع" : "Point of sale"}
        subtitle={`${name(till.location)} · ${till.cashier.name}`}
        actions={
          <Badge tone="good">
            {ar ? "وردية مفتوحة" : "Till open"} · {till.sessionNumber}
          </Badge>
        }
      />

      {seeTakings ? (
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label={ar ? "مبيعات الوردية" : "Shift sales"}
            value={formatMoney(totals.revenue, locale)}
            hint={`${totals.orders} ${ar ? "طلب" : "orders"} · ${formatNumber(totals.units, locale)} ${ar ? "قطعة" : "units"}`}
          />
          <StatTile
            label={ar ? "كاش" : "Cash taken"}
            value={formatMoney(totals.cash, locale)}
          />
          <StatTile
            label={ar ? "بطاقات ومحافظ" : "Card and wallet"}
            value={formatMoney(totals.card, locale)}
          />
          <StatTile
            label={ar ? "المتوقع في الدرج" : "Expected in drawer"}
            value={formatMoney(totals.expectedDrawer, locale)}
            hint={`${ar ? "افتتاحي" : "float"} ${formatMoney(till.openingFloat, locale)}`}
          />
        </div>
      ) : (
        /* Not blanked into four empty boxes: how many sales have gone through
           is worth knowing at the till, and none of it is money. */
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <StatTile
            label={ar ? "طلبات الوردية" : "Orders this shift"}
            value={formatNumber(totals.orders, locale)}
            hint={`${formatNumber(totals.units, locale)} ${ar ? "قطعة" : "units"}`}
          />
          <StatTile
            label={ar ? "الوردية" : "Shift"}
            value={till.sessionNumber}
            hint={name(till.location)}
          />
        </div>
      )}

      {waiting > 0 && (
        <Card className="mb-4" title={ar ? "المعرض فاضي" : "Nothing on the shelf"}>
          <p className="text-sm text-ink-600">
            {ar ? (
              <>
                فيه <span className="num">{waiting}</span> قطعة تامّة في المصنع، بس لسه ملك
                المصنع مش البراند، عشان كده مش ظاهرة هنا. حوّلها الأول من{" "}
                <a href="/transfers" className="underline decoration-ink-300 underline-offset-2">
                  التحويل للبراند
                </a>
                .
              </>
            ) : (
              <>
                <span className="num">{waiting}</span> finished garments are sitting at the
                factory. They are still the Factory&apos;s, not the Brand&apos;s, which is why
                they are not here. Invoice them across from{" "}
                <a href="/transfers" className="underline decoration-ink-300 underline-offset-2">
                  Transfer to Brand
                </a>
                .
              </>
            )}
          </p>
        </Card>
      )}

      {maySell && (
      <div className="mb-4">
        <PosTerminal
          locale={locale}
          products={products}
          posSessionId={till.id}
          locationId={till.locationId}
          entityId={brand.id}
          channelId={(retailChannel ?? anyChannel).id}
          canDiscount={can(session.role, "sales_order:discount")}
          mayGiveCredit={can(session.role, "sales_order:credit")}
          isExhibition={till.location.kind === "EXHIBITION"}
          consigned={consigned}
          customers={customers.map((c) => ({
            id: c.id,
            name: c.name,
            phone: c.phone,
            creditLimit: Number(c.creditLimit),
            alreadyOwed: owedByCustomer.get(c.id) ?? 0,
          }))}
        />
      </div>
      )}

      {mayClose && (
        <Card title={ar ? "قفل الوردية" : "Close the till"}>
          <CloseTillForm
            locale={locale}
            posSessionId={till.id}
            expected={formatMoney(totals.expectedDrawer, locale)}
          />
        </Card>
      )}
    </>
  );
}
