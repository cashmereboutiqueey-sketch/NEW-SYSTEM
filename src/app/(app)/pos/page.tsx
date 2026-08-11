import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { can } from "@/core/permissions";
import { PageHeader, Card, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber } from "@/lib/money";
import { sellableStock, openTillFor, tillTotals } from "@/lib/pos";
import { sellableConsignedStock } from "@/lib/consignment";
import { PosTerminal } from "./pos-terminal";
import { OpenTillForm, CloseTillForm } from "./till-forms";

/**
 * نقطة البيع — the till.
 *
 * A cashier's screen, not a report: search or scan, tap to add, take payment.
 * Only stock actually on the shelf at this location is offered, so the
 * cashier cannot promise a customer something the shop does not have.
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

  // Whichever till is already open wins, so a cashier returning to the screen
  // lands back in their own shift rather than being asked to open a new one.
  let till = null;
  for (const l of locations) {
    const open = await openTillFor(l.id);
    if (open && (!params.location || open.locationId === params.location)) {
      till = open;
      break;
    }
  }

  // A retail channel if one is configured, otherwise whatever exists — the
  // till must not refuse to open because nobody has named a channel yet.
  const [retailChannel, anyChannel, customers] = await Promise.all([
    db.salesChannel.findFirst({ where: { kind: "RETAIL_STORE" } }),
    db.salesChannel.findFirstOrThrow(),
    db.customer.findMany({
      where: { mergedIntoId: null, isActive: true },
      select: { id: true, name: true, phone: true },
      orderBy: { name: "asc" },
      take: 200,
    }),
  ]);

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
        <Card title={ar ? "فتح وردية" : "Open a till"}>
          {maySell ? (
            <>
              <OpenTillForm
                locale={locale}
                locations={locations.map((l) => ({ id: l.id, label: name(l) }))}
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
          customers={customers}
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
